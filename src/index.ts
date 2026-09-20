import { performance } from 'node:perf_hooks';

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
  pipeline.processOrderBook(orderBook, recordedAt, clockHealth);
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
  printMetricsSummary(pipeline.getMetricsSummary());
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
