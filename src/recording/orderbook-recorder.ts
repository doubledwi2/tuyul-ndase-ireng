import type { NormalizedOrderBook } from '../types/orderbook.js';
import {
  JsonlWriter,
  type RecorderErrorHandler,
} from './jsonl-writer.js';

export const DEFAULT_ORDERBOOK_RECORD_PATH = 'data/orderbooks.jsonl';

export interface OrderBookRecord {
  recordedAt: number;
  orderBook: NormalizedOrderBook;
}

function defaultErrorHandler(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ORDERBOOK RECORDER] Write failed: ${message}`);
}

export class OrderBookRecorder {
  private readonly writer: JsonlWriter;

  constructor(
    filePath = DEFAULT_ORDERBOOK_RECORD_PATH,
    onError: RecorderErrorHandler = defaultErrorHandler,
  ) {
    this.writer = new JsonlWriter(filePath, onError);
  }

  record(orderBook: NormalizedOrderBook, recordedAt: number): Promise<void> {
    const record: OrderBookRecord = { recordedAt, orderBook };
    return this.writer.append(record);
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }
}
