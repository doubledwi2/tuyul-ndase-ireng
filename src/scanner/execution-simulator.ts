import {
  isValidNormalizedOrderBook,
  type NormalizedOrderBook,
  type OrderBookLevel,
} from '../types/orderbook.js';

export type ExecutionSide = 'BUY' | 'SELL';

export interface ExecutionSimulation {
  side: ExecutionSide;
  requestedSize: number;
  filledSize: number;
  unfilledSize: number;
  fullyFilled: boolean;
  notional: number;
  averageExecutionPrice: number | null;
  bestPrice: number | null;
  slippageAbsolute: number | null;
  slippagePercent: number | null;
}

export function simulateExecution(
  orderBook: NormalizedOrderBook,
  side: ExecutionSide,
  requestedSize: number,
): ExecutionSimulation {
  if (!Number.isFinite(requestedSize) || requestedSize <= 0) {
    throw new RangeError('Requested execution size must be finite and positive.');
  }
  if (!isValidNormalizedOrderBook(orderBook)) {
    throw new RangeError('Cannot simulate execution from an invalid order book.');
  }

  const levels: readonly OrderBookLevel[] =
    side === 'BUY' ? orderBook.asks : orderBook.bids;
  const bestPrice = levels[0]?.price ?? null;
  let remaining = requestedSize;
  let filledSize = 0;
  let notional = 0;

  for (const level of levels) {
    if (remaining <= 0) {
      break;
    }
    const fillSize = Math.min(level.size, remaining);
    filledSize += fillSize;
    notional += fillSize * level.price;
    remaining -= fillSize;
  }

  const epsilon = requestedSize * Number.EPSILON * 8;
  const fullyFilled = remaining <= epsilon;
  if (fullyFilled) {
    filledSize = requestedSize;
    remaining = 0;
  }
  const averageExecutionPrice = filledSize > 0 ? notional / filledSize : null;
  const slippageAbsolute =
    averageExecutionPrice !== null && bestPrice !== null
      ? averageExecutionPrice - bestPrice
      : null;
  const slippagePercent =
    slippageAbsolute !== null && bestPrice !== null
      ? (slippageAbsolute / bestPrice) * 100
      : null;

  return {
    side,
    requestedSize,
    filledSize,
    unfilledSize: Math.max(0, remaining),
    fullyFilled,
    notional,
    averageExecutionPrice,
    bestPrice,
    slippageAbsolute,
    slippagePercent,
  };
}
