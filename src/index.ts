import { connectBybit } from './exchanges/bybit.js';
import { connectOkx } from './exchanges/okx.js';
import { compareQuotes } from './scanner/comparator.js';
import { OpportunityTracker } from './scanner/opportunity.js';
import type { BestQuote, ExchangeConnection } from './types/market.js';
import {
  printComparisonSummary,
  printOpportunityEvent,
} from './ui/console.js';

const OUTPUT_INTERVAL_MS = 500;
const latestQuotes = new Map<BestQuote['exchange'], BestQuote>();
const opportunityTracker = new OpportunityTracker();

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
        printOpportunityEvent(event);
      }
    }
  }
}, OUTPUT_INTERVAL_MS);

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`\nReceived ${signal}; closing WebSocket connections...`);
  clearInterval(outputTimer);
  for (const connection of connections) {
    connection.close();
  }

  setTimeout(() => process.exit(0), 250).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
