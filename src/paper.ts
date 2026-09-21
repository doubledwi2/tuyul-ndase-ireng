import { performance } from 'node:perf_hooks';

import { MarketPipeline } from './app/pipeline.js';
import { CLOCK_JUMP_THRESHOLD_MS } from './config/timing.js';
import { connectBybit } from './exchanges/bybit.js';
import { connectOkx } from './exchanges/okx.js';
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

const OUTPUT_INTERVAL_MS = 500;
const METRICS_INTERVAL_MS = 60_000;
const eventPath = createLivePaperEventPath();
const paperRecorder = new PaperExecutionRecorder(eventPath);
const paperEngine = new LatencyPaperTradingEngine({
  onExecutionEvent: (event) => {
    void paperRecorder.record(event);
    if (event.type === 'TRADE' && event.trade.closedAt !== null) {
      printLatencyPaperTrade(event.trade);
    }
  },
});
const paperCoordinator = new LatencyPaperCoordinator({
  engine: paperEngine,
  recorder: paperRecorder,
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

console.log('[PAPER] Virtual execution mode; no private exchange API is used.');
console.log('[PAPER] Latency-aware event-driven virtual execution is enabled.');
console.log(`[PAPER] Event output: ${eventPath}`);

function receiveOrderBook(orderBook: NormalizedOrderBook): void {
  if (!isValidNormalizedOrderBook(orderBook)) {
    console.warn(`[MARKET] Invalid ${orderBook.exchange} order book ignored.`);
    return;
  }
  const timestamp = Date.now();
  const clockHealth = clockHealthMonitor.sample(
    orderBook.receivedTimestamp,
    orderBook.receivedMonotonicMs ?? performance.now(),
  );
  pipeline.processOrderBook(orderBook, timestamp, clockHealth);
  paperCoordinator.processOrderBook(orderBook, timestamp);
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
  console.log(`\nReceived ${signal}; closing public WebSocket connections...`);
  clearInterval(outputTimer);
  clearInterval(metricsTimer);
  for (const connection of connections) {
    connection.close();
  }
  printMetricsSummary(pipeline.getMetricsSummary());
  printPaperSummary(paperEngine.getSummary());
  printPaperExecutionMetrics(paperEngine.getMetrics());
  printPaperRiskSummary(paperEngine.getRiskSummary());
  await Promise.all([pipeline.flush(), paperCoordinator.flush()]);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
