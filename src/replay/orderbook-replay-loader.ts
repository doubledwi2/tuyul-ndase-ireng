import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import type { OrderBookRecord } from '../recording/orderbook-recorder.js';
import {
  isValidNormalizedOrderBook,
  type NormalizedOrderBook,
  type OrderBookLevel,
} from '../types/orderbook.js';
import type { ReplayWarningHandler } from './replay-loader.js';

function defaultWarningHandler(message: string): void {
  console.warn(`[BOOK REPLAY] ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nullableTimestamp(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function levels(value: unknown): OrderBookLevel[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const parsed: OrderBookLevel[] = [];
  for (const level of value) {
    if (
      !isObject(level) ||
      typeof level.price !== 'number' ||
      typeof level.size !== 'number'
    ) {
      return null;
    }
    parsed.push({ price: level.price, size: level.size });
  }
  return parsed;
}

export function parseOrderBookRecord(value: unknown): OrderBookRecord | null {
  if (
    !isObject(value) ||
    typeof value.recordedAt !== 'number' ||
    !Number.isFinite(value.recordedAt) ||
    value.recordedAt <= 0 ||
    !isObject(value.orderBook)
  ) {
    return null;
  }
  const raw = value.orderBook;
  const bids = levels(raw.bids);
  const asks = levels(raw.asks);
  const exchangeTimestamp = nullableTimestamp(raw.exchangeTimestamp);
  const matchingEngineTimestamp = nullableTimestamp(raw.matchingEngineTimestamp);
  if (
    (raw.exchange !== 'bybit' && raw.exchange !== 'okx') ||
    raw.symbol !== 'BTC/USDT' ||
    bids === null ||
    asks === null ||
    exchangeTimestamp === undefined ||
    matchingEngineTimestamp === undefined ||
    typeof raw.receivedTimestamp !== 'number'
  ) {
    return null;
  }
  const orderBook: NormalizedOrderBook = {
    exchange: raw.exchange,
    symbol: raw.symbol,
    bids,
    asks,
    exchangeTimestamp,
    matchingEngineTimestamp,
    receivedTimestamp: raw.receivedTimestamp,
  };
  return isValidNormalizedOrderBook(orderBook)
    ? { recordedAt: value.recordedAt, orderBook }
    : null;
}

export async function* loadOrderBookRecords(
  filePath: string,
  onWarning: ReplayWarningHandler = defaultWarningHandler,
): AsyncGenerator<OrderBookRecord> {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.trim() === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      onWarning(`Line ${lineNumber} is not valid JSON; skipped.`);
      continue;
    }
    const record = parseOrderBookRecord(parsed);
    if (record === null) {
      onWarning(`Line ${lineNumber} has an invalid order book record; skipped.`);
      continue;
    }
    yield record;
  }
}
