import { performance } from 'node:perf_hooks';

import { MarketPipeline } from './app/pipeline.js';
import { DATA_DIR, HEALTH_HOST, HEALTH_PORT } from './config/runtime.js';
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

async function main(): Promise<void> {
  const logger = new Logger('paper-runtime');
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

  const updatePersistenceHealth = (health: PersistenceHealth): void => {
    operational.setPersistenceHealth({
      checkpointHealthy: health.checkpointHealthy,
      journalHealthy: health.journalHealthy,
      lastCheckpointAt: health.lastCheckpointAt,
    });
    if (!health.checkpointHealthy || !health.journalHealthy) {
      logger.error(
        'persistence_unhealthy',
        health.lastError ?? 'Durable persistence is unhealthy.',
      );
    }
  };

  const onExecutionEvent = (event: PaperExecutionEvent): void => {
    void paperRecorder.record(event);
    void durableStore?.record(event);
    if (event.type === 'TRADE' && event.trade.closedAt !== null) {
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
    canAcceptEntry: () => operational.canAcceptPaperEntry(),
  });
  const clockHealthMonitor = new ClockHealthMonitor(CLOCK_JUMP_THRESHOLD_MS);
  let pipeline: MarketPipeline;
  pipeline = new MarketPipeline({
    monotonicNow: () => performance.now(),
    onEvent: (event) => {
      printOpportunityEvent(event);
      const snapshot = pipeline.getLatestDepthSnapshot();
      if (snapshot !== null) {
        paperCoordinator.processOpportunity(event, snapshot, event.updatedAt);
      }
    },
  });

  const healthServer = await startHealthServer({
    host: HEALTH_HOST,
    port: HEALTH_PORT,
    getHealth: () => operational.getHealth(paperEngine.getRiskSummary()),
  });
  const healthAddress = healthServer.address();

  console.log('[PAPER] Virtual execution mode; no private exchange API is used.');
  console.log('[PAPER] Durable latency-aware paper execution is enabled.');
  console.log(`[PAPER] Event output: ${eventPath}`);
  console.log(
    `[PAPER] Health server: http://${healthAddress.host}:${healthAddress.port}`,
  );

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
    console.log(`\n[OPERATIONAL] State: ${operational.getState()}`);
    printMetricsSummary(pipeline.getMetricsSummary());
    printPaperSummary(paperEngine.getSummary());
    printPaperExecutionMetrics(paperEngine.getMetrics());
    printPaperRiskSummary(paperEngine.getRiskSummary());
  }, METRICS_INTERVAL_MS);

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
    for (const connection of connections) {
      connection.close();
    }
    await pipeline.flush();
    await paperCoordinator.flush();
    await durableStore?.flush();
    await durableStore?.checkpoint();
    if (durableStore !== null) {
      updatePersistenceHealth(durableStore.getHealth());
    }
    printMetricsSummary(pipeline.getMetricsSummary());
    printPaperSummary(paperEngine.getSummary());
    printPaperExecutionMetrics(paperEngine.getMetrics());
    printPaperRiskSummary(paperEngine.getRiskSummary());
    await healthServer.close();
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[PAPER] Fatal startup error: ${message}`);
  process.exitCode = 1;
});
