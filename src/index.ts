import { performance } from 'node:perf_hooks';
import { loadExecutionBoundary } from './execution/startup.js';
import { Logger } from './operations/logger.js';
import { createPrivateReadClients } from './private-read/startup.js';
import { PrivateAccountCollector } from './private-read/collector.js';
import { ShadowRuntime } from './shadow/shadow-runtime.js';
import { shadowInput } from './app/shadow-input.js';

import { MarketPipeline } from './app/pipeline.js';
import { CLOCK_JUMP_THRESHOLD_MS } from './config/timing.js';
import { connectBybit } from './exchanges/bybit.js';
import { connectOkx } from './exchanges/okx.js';
import { EventRecorder } from './recording/event-recorder.js';
import { MarketRecorder } from './recording/market-recorder.js';
import { OrderBookRecorder } from './recording/orderbook-recorder.js';
import type { ExchangeConnection } from './types/market.js';
import {
  deriveBestQuote,
  isValidNormalizedOrderBook,
  type NormalizedOrderBook,
} from './types/orderbook.js';
import {
  printDepthComparisonSummary,
  printMetricsSummary,
  printOpportunityEvent,
} from './ui/console.js';
import { ClockHealthMonitor } from './timing/clock-health.js';

const safety = await loadExecutionBoundary();
const privateSetup = await createPrivateReadClients();
const shadow = new ShadowRuntime(process.env.SHADOW_MODE_ENABLED === 'true');
const privateCollector = new PrivateAccountCollector(privateSetup.enabled, privateSetup.clients,
  (exchange, error, kind) => new Logger('private-read').warn('private_read_failed', 'Private account polling failed.',
    { exchange, kind, status: error.status, category: error.category }), Date.now,
  (exchange, category) => new Logger('private-read').warn('private_account_review', 'Read-only account diagnostic requires review.', { exchange, category }));
new Logger('market-runtime').info('execution_safety', 'Public market data; real execution DISABLED.', { ...safety, privateReadEnabled: privateSetup.enabled });

const OUTPUT_INTERVAL_MS = 500;
const METRICS_INTERVAL_MS = 60_000;
const eventRecorder = new EventRecorder();
const marketRecorder = new MarketRecorder();
const orderBookRecorder = new OrderBookRecorder();
const clockHealthMonitor = new ClockHealthMonitor(CLOCK_JUMP_THRESHOLD_MS);
const pipeline = new MarketPipeline({
  eventRecorder,
  onEvent: printOpportunityEvent,
  monotonicNow: () => performance.now(),
});

function receiveOrderBook(orderBook: NormalizedOrderBook): void {
  if (!isValidNormalizedOrderBook(orderBook)) {
    console.warn(`[MARKET] Invalid ${orderBook.exchange} order book ignored.`);
    return;
  }

  const recordedAt = Date.now();
  const clockHealth = clockHealthMonitor.sample(
    orderBook.receivedTimestamp,
    orderBook.receivedMonotonicMs ?? performance.now(),
  );
  const snapshot = pipeline.processOrderBook(orderBook, recordedAt, clockHealth);
  if (shadow.enabled && snapshot !== null) {
    try { shadow.evaluate(shadowInput(snapshot, privateCollector, recordedAt)); }
    catch { new Logger('shadow').warn('shadow_evaluation_failed', 'Shadow diagnostic unavailable.'); }
  }
  void orderBookRecorder.record(orderBook, recordedAt);
  const quote = deriveBestQuote(orderBook);
  if (quote !== null) {
    void marketRecorder.record(quote, recordedAt);
  }
}

const connections: ExchangeConnection[] = [
  connectBybit(receiveOrderBook),
  connectOkx(receiveOrderBook),
];
privateCollector.start();

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
  if (shadow.enabled) new Logger('shadow').info('shadow_summary', '[SHADOW] Hypothetical current-book economics only.', { ...shadow.getHealth(Date.now()), ...shadow.getMetrics() });
  printMetricsSummary(pipeline.getMetricsSummary());
  new Logger('private-read').info('private_read_summary', 'Private read diagnostics (no balances).',
    { health: privateCollector.getHealth(), metrics: privateCollector.getMetrics(),
      ...(privateSetup.enabled ? { feeModel: privateCollector.getFeeDiagnostic() } : {}) });
}, METRICS_INTERVAL_MS);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`\nReceived ${signal}; closing WebSocket connections...`);
  clearInterval(outputTimer);
  clearInterval(metricsTimer);
  for (const connection of connections) {
    connection.close();
  }
  await privateCollector.stop();

  printMetricsSummary(pipeline.getMetricsSummary());

  await Promise.all([
    marketRecorder.flush(),
    orderBookRecorder.flush(),
    pipeline.flush(),
  ]);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
