import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import type { MarketQuoteRecord } from '../recording/market-recorder.js';
import { isValidBestQuote, type BestQuote } from '../types/market.js';

export type ReplayWarningHandler = (message: string) => void;

function defaultWarningHandler(message: string): void {
  console.warn(`[REPLAY] ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function parseBestQuote(value: unknown): BestQuote | null {
  if (!isObject(value)) {
    return null;
  }

  if (
    (value.exchange !== 'bybit' && value.exchange !== 'okx') ||
    value.symbol !== 'BTC/USDT' ||
    typeof value.bid !== 'number' ||
    typeof value.bidSize !== 'number' ||
    typeof value.ask !== 'number' ||
    typeof value.askSize !== 'number' ||
    !isNullableTimestamp(value.exchangeTimestamp) ||
    !isNullableTimestamp(value.matchingEngineTimestamp) ||
    typeof value.receivedTimestamp !== 'number' ||
    !Number.isFinite(value.receivedTimestamp) ||
    value.receivedTimestamp <= 0
  ) {
    return null;
  }

  const quote: BestQuote = {
    exchange: value.exchange,
    symbol: value.symbol,
    bid: value.bid,
    bidSize: value.bidSize,
    ask: value.ask,
    askSize: value.askSize,
    exchangeTimestamp: value.exchangeTimestamp,
    matchingEngineTimestamp: value.matchingEngineTimestamp,
    receivedTimestamp: value.receivedTimestamp,
  };

  return isValidBestQuote(quote) ? quote : null;
}

export function parseMarketQuoteRecord(value: unknown): MarketQuoteRecord | null {
  if (
    !isObject(value) ||
    typeof value.recordedAt !== 'number' ||
    !Number.isFinite(value.recordedAt) ||
    value.recordedAt <= 0
  ) {
    return null;
  }

  const quote = parseBestQuote(value.quote);
  return quote === null ? null : { recordedAt: value.recordedAt, quote };
}

export async function* loadMarketQuoteRecords(
  filePath: string,
  onWarning: ReplayWarningHandler = defaultWarningHandler,
): AsyncGenerator<MarketQuoteRecord> {
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

    const record = parseMarketQuoteRecord(parsed);
    if (record === null) {
      onWarning(`Line ${lineNumber} has an invalid market quote record; skipped.`);
      continue;
    }

    yield record;
  }
}
