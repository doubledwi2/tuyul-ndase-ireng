import type { OpportunityMetricsSummary } from '../metrics/opportunity-metrics.js';
import type {
  FeeAwareComparison,
  FeeAwareComparisons,
} from '../scanner/fee-model.js';
import type { OpportunityEvent } from '../scanner/opportunity.js';
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

function printDirection(comparison: FeeAwareComparison): void {
  const buy = comparison.buyExchange.toUpperCase();
  const sell = comparison.sellExchange.toUpperCase();

  console.log(`${buy} -> ${sell}`);
  console.log(`Buy: ${comparison.buyPrice}`);
  console.log(`Sell: ${comparison.sellPrice}`);
  console.log(`Tradable size: ${comparison.tradableSize} BTC`);
  console.log('');
  console.log(
    `Gross spread: ${signed(comparison.grossSpreadAbsolute, 2)} USDT/BTC ` +
      `(${signed(comparison.grossSpreadPercent, 4)}%)`,
  );
  console.log(`Gross PnL: ${signed(comparison.grossPnlAbsolute, 4)} USDT`);
  console.log('Estimated fees:');
  console.log(`Buy fee: ${comparison.estimatedBuyFee.toFixed(4)} USDT`);
  console.log(`Sell fee: ${comparison.estimatedSellFee.toFixed(4)} USDT`);
  console.log(`Total fee: ${comparison.estimatedTotalFee.toFixed(4)} USDT`);
  console.log(
    `Estimated net: ${signed(comparison.estimatedNetPnlAbsolute, 4)} USDT ` +
      `(${signed(comparison.estimatedNetSpreadPercent, 4)}%)`,
  );
  console.log(`Sync diff: ${comparison.receiveTimeDifferenceMs} ms`);
  console.log(`Fee status: ${comparison.feeStatus}`);
}

export function printComparisonSummary(
  bybitQuote: BestQuote,
  okxQuote: BestQuote,
  comparisons: FeeAwareComparisons,
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

export function printOpportunityEvent(event: OpportunityEvent): void {
  console.log('\n[EVENT]');
  console.log(`ID: ${event.id}`);
  console.log(
    `Direction: ${event.buyExchange.toUpperCase()} -> ${event.sellExchange.toUpperCase()}`,
  );
  console.log(`State: ${event.state}`);
  console.log(
    `Gross spread: ${signed(event.currentGrossSpreadAbsolute, 2)} USDT/BTC ` +
      `(${signed(event.currentGrossSpreadPercent, 4)}%)`,
  );
  console.log(
    `Estimated net spread: ${signed(event.currentEstimatedNetSpreadPercent, 4)}%`,
  );
  console.log(
    `Estimated net PnL: ${signed(event.currentEstimatedNetPnlAbsolute, 4)} USDT`,
  );
  console.log(
    `Estimated total fee: ${event.currentEstimatedTotalFee.toFixed(4)} USDT`,
  );
  console.log(`Tradable size: ${event.currentTradableSize} BTC`);
  console.log(`Sync diff: ${event.currentReceiveTimeDifferenceMs} ms`);

  if (event.state === 'DISAPPEARED') {
    console.log(`Lifetime: ${event.lifetimeMs ?? 0} ms`);
    console.log(
      `Peak gross spread: ${signed(event.peakGrossSpreadAbsolute, 2)} USDT/BTC ` +
        `(${signed(event.peakGrossSpreadPercent, 4)}%)`,
    );
    console.log(
      `Peak estimated net spread: ${signed(event.peakEstimatedNetSpreadPercent, 4)}%`,
    );
    console.log(
      `Peak estimated net PnL: ${signed(event.peakEstimatedNetPnlAbsolute, 4)} USDT`,
    );
    console.log(`Peak tradable size: ${event.peakTradableSize} BTC`);
  }
}

function metric(value: number | null, fractionDigits: number): string {
  return value === null ? 'N/A' : value.toFixed(fractionDigits);
}

export function printMetricsSummary(summary: OpportunityMetricsSummary): void {
  console.log('\n[METRICS]');
  console.log(`Completed events: ${summary.totalCompletedEvents}`);
  console.log(`Ever ACTIVE: ${summary.eventsEverActive}`);
  console.log(`Never ACTIVE: ${summary.eventsNeverActive}`);
  console.log(`Ever INVALID_SYNC: ${summary.invalidSyncEvents}`);
  console.log('');
  console.log('Lifetime:');
  console.log(`Avg: ${metric(summary.averageLifetimeMs, 2)} ms`);
  console.log(`Min: ${metric(summary.minLifetimeMs, 0)} ms`);
  console.log(`P50: ${metric(summary.p50LifetimeMs, 0)} ms`);
  console.log(`P95: ${metric(summary.p95LifetimeMs, 0)} ms`);
  console.log(`P99: ${metric(summary.p99LifetimeMs, 0)} ms`);
  console.log(`Max: ${metric(summary.maxLifetimeMs, 0)} ms`);
  console.log('');
  console.log('Peak gross spread:');
  console.log(`Avg: ${metric(summary.averagePeakSpreadPercent, 4)}%`);
  console.log(`Max: ${metric(summary.maxPeakSpreadPercent, 4)}%`);
  console.log('');
  console.log('Peak estimated net spread:');
  console.log(`Avg: ${metric(summary.averagePeakNetSpreadPercent, 4)}%`);
  console.log(`Max: ${metric(summary.maxPeakNetSpreadPercent, 4)}%`);
  console.log('');
  console.log('Peak estimated net PnL:');
  console.log(`Avg: ${metric(summary.averagePeakNetPnlAbsolute, 4)} USDT`);
  console.log(`Max: ${metric(summary.maxPeakNetPnlAbsolute, 4)} USDT`);
  console.log('');
  console.log('Peak size:');
  console.log(`Avg: ${metric(summary.averagePeakTradableSize, 8)} BTC`);
  console.log(`Max: ${metric(summary.maxPeakTradableSize, 8)} BTC`);
}
