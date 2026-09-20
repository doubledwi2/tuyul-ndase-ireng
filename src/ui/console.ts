import type { CrossExchangeComparisons, SpreadComparison } from '../scanner/comparator.js';
import type { BestQuote } from '../types/market.js';

function signed(value: number, fractionDigits: number): string {
  const prefix = value >= 0 ? '+' : '';
  return `${prefix}${value.toFixed(fractionDigits)}`;
}

function printQuote(label: string, quote: BestQuote): void {
  console.log(label);
  console.log(`Bid: ${quote.bid} (${quote.bidSize} BTC)`);
  console.log(`Ask: ${quote.ask} (${quote.askSize} BTC)`);
}

function printDirection(comparison: SpreadComparison): void {
  const buy = comparison.buyExchange.toUpperCase();
  const sell = comparison.sellExchange.toUpperCase();

  console.log(`${buy} -> ${sell}`);
  console.log(`Buy: ${comparison.buyPrice}`);
  console.log(`Sell: ${comparison.sellPrice}`);
  console.log(
    `Gross spread: ${signed(comparison.grossSpreadAbsolute, 2)} USDT ` +
      `(${signed(comparison.grossSpreadPercent, 4)}%)`,
  );
  console.log(`Tradable size: ${comparison.tradableSize} BTC`);
  console.log(`Sync diff: ${comparison.receiveTimeDifferenceMs} ms`);
  console.log(`Status: ${comparison.status}`);
}

export function printComparisonSummary(
  bybitQuote: BestQuote,
  okxQuote: BestQuote,
  comparisons: CrossExchangeComparisons,
): void {
  console.log(`\n${bybitQuote.symbol}\n`);
  printQuote('BYBIT', bybitQuote);
  console.log('');
  printQuote('OKX', okxQuote);
  console.log('');
  printDirection(comparisons[0]);
  console.log('');
  printDirection(comparisons[1]);
}
