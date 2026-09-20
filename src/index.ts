import { connectBybit } from './exchanges/bybit.js';
import { connectOkx } from './exchanges/okx.js';
import type { BestQuote, ExchangeConnection } from './types/market.js';

const OUTPUT_INTERVAL_MS = 500;
const latestQuotes = new Map<BestQuote['exchange'], BestQuote>();
const pendingOutput = new Set<BestQuote['exchange']>();

function receiveQuote(quote: BestQuote): void {
  latestQuotes.set(quote.exchange, quote);
  pendingOutput.add(quote.exchange);
}

function formatTimestamp(value: number | null): string {
  return value === null ? 'N/A' : `${new Date(value).toISOString()} (${value})`;
}

function printQuote(quote: BestQuote): void {
  console.log(`\n[${quote.exchange.toUpperCase()}] ${quote.symbol}`);
  console.log(`Bid: ${quote.bid}`);
  console.log(`Ask: ${quote.ask}`);
  console.log(`Exchange time: ${formatTimestamp(quote.exchangeTimestamp)}`);
  console.log(`Received time: ${formatTimestamp(quote.receivedTimestamp)}`);
}

const connections: ExchangeConnection[] = [
  connectBybit(receiveQuote),
  connectOkx(receiveQuote),
];

const outputTimer = setInterval(() => {
  for (const exchange of pendingOutput) {
    const quote = latestQuotes.get(exchange);
    if (quote !== undefined) {
      printQuote(quote);
    }
  }
  pendingOutput.clear();
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
