import { MarketPipeline } from './app/pipeline.js';
import { connectBybit } from './exchanges/bybit.js';
import { connectOkx } from './exchanges/okx.js';
import { EventRecorder } from './recording/event-recorder.js';
import { MarketRecorder } from './recording/market-recorder.js';
import type { BestQuote, ExchangeConnection } from './types/market.js';
import { isValidBestQuote } from './types/market.js';
import {
  printComparisonSummary,
  printMetricsSummary,
  printOpportunityEvent,
} from './ui/console.js';

const OUTPUT_INTERVAL_MS = 500;
const METRICS_INTERVAL_MS = 60_000;
const eventRecorder = new EventRecorder();
const marketRecorder = new MarketRecorder();
const pipeline = new MarketPipeline({
  eventRecorder,
  onEvent: printOpportunityEvent,
});

function receiveQuote(quote: BestQuote): void {
  if (!isValidBestQuote(quote)) {
    console.warn(`[MARKET] Invalid ${quote.exchange} quote ignored.`);
    return;
  }

  const recordedAt = Date.now();
  pipeline.processQuote(quote, recordedAt);
  void marketRecorder.record(quote, recordedAt);
}

const connections: ExchangeConnection[] = [
  connectBybit(receiveQuote),
  connectOkx(receiveQuote),
];

const outputTimer = setInterval(() => {
  const snapshot = pipeline.getLatestSnapshot();
  if (snapshot !== null) {
    printComparisonSummary(
      snapshot.bybitQuote,
      snapshot.okxQuote,
      snapshot.feeAwareComparisons,
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

  await Promise.all([marketRecorder.flush(), pipeline.flush()]);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
