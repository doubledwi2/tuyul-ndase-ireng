import { connectBybit } from './exchanges/bybit.js';
import { connectOkx } from './exchanges/okx.js';
import { OpportunityMetrics } from './metrics/opportunity-metrics.js';
import { EventRecorder } from './recording/event-recorder.js';
import { compareQuotes } from './scanner/comparator.js';
import { OpportunityTracker } from './scanner/opportunity.js';
import type { BestQuote, ExchangeConnection } from './types/market.js';
import {
  printComparisonSummary,
  printMetricsSummary,
  printOpportunityEvent,
} from './ui/console.js';

const OUTPUT_INTERVAL_MS = 500;
const METRICS_INTERVAL_MS = 60_000;
const latestQuotes = new Map<BestQuote['exchange'], BestQuote>();
const opportunityTracker = new OpportunityTracker();
const eventRecorder = new EventRecorder();
const opportunityMetrics = new OpportunityMetrics();

function receiveQuote(quote: BestQuote): void {
  latestQuotes.set(quote.exchange, quote);
}

const connections: ExchangeConnection[] = [
  connectBybit(receiveQuote),
  connectOkx(receiveQuote),
];

const outputTimer = setInterval(() => {
  const bybitQuote = latestQuotes.get('bybit');
  const okxQuote = latestQuotes.get('okx');
  const comparisonTimestamp = Date.now();
  const comparisons = compareQuotes(
    bybitQuote,
    okxQuote,
    comparisonTimestamp,
  );

  if (
    bybitQuote !== undefined &&
    okxQuote !== undefined &&
    comparisons !== null
  ) {
    printComparisonSummary(bybitQuote, okxQuote, comparisons);

    for (const comparison of comparisons) {
      const event = opportunityTracker.process(
        comparison,
        comparisonTimestamp,
      );
      if (event !== null) {
        void eventRecorder.record(event, comparisonTimestamp);
        if (event.state === 'DISAPPEARED') {
          opportunityMetrics.recordCompleted(event);
        }
        printOpportunityEvent(event);
      }
    }
  }
}, OUTPUT_INTERVAL_MS);

const metricsTimer = setInterval(() => {
  printMetricsSummary(opportunityMetrics.getSummary());
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

  await eventRecorder.flush();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
