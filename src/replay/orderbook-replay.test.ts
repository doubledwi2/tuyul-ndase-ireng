import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { OrderBookRecord } from '../recording/orderbook-recorder.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import { replayOrderBooks } from './orderbook-replay-engine.js';
import { loadOrderBookRecords } from './orderbook-replay-loader.js';

function book(exchange: 'bybit' | 'okx', timestamp: number): NormalizedOrderBook {
  return {
    exchange,
    symbol: 'BTC/USDT',
    bids: [{ price: 100, size: 1 }],
    asks: [{ price: 101, size: 1 }],
    exchangeTimestamp: timestamp,
    matchingEngineTimestamp: null,
    receivedTimestamp: timestamp,
  };
}

async function fixture(lines: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), 'orderbook-replay-'));
  const file = join(root, 'orderbooks.jsonl');
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return { root, file };
}

test('order book loader skips blank, malformed, and invalid records', async (context) => {
  const valid: OrderBookRecord = { recordedAt: 1_000, orderBook: book('bybit', 999) };
  const invalid = {
    recordedAt: 1_010,
    orderBook: { ...book('okx', 1_009), asks: [{ price: 101, size: 0 }] },
  };
  const temporary = await fixture([
    '',
    '{bad-json',
    JSON.stringify(invalid),
    JSON.stringify(valid),
  ]);
  context.after(() => rm(temporary.root, { recursive: true, force: true }));
  const warnings: string[] = [];
  const loaded: OrderBookRecord[] = [];
  for await (const record of loadOrderBookRecords(
    temporary.file,
    (warning) => warnings.push(warning),
  )) {
    loaded.push(record);
  }
  assert.deepEqual(loaded, [valid]);
  assert.equal(warnings.length, 2);
});

test('order book replay preserves order and recordedAt timing', async (context) => {
  const records: OrderBookRecord[] = [
    { recordedAt: 1_000, orderBook: book('bybit', 999) },
    { recordedAt: 1_050, orderBook: book('okx', 1_049) },
    { recordedAt: 1_070, orderBook: book('bybit', 1_069) },
  ];
  const temporary = await fixture(records.map((record) => JSON.stringify(record)));
  context.after(() => rm(temporary.root, { recursive: true, force: true }));
  const delays: number[] = [];
  const exchanges: string[] = [];
  const result = await replayOrderBooks({
    filePath: temporary.file,
    speed: 'realtime',
    sleep: async (delay) => {
      delays.push(delay);
    },
    onOrderBook: (orderBook) => {
      exchanges.push(orderBook.exchange);
    },
  });
  assert.deepEqual(delays, [50, 20]);
  assert.deepEqual(exchanges, ['bybit', 'okx', 'bybit']);
  assert.equal(result.processedRecords, 3);
});

test('order book loader preserves optional monotonic timestamp', async (context) => {
  const record: OrderBookRecord = {
    recordedAt: 2_000,
    orderBook: {
      ...book('bybit', 1_999),
      receivedMonotonicMs: 42.25,
    },
  };
  const temporary = await fixture([JSON.stringify(record)]);
  context.after(() => rm(temporary.root, { recursive: true, force: true }));
  const loaded: OrderBookRecord[] = [];
  for await (const value of loadOrderBookRecords(temporary.file)) {
    loaded.push(value);
  }
  assert.equal(loaded[0]?.orderBook.receivedMonotonicMs, 42.25);
});
