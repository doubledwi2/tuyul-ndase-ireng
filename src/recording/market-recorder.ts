import type { BestQuote } from '../types/market.js';
import {
  JsonlWriter,
  type RecorderErrorHandler,
} from './jsonl-writer.js';

export const DEFAULT_MARKET_RECORD_PATH = 'data/market-quotes.jsonl';

export interface MarketQuoteRecord {
  recordedAt: number;
  quote: BestQuote;
}

function defaultErrorHandler(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[MARKET RECORDER] Write failed: ${message}`);
}

export class MarketRecorder {
  private readonly writer: JsonlWriter;

  constructor(
    filePath = DEFAULT_MARKET_RECORD_PATH,
    onError: RecorderErrorHandler = defaultErrorHandler,
  ) {
    this.writer = new JsonlWriter(filePath, onError);
  }

  record(quote: BestQuote, recordedAt: number): Promise<void> {
    const record: MarketQuoteRecord = { recordedAt, quote };
    return this.writer.append(record);
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }
}
