import type { BestQuote } from '../types/market.js';
import {
  loadMarketQuoteRecords,
  type ReplayWarningHandler,
} from './replay-loader.js';

export type ReplaySpeed = 'realtime' | 'fast' | 'max';
export type ReplaySleep = (milliseconds: number) => Promise<void>;
export type ReplayQuoteHandler = (
  quote: BestQuote,
  recordedAt: number,
) => void | Promise<void>;

export interface ReplayMarketDataOptions {
  filePath: string;
  speed?: ReplaySpeed;
  onQuote: ReplayQuoteHandler;
  sleep?: ReplaySleep;
  onWarning?: ReplayWarningHandler;
}

export interface ReplayResult {
  processedRecords: number;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function replayDelay(
  previous: { recordedAt: number },
  current: { recordedAt: number },
  speed: ReplaySpeed,
): number {
  if (speed === 'max') {
    return 0;
  }

  const originalDelay = Math.max(0, current.recordedAt - previous.recordedAt);
  return speed === 'fast' ? originalDelay / 10 : originalDelay;
}

export async function replayTimedRecords<T extends { recordedAt: number }>(
  records: AsyncIterable<T>,
  speed: ReplaySpeed,
  onRecord: (record: T) => void | Promise<void>,
  sleep: ReplaySleep = defaultSleep,
): Promise<ReplayResult> {
  let previous: T | null = null;
  let processedRecords = 0;
  for await (const record of records) {
    if (previous !== null) {
      const delay = replayDelay(previous, record, speed);
      if (delay > 0) {
        await sleep(delay);
      }
    }
    await onRecord(record);
    previous = record;
    processedRecords += 1;
  }
  return { processedRecords };
}

export async function replayMarketData(
  options: ReplayMarketDataOptions,
): Promise<ReplayResult> {
  const speed = options.speed ?? 'max';
  const sleep = options.sleep ?? defaultSleep;
  return replayTimedRecords(
    loadMarketQuoteRecords(options.filePath, options.onWarning),
    speed,
    (record) => options.onQuote(record.quote, record.recordedAt),
    sleep,
  );
}
