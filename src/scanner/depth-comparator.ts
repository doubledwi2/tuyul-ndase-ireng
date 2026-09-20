import type { FeeConfig } from '../config/fees.js';
import {
  isValidNormalizedOrderBook,
  type NormalizedOrderBook,
} from '../types/orderbook.js';
import { comparisonSyncStatus } from './comparator.js';
import {
  simulateExecution,
  type ExecutionSimulation,
} from './execution-simulator.js';
import type { FeeAwareComparison } from './fee-model.js';

export type DepthComparisonStatus =
  | 'EXECUTABLE_NET_POSITIVE'
  | 'EXECUTABLE_NET_ZERO_OR_NEGATIVE'
  | 'INSUFFICIENT_DEPTH'
  | 'STALE';

export interface DepthComparison {
  symbol: 'BTC/USDT';
  buyExchange: 'bybit' | 'okx';
  sellExchange: 'bybit' | 'okx';
  targetBaseSize: number;
  buyExecution: ExecutionSimulation;
  sellExecution: ExecutionSimulation;
  buyFeeRate: number;
  sellFeeRate: number;
  simulatedBuyNotional: number | null;
  simulatedSellNotional: number | null;
  estimatedBuyFee: number | null;
  estimatedSellFee: number | null;
  estimatedTotalFee: number | null;
  grossPnlAbsolute: number | null;
  estimatedNetPnlAbsolute: number | null;
  estimatedNetSpreadPercent: number | null;
  bestGrossSpreadAbsolute: number;
  bestGrossSpreadPercent: number;
  tradableSize: number;
  buyReceivedTimestamp: number;
  sellReceivedTimestamp: number;
  receiveTimeDifferenceMs: number;
  syncStatus: 'SYNC_OK' | 'STALE';
  status: DepthComparisonStatus;
}

export type DepthComparisons = [DepthComparison, DepthComparison];

function validateRate(exchange: string, rate: number): void {
  if (!Number.isFinite(rate) || rate < 0) {
    throw new RangeError(`Invalid taker fee rate for ${exchange}.`);
  }
}

function createDepthComparison(
  buyBook: NormalizedOrderBook,
  sellBook: NormalizedOrderBook,
  targetBaseSize: number,
  fees: FeeConfig,
  comparisonTimestamp: number,
): DepthComparison {
  const buyExecution = simulateExecution(buyBook, 'BUY', targetBaseSize);
  const sellExecution = simulateExecution(sellBook, 'SELL', targetBaseSize);
  const buyFeeRate = fees[buyBook.exchange].takerRate;
  const sellFeeRate = fees[sellBook.exchange].takerRate;
  validateRate(buyBook.exchange, buyFeeRate);
  validateRate(sellBook.exchange, sellFeeRate);

  const buyBestPrice = buyExecution.bestPrice;
  const sellBestPrice = sellExecution.bestPrice;
  if (buyBestPrice === null || sellBestPrice === null) {
    throw new RangeError('Order book is missing a best price.');
  }

  const bestGrossSpreadAbsolute = sellBestPrice - buyBestPrice;
  const receiveTimeDifferenceMs = Math.abs(
    buyBook.receivedTimestamp - sellBook.receivedTimestamp,
  );
  const syncStatus = comparisonSyncStatus(
    buyBook.receivedTimestamp,
    sellBook.receivedTimestamp,
    comparisonTimestamp,
  );
  const fullyFilled = buyExecution.fullyFilled && sellExecution.fullyFilled;

  let simulatedBuyNotional: number | null = null;
  let simulatedSellNotional: number | null = null;
  let estimatedBuyFee: number | null = null;
  let estimatedSellFee: number | null = null;
  let estimatedTotalFee: number | null = null;
  let grossPnlAbsolute: number | null = null;
  let estimatedNetPnlAbsolute: number | null = null;
  let estimatedNetSpreadPercent: number | null = null;

  if (fullyFilled) {
    simulatedBuyNotional = buyExecution.notional;
    simulatedSellNotional = sellExecution.notional;
    estimatedBuyFee = simulatedBuyNotional * buyFeeRate;
    estimatedSellFee = simulatedSellNotional * sellFeeRate;
    estimatedTotalFee = estimatedBuyFee + estimatedSellFee;
    grossPnlAbsolute = simulatedSellNotional - simulatedBuyNotional;
    estimatedNetPnlAbsolute = grossPnlAbsolute - estimatedTotalFee;
    estimatedNetSpreadPercent =
      (estimatedNetPnlAbsolute / simulatedBuyNotional) * 100;
  }

  let status: DepthComparisonStatus;
  if (syncStatus === 'STALE') {
    status = 'STALE';
  } else if (!fullyFilled) {
    status = 'INSUFFICIENT_DEPTH';
  } else if ((estimatedNetPnlAbsolute ?? 0) > 0) {
    status = 'EXECUTABLE_NET_POSITIVE';
  } else {
    status = 'EXECUTABLE_NET_ZERO_OR_NEGATIVE';
  }

  return {
    symbol: 'BTC/USDT',
    buyExchange: buyBook.exchange,
    sellExchange: sellBook.exchange,
    targetBaseSize,
    buyExecution,
    sellExecution,
    buyFeeRate,
    sellFeeRate,
    simulatedBuyNotional,
    simulatedSellNotional,
    estimatedBuyFee,
    estimatedSellFee,
    estimatedTotalFee,
    grossPnlAbsolute,
    estimatedNetPnlAbsolute,
    estimatedNetSpreadPercent,
    bestGrossSpreadAbsolute,
    bestGrossSpreadPercent: (bestGrossSpreadAbsolute / buyBestPrice) * 100,
    tradableSize: Math.min(buyExecution.filledSize, sellExecution.filledSize),
    buyReceivedTimestamp: buyBook.receivedTimestamp,
    sellReceivedTimestamp: sellBook.receivedTimestamp,
    receiveTimeDifferenceMs,
    syncStatus,
    status,
  };
}

export function compareOrderBooks(
  bybitBook: NormalizedOrderBook | undefined,
  okxBook: NormalizedOrderBook | undefined,
  targetBaseSize: number,
  fees: FeeConfig,
  comparisonTimestamp = Date.now(),
): DepthComparisons | null {
  if (
    bybitBook === undefined ||
    okxBook === undefined ||
    bybitBook.exchange !== 'bybit' ||
    okxBook.exchange !== 'okx' ||
    !isValidNormalizedOrderBook(bybitBook) ||
    !isValidNormalizedOrderBook(okxBook)
  ) {
    return null;
  }
  return [
    createDepthComparison(
      bybitBook,
      okxBook,
      targetBaseSize,
      fees,
      comparisonTimestamp,
    ),
    createDepthComparison(
      okxBook,
      bybitBook,
      targetBaseSize,
      fees,
      comparisonTimestamp,
    ),
  ];
}

export function legacyFeeComparisonToDepth(
  comparison: FeeAwareComparison,
): DepthComparison {
  const buyExecution: ExecutionSimulation = {
    side: 'BUY',
    requestedSize: comparison.tradableSize,
    filledSize: comparison.tradableSize,
    unfilledSize: 0,
    fullyFilled: true,
    notional: comparison.buyNotional,
    averageExecutionPrice: comparison.buyPrice,
    bestPrice: comparison.buyPrice,
    slippageAbsolute: 0,
    slippagePercent: 0,
  };
  const sellExecution: ExecutionSimulation = {
    side: 'SELL',
    requestedSize: comparison.tradableSize,
    filledSize: comparison.tradableSize,
    unfilledSize: 0,
    fullyFilled: true,
    notional: comparison.sellNotional,
    averageExecutionPrice: comparison.sellPrice,
    bestPrice: comparison.sellPrice,
    slippageAbsolute: 0,
    slippagePercent: 0,
  };
  return {
    symbol: comparison.symbol,
    buyExchange: comparison.buyExchange,
    sellExchange: comparison.sellExchange,
    targetBaseSize: comparison.tradableSize,
    buyExecution,
    sellExecution,
    buyFeeRate: comparison.buyFeeRate,
    sellFeeRate: comparison.sellFeeRate,
    simulatedBuyNotional: comparison.buyNotional,
    simulatedSellNotional: comparison.sellNotional,
    estimatedBuyFee: comparison.estimatedBuyFee,
    estimatedSellFee: comparison.estimatedSellFee,
    estimatedTotalFee: comparison.estimatedTotalFee,
    grossPnlAbsolute: comparison.grossPnlAbsolute,
    estimatedNetPnlAbsolute: comparison.estimatedNetPnlAbsolute,
    estimatedNetSpreadPercent: comparison.estimatedNetSpreadPercent,
    bestGrossSpreadAbsolute: comparison.grossSpreadAbsolute,
    bestGrossSpreadPercent: comparison.grossSpreadPercent,
    tradableSize: comparison.tradableSize,
    buyReceivedTimestamp: comparison.buyReceivedTimestamp,
    sellReceivedTimestamp: comparison.sellReceivedTimestamp,
    receiveTimeDifferenceMs: comparison.receiveTimeDifferenceMs,
    syncStatus: comparison.status,
    status:
      comparison.status === 'STALE'
        ? 'STALE'
        : comparison.estimatedNetPnlAbsolute > 0
          ? 'EXECUTABLE_NET_POSITIVE'
          : 'EXECUTABLE_NET_ZERO_OR_NEGATIVE',
  };
}
