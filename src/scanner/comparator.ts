import { isValidBestQuote, type BestQuote } from '../types/market.js';

export const MAX_RECEIVE_DIFF_MS = 250;
export const MAX_QUOTE_AGE_MS = 1_000;

export interface SpreadComparison {
  symbol: 'BTC/USDT';
  buyExchange: 'bybit' | 'okx';
  sellExchange: 'bybit' | 'okx';
  buyPrice: number;
  sellPrice: number;
  grossSpreadAbsolute: number;
  grossSpreadPercent: number;
  tradableSize: number;
  buyReceivedTimestamp: number;
  sellReceivedTimestamp: number;
  receiveTimeDifferenceMs: number;
  status: 'SYNC_OK' | 'STALE';
}

export type CrossExchangeComparisons = [SpreadComparison, SpreadComparison];

export function comparisonSyncStatus(
  firstReceivedTimestamp: number,
  secondReceivedTimestamp: number,
  comparisonTimestamp: number,
): SpreadComparison['status'] {
  const receiveTimeDifferenceMs = Math.abs(
    firstReceivedTimestamp - secondReceivedTimestamp,
  );
  const hasOldQuote =
    comparisonTimestamp - firstReceivedTimestamp > MAX_QUOTE_AGE_MS ||
    comparisonTimestamp - secondReceivedTimestamp > MAX_QUOTE_AGE_MS;
  return receiveTimeDifferenceMs <= MAX_RECEIVE_DIFF_MS && !hasOldQuote
    ? 'SYNC_OK'
    : 'STALE';
}

function createComparison(
  buyQuote: BestQuote,
  sellQuote: BestQuote,
  comparisonTimestamp: number,
): SpreadComparison {
  const buyPrice = buyQuote.ask;
  const sellPrice = sellQuote.bid;
  const grossSpreadAbsolute = sellPrice - buyPrice;
  const receiveTimeDifferenceMs = Math.abs(
    buyQuote.receivedTimestamp - sellQuote.receivedTimestamp,
  );

  return {
    symbol: 'BTC/USDT',
    buyExchange: buyQuote.exchange,
    sellExchange: sellQuote.exchange,
    buyPrice,
    sellPrice,
    grossSpreadAbsolute,
    grossSpreadPercent: (grossSpreadAbsolute / buyPrice) * 100,
    tradableSize: Math.min(buyQuote.askSize, sellQuote.bidSize),
    buyReceivedTimestamp: buyQuote.receivedTimestamp,
    sellReceivedTimestamp: sellQuote.receivedTimestamp,
    receiveTimeDifferenceMs,
    status: comparisonSyncStatus(
      buyQuote.receivedTimestamp,
      sellQuote.receivedTimestamp,
      comparisonTimestamp,
    ),
  };
}

export function compareQuotes(
  bybitQuote: BestQuote | undefined,
  okxQuote: BestQuote | undefined,
  comparisonTimestamp = Date.now(),
): CrossExchangeComparisons | null {
  if (
    bybitQuote === undefined ||
    okxQuote === undefined ||
    bybitQuote.exchange !== 'bybit' ||
    okxQuote.exchange !== 'okx' ||
    bybitQuote.symbol !== 'BTC/USDT' ||
    okxQuote.symbol !== 'BTC/USDT' ||
    !isValidBestQuote(bybitQuote) ||
    !isValidBestQuote(okxQuote)
  ) {
    return null;
  }

  return [
    createComparison(bybitQuote, okxQuote, comparisonTimestamp),
    createComparison(okxQuote, bybitQuote, comparisonTimestamp),
  ];
}
