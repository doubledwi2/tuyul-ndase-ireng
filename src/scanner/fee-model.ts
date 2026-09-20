import type { FeeConfig } from '../config/fees.js';
import type { SpreadComparison } from './comparator.js';

export interface FeeAwareComparison extends SpreadComparison {
  buyFeeRate: number;
  sellFeeRate: number;
  buyNotional: number;
  sellNotional: number;
  estimatedBuyFee: number;
  estimatedSellFee: number;
  estimatedTotalFee: number;
  grossPnlAbsolute: number;
  estimatedNetPnlAbsolute: number;
  estimatedNetSpreadPercent: number;
  feeStatus: 'NET_POSITIVE' | 'NET_ZERO_OR_NEGATIVE' | 'STALE';
}

export type FeeAwareComparisons = [FeeAwareComparison, FeeAwareComparison];

function validateRate(exchange: string, rate: number): void {
  if (!Number.isFinite(rate) || rate < 0) {
    throw new RangeError(`Invalid taker fee rate for ${exchange}.`);
  }
}

export function calculateFeeAwareComparison(
  comparison: SpreadComparison,
  fees: FeeConfig,
): FeeAwareComparison {
  const buyFeeRate = fees[comparison.buyExchange].takerRate;
  const sellFeeRate = fees[comparison.sellExchange].takerRate;
  validateRate(comparison.buyExchange, buyFeeRate);
  validateRate(comparison.sellExchange, sellFeeRate);

  const buyNotional = comparison.buyPrice * comparison.tradableSize;
  const sellNotional = comparison.sellPrice * comparison.tradableSize;
  const estimatedBuyFee = buyNotional * buyFeeRate;
  const estimatedSellFee = sellNotional * sellFeeRate;
  const estimatedTotalFee = estimatedBuyFee + estimatedSellFee;
  const grossPnlAbsolute =
    (comparison.sellPrice - comparison.buyPrice) * comparison.tradableSize;
  const estimatedNetPnlAbsolute = grossPnlAbsolute - estimatedTotalFee;
  const estimatedNetSpreadPercent =
    (estimatedNetPnlAbsolute / buyNotional) * 100;

  const calculatedValues = [
    buyNotional,
    sellNotional,
    estimatedBuyFee,
    estimatedSellFee,
    estimatedTotalFee,
    grossPnlAbsolute,
    estimatedNetPnlAbsolute,
    estimatedNetSpreadPercent,
  ];
  if (
    comparison.buyPrice <= 0 ||
    comparison.sellPrice <= 0 ||
    comparison.tradableSize <= 0 ||
    calculatedValues.some((value) => !Number.isFinite(value))
  ) {
    throw new RangeError('Cannot calculate fees from an invalid comparison.');
  }

  let feeStatus: FeeAwareComparison['feeStatus'];
  if (comparison.status === 'STALE') {
    feeStatus = 'STALE';
  } else if (estimatedNetPnlAbsolute > 0) {
    feeStatus = 'NET_POSITIVE';
  } else {
    feeStatus = 'NET_ZERO_OR_NEGATIVE';
  }

  return {
    ...comparison,
    buyFeeRate,
    sellFeeRate,
    buyNotional,
    sellNotional,
    estimatedBuyFee,
    estimatedSellFee,
    estimatedTotalFee,
    grossPnlAbsolute,
    estimatedNetPnlAbsolute,
    estimatedNetSpreadPercent,
    feeStatus,
  };
}
