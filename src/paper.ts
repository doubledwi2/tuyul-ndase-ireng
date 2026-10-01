import { performance } from 'node:perf_hooks';
import { loadExecutionBoundary } from './execution/startup.js';
import { createPrivateReadClients } from './private-read/startup.js';
import { PrivateAccountCollector } from './private-read/collector.js';
import { compareInventory, reconcileAccount } from './private-read/inventory.js';

import { MarketPipeline } from './app/pipeline.js';
import { DATA_DIR, HEALTH_HOST, HEALTH_PORT, LOG_FORMAT, operationalConfigSnapshot } from './config/runtime.js';
import { acquireRuntimeLock } from './persistence/runtime-lock.js';
import { ResourceMonitor, freeDiskBytes, persistenceReady } from './operations/resources.js';
import { CLOCK_JUMP_THRESHOLD_MS } from './config/timing.js';
import { connectBybit } from './exchanges/bybit.js';
import { connectOkx } from './exchanges/okx.js';
import { startHealthServer } from './operations/health-server.js';
import { Logger } from './operations/logger.js';
import { OperationalStateManager } from './operations/operational-state.js';
import {
  DurablePaperStateStore,
  type PersistenceHealth,
} from './persistence/durable-paper-state.js';
import {
  printLatencyPaperTrade,
  printPaperExecutionMetrics,
  printPaperRiskSummary,
  printPaperSummary,
} from './paper/console.js';
import {
  createLivePaperEventPath,
  PaperExecutionRecorder,
} from './paper/execution-recorder.js';
import { LatencyPaperCoordinator } from './paper/latency-coordinator.js';
import { LatencyPaperTradingEngine } from './paper/latency-engine.js';
import type { PaperExecutionEvent } from './paper/types.js';
import { ClockHealthMonitor } from './timing/clock-health.js';
import type { ExchangeConnection } from './types/market.js';
import {
  isValidNormalizedOrderBook,
  type NormalizedOrderBook,
} from './types/orderbook.js';
import {
  printDepthComparisonSummary,
  printMetricsSummary,
  printOpportunityEvent,
} from './ui/console.js';

const OUTPUT_INTERVAL_MS = 500;
const METRICS_INTERVAL_MS = 60_000;
let runtimeLock: Awaited<ReturnType<typeof acquireRuntimeLock>> | null = null;
let resources: ResourceMonitor | null = null;

async function main(): Promise<void> {
  const logger = new Logger('paper-runtime');
  const safety = await loadExecutionBoundary();
  const privateSetup = await createPrivateReadClients();
  const privateCollector = new PrivateAccountCollector(privateSetup.enabled, privateSetup.clients,
    (exchange, error, kind) => logger.warn('private_read_failed', 'Private account polling failed; paper remains independent.',
      { exchange, kind, status: error.status, category: error.category }), Date.now,
    (exchange, category) => logger.warn('private_account_review', 'Read-only diagnostic requires review; paper remains independent.', { exchange, category }));
  logger.info('execution_safety', `Execution mode: PAPER; Real execution: DISABLED; Kill switch: ${safety.executionKillSwitch ? 'ENABLED' : 'DISABLED'}; Private Bybit credentials configured: ${safety.bybitPrivateCredentialsConfigured ? 'yes' : 'no'}; Private OKX credentials configured: ${safety.okxPrivateCredentialsConfigured ? 'yes' : 'no'}.`, safety);
  logger.info('effective_config', 'Effective operational config (allowlisted).', { ...operationalConfigSnapshot(), ...safety, privateReadEnabled: privateSetup.enabled });
  runtimeLock = await acquireRuntimeLock(DATA_DIR);
  resources = new ResourceMonitor();
  let diskBytes: number | null = await freeDiskBytes(DATA_DIR);
  if (diskBytes === null) logger.warn('disk_unavailable', 'Filesystem free-space diagnostic unsupported.');
  const operational = new OperationalStateManager();
  operational.beginRecovery();

  const eventPath = createLivePaperEventPath(
    Date.now(),
    undefined,
    DATA_DIR,
  );
  const paperRecorder = new PaperExecutionRecorder(eventPath);
  let durableStore: DurablePaperStateStore | null = null;
  let paperEngine: LatencyPaperTradingEngine;
  let lastPersistenceError: string | null = null;
  let warnedDirectorySync = false;

  const updatePersistenceHealth = (health: PersistenceHealth): void => {
    operational.setPersistenceHealth({
      checkpointHealthy: health.checkpointHealthy && persistenceReady(health, diskBytes, Date.now()),
      journalHealthy: health.journalHealthy,
      lastCheckpointAt: health.lastCheckpointAt,
    });
    if (!health.directorySyncSupported && !warnedDirectorySync) {
      warnedDirectorySync = true;
      logger.warn('directory_sync_unsupported', 'Directory fsync unsupported on this platform.');
    }
    if ((!health.checkpointHealthy || !health.journalHealthy) && health.lastError !== lastPersistenceError) {
      lastPersistenceError = health.lastError;
      logger.error(
        'persistence_unhealthy',
        health.lastError ?? 'Durable persistence is unhealthy.',
      );
    }
    if (health.checkpointHealthy && health.journalHealthy) lastPersistenceError = null;
  };

  const onExecutionEvent = (event: PaperExecutionEvent): void => {
    operational.heartbeat.lastExecutionEventAt = Date.now();
    void paperRecorder.record(event);
    void durableStore?.record(event);
    if (LOG_FORMAT !== 'json' && event.type === 'TRADE' && event.trade.closedAt !== null) {
      printLatencyPaperTrade(event.trade);
    }
  };

  try {
    const opened = await DurablePaperStateStore.open({
      dataDir: DATA_DIR,
      onHealthChange: updatePersistenceHealth,
    });
    durableStore = opened.store;
    paperEngine =
      opened.recoveredState === null
        ? new LatencyPaperTradingEngine({ onExecutionEvent })
        : LatencyPaperTradingEngine.fromState(opened.recoveredState, {
            onExecutionEvent,
          });
    durableStore.attachStateProvider(() => paperEngine.exportState());
    if (opened.recoveredState !== null) {
      paperEngine.applyRecoveryPolicy(Date.now());
      logger.info('recovery_complete', 'Durable paper state restored.', {
        replayedJournalRecords: opened.replayedJournalRecords,
      });
    } else {
      logger.info('recovery_empty', 'No prior durable paper state found.');
    }
    await durableStore.flushAndCheckpoint();
    updatePersistenceHealth(durableStore.getHealth());
    operational.completeRecovery();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('recovery_failed', message);
    operational.setPersistenceHealth({
      checkpointHealthy: false,
      journalHealthy: false,
      lastCheckpointAt: null,
    });
    operational.failRecovery();
    durableStore = null;
    paperEngine = new LatencyPaperTradingEngine({ onExecutionEvent });
  }

  const paperCoordinator = new LatencyPaperCoordinator({
    engine: paperEngine,
    recorder: paperRecorder,
    canAcceptEntry: () => {
      if (durableStore !== null) updatePersistenceHealth(durableStore.getHealth());
      return operational.canAcceptPaperEntry();
    },
  });
  const clockHealthMonitor = new ClockHealthMonitor(CLOCK_JUMP_THRESHOLD_MS);
  let pipeline: MarketPipeline;
  pipeline = new MarketPipeline({
    monotonicNow: () => performance.now(),
    onEvent: (event) => {
      if (LOG_FORMAT !== 'json') printOpportunityEvent(event);
      const snapshot = pipeline.getLatestDepthSnapshot();
      if (snapshot !== null) {
        paperCoordinator.processOpportunity(event, snapshot, event.updatedAt);
      }
    },
  });

  const getHealth = () => {
    if (durableStore !== null) updatePersistenceHealth(durableStore.getHealth());
    return { ...operational.getHealth(paperEngine.getRiskSummary()), privateRead: privateCollector.getHealth() };
  };
  const getMetrics = (includeInventory = false): Record<string, unknown> => {
    const health = getHealth();
    const persistence = durableStore?.getHealth();
    const now = Date.now();
    const privateInventory = privateCollector.getInventory();
    const safetySummary = privateCollector.getSafetySummary();
    const books = pipeline.getLatestDepthSnapshot();
    const reconciliation = includeInventory && privateSetup.enabled ? (['bybit', 'okx'] as const).map(exchange =>
      reconcileAccount(exchange, privateInventory[exchange] ?? null, paperEngine.getBalances(),
        privateCollector.getDiagnosticHealth(exchange).fee.healthy ? (exchange === 'bybit' ? safetySummary.bybitFeeSnapshot : safetySummary.okxFeeSnapshot) : null,
        (exchange === 'bybit' ? books?.bybitBook : books?.okxBook) ?? null, now,
        privateCollector.getDiagnosticHealth(exchange).balance.healthy)) : [];
    return { ...health, process: resources?.snapshot(),
      privateReadMetrics: privateCollector.getMetrics(),
      ...(privateSetup.enabled ? { feeModel: privateCollector.getFeeDiagnostic() } : {}),
      ...(includeInventory && privateSetup.enabled ? { accountSafety: privateCollector.getSafetySummary(reconciliation) } : {}),
      ...(includeInventory ? { inventoryObservation: compareInventory(privateCollector.getInventory(), paperEngine.getBalances()) } : {}),
      market: { ...health.market, ...operational.heartbeat,
        bybitBookAgeMs: operational.heartbeat.lastBybitBookAt === null ? null : now - operational.heartbeat.lastBybitBookAt,
        okxBookAgeMs: operational.heartbeat.lastOkxBookAt === null ? null : now - operational.heartbeat.lastOkxBookAt },
      persistence: { ...health.persistence, journalBytes: persistence?.journalBytes ?? null,
        queueDepth: persistence?.queueDepth ?? null, freeDiskBytes: diskBytes,
        directorySyncSupported: persistence?.directorySyncSupported ?? null,
        checkpointAgeMs: persistence?.lastCheckpointAt == null ? null : now - persistence.lastCheckpointAt },
      paper: { ...health.paper, activeOrders: paperEngine.getOrders().filter(order =>
        !['FILLED', 'CANCELLED', 'REJECTED', 'TIMED_OUT'].includes(order.state)).length },
    };
  };
  const healthServer = await startHealthServer({
    host: HEALTH_HOST,
    port: HEALTH_PORT,
    getHealth, getMetrics: () => getMetrics(true),
  });
  privateCollector.start();
  const healthAddress = healthServer.address();

  logger.info('runtime_started', 'Durable virtual paper engine started.', { healthPort: healthAddress.port });

  function receiveOrderBook(orderBook: NormalizedOrderBook): void {
    if (!isValidNormalizedOrderBook(orderBook)) {
      logger.warn(
        'invalid_order_book',
        `Invalid ${orderBook.exchange} order book ignored.`,
        { exchange: orderBook.exchange },
      );
      return;
    }
    const timestamp = Date.now();
    operational.observeBook(orderBook.exchange, timestamp);
    const clockHealth = clockHealthMonitor.sample(
      orderBook.receivedTimestamp,
      orderBook.receivedMonotonicMs ?? performance.now(),
    );
    const snapshot = pipeline.processOrderBook(
      orderBook,
      timestamp,
      clockHealth,
    );
    if (snapshot !== null) {
      operational.heartbeat.lastComparisonAt = timestamp;
      operational.observeTiming(
        snapshot.syncAssessment.status,
        snapshot.syncAssessment.clockHealth.status,
      );
    }
    paperCoordinator.processOrderBook(orderBook, timestamp);
  }

  const connections: ExchangeConnection[] = [
    connectBybit(receiveOrderBook, (connected) =>
      operational.setFeedConnected('bybit', connected),
    ),
    connectOkx(receiveOrderBook, (connected) =>
      operational.setFeedConnected('okx', connected),
    ),
  ];

  const outputTimer = setInterval(() => {
    if (LOG_FORMAT === 'json') return;
    const snapshot = pipeline.getLatestDepthSnapshot();
    if (snapshot !== null) {
      printDepthComparisonSummary(
        snapshot.comparisons,
        snapshot.qualifications,
        undefined,
        snapshot.syncAssessment,
        snapshot.processingDurationMs,
      );
    }
  }, OUTPUT_INTERVAL_MS);

  const metricsTimer = setInterval(() => {
    logger.info('operational_summary', 'Periodic operational health.', getMetrics());
    resources?.reset();
    if (durableStore?.getHealth().dirtySince != null && durableStore.getHealth().queueDepth === 0) {
      void durableStore.checkpoint();
    }
    if (LOG_FORMAT === 'json') return;
    console.log(`\n[OPERATIONAL] State: ${operational.getState()}`);
    printMetricsSummary(pipeline.getMetricsSummary());
    printPaperSummary(paperEngine.getSummary());
    printPaperExecutionMetrics(paperEngine.getMetrics());
    printPaperRiskSummary(paperEngine.getRiskSummary());
  }, METRICS_INTERVAL_MS);
  let checkingDisk = false;
  const heartbeatTimer = setInterval(() => {
    getHealth();
    if (checkingDisk) return;
    checkingDisk = true;
    void freeDiskBytes(DATA_DIR).then(value => { diskBytes = value; }, () => {
      diskBytes = 0;
      logger.error('disk_check_failed', 'Disk diagnostic failed; entries blocked.');
    }).finally(() => { checkingDisk = false; getHealth(); });
  }, 1000);

  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    operational.beginShutdown();
    logger.info('shutdown_started', `Received ${signal}.`);
    clearInterval(outputTimer);
    clearInterval(metricsTimer);
    clearInterval(heartbeatTimer);
    for (const connection of connections) {
      connection.close();
    }
    await privateCollector.stop();
    await pipeline.flush();
    await paperCoordinator.flush();
    await durableStore?.flush();
    await durableStore?.checkpoint();
    if (durableStore !== null) {
      updatePersistenceHealth(durableStore.getHealth());
    }
    logger.info('final_summary', 'Final operational summary.', getMetrics());
    if (LOG_FORMAT !== 'json') {
      printMetricsSummary(pipeline.getMetricsSummary());
      printPaperSummary(paperEngine.getSummary());
      printPaperExecutionMetrics(paperEngine.getMetrics());
      printPaperRiskSummary(paperEngine.getRiskSummary());
    }
    await healthServer.close();
    resources?.close();
    await runtimeLock?.release();
    runtimeLock = null;
    const persistenceHealth = durableStore?.getHealth();
    if (
      persistenceHealth === undefined ||
      !persistenceHealth.checkpointHealthy ||
      !persistenceHealth.journalHealthy
    ) {
      logger.error(
        'shutdown_persistence_incomplete',
        persistenceHealth?.lastError ?? 'Durable store was unavailable.',
      );
      process.exitCode = 1;
    } else {
      logger.info(
        'shutdown_complete',
        'Persistence flushed and checkpoint saved.',
      );
    }
  }

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch(async (error: unknown) => {
  resources?.close();
  await runtimeLock?.release();
  const message = error instanceof Error ? error.message : String(error);
  new Logger('paper-runtime').error('startup_failed', message);
  process.exitCode = 1;
});
