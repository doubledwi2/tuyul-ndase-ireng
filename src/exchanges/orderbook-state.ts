import {
  isValidNormalizedOrderBook,
  type NormalizedOrderBook,
  type OrderBookLevel,
} from '../types/orderbook.js';

export interface LevelUpdate {
  price: number;
  size: number;
}

export function parseLevelUpdates(value: unknown): LevelUpdate[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const updates: LevelUpdate[] = [];
  for (const rawLevel of value) {
    if (!Array.isArray(rawLevel)) {
      return null;
    }
    const rawPrice = rawLevel[0];
    const rawSize = rawLevel[1];
    if (
      (typeof rawPrice !== 'string' && typeof rawPrice !== 'number') ||
      (typeof rawSize !== 'string' && typeof rawSize !== 'number')
    ) {
      return null;
    }
    const price = Number(rawPrice);
    const size = Number(rawSize);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) {
      return null;
    }
    updates.push({ price, size });
  }
  return updates;
}

export function applyLevelUpdates(
  levels: Map<number, number>,
  updates: readonly LevelUpdate[],
): void {
  for (const update of updates) {
    if (update.size === 0) {
      levels.delete(update.price);
    } else {
      levels.set(update.price, update.size);
    }
  }
}

export function timestamp(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function sequence(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function sortedLevels(
  levels: ReadonlyMap<number, number>,
  side: 'bids' | 'asks',
  limit: number,
): OrderBookLevel[] {
  return [...levels.entries()]
    .sort(([left], [right]) =>
      side === 'bids' ? right - left : left - right,
    )
    .slice(0, limit)
    .map(([price, size]) => ({ price, size }));
}

export function normalizedBookFromMaps(
  exchange: NormalizedOrderBook['exchange'],
  bids: ReadonlyMap<number, number>,
  asks: ReadonlyMap<number, number>,
  depth: number,
  exchangeTimestamp: number | null,
  matchingEngineTimestamp: number | null,
  receivedTimestamp: number,
  receivedMonotonicMs: number | null = null,
): NormalizedOrderBook | null {
  const orderBook: NormalizedOrderBook = {
    exchange,
    symbol: 'BTC/USDT',
    bids: sortedLevels(bids, 'bids', depth),
    asks: sortedLevels(asks, 'asks', depth),
    exchangeTimestamp,
    matchingEngineTimestamp,
    receivedTimestamp,
    receivedMonotonicMs,
  };
  return isValidNormalizedOrderBook(orderBook) ? orderBook : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
