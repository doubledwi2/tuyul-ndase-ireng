import type { NormalizedOrderBook } from '../types/orderbook.js';
import {
  replayTimedRecords,
  type ReplayResult,
  type ReplaySleep,
  type ReplaySpeed,
} from './replay-engine.js';
import {
  loadOrderBookRecords,
} from './orderbook-replay-loader.js';
import type { ReplayWarningHandler } from './replay-loader.js';

export interface ReplayOrderBooksOptions {
  filePath: string;
  speed?: ReplaySpeed;
  onOrderBook: (
    orderBook: NormalizedOrderBook,
    recordedAt: number,
  ) => void | Promise<void>;
  sleep?: ReplaySleep;
  onWarning?: ReplayWarningHandler;
}

export function replayOrderBooks(
  options: ReplayOrderBooksOptions,
): Promise<ReplayResult> {
  return replayTimedRecords(
    loadOrderBookRecords(options.filePath, options.onWarning),
    options.speed ?? 'max',
    (record) => options.onOrderBook(record.orderBook, record.recordedAt),
    options.sleep,
  );
}
