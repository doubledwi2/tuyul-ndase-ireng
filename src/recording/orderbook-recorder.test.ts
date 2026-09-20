import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { NormalizedOrderBook } from '../types/orderbook.js';
import {
  OrderBookRecorder,
  type OrderBookRecord,
} from './orderbook-recorder.js';

function book(exchange: 'bybit' | 'okx', timestamp: number): NormalizedOrderBook {
  return {
    exchange,
    symbol: 'BTC/USDT',
    bids: [{ price: 100, size: 1 }, { price: 99, size: 2 }],
    asks: [{ price: 101, size: 1 }, { price: 102, size: 2 }],
    exchangeTimestamp: timestamp,
    matchingEngineTimestamp: exchange === 'bybit' ? timestamp - 1 : null,
    receivedTimestamp: timestamp,
    receivedMonotonicMs: timestamp / 10,
  };
}

test('order book recorder creates directories and preserves snapshot order', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'orderbook-recorder-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'nested', 'orderbooks.jsonl');
  const recorder = new OrderBookRecorder(file);
  void recorder.record(book('bybit', 1_000), 1_001);
  void recorder.record(book('okx', 1_010), 1_011);
  await recorder.flush();

  const records = (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as OrderBookRecord);
  assert.deepEqual(records.map((record) => record.orderBook.exchange), [
    'bybit',
    'okx',
  ]);
  assert.equal(records[0]?.orderBook.bids.length, 2);
  assert.equal(records[0]?.orderBook.asks.length, 2);
  assert.equal(records[0]?.orderBook.receivedMonotonicMs, 100);
});
