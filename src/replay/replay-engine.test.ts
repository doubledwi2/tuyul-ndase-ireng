import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { MarketQuoteRecord } from '../recording/market-recorder.js';
import type { BestQuote } from '../types/market.js';
import { replayMarketData, type ReplaySpeed } from './replay-engine.js';

function quote(exchange: BestQuote['exchange'], timestamp: number): BestQuote {
  return {
    exchange,
    symbol: 'BTC/USDT',
    bid: 100,
    bidSize: 1,
    ask: 101,
    askSize: 1,
    exchangeTimestamp: timestamp,
    matchingEngineTimestamp: null,
    receivedTimestamp: timestamp,
  };
}

async function fixture(
  recordedAtValues: readonly number[],
): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'replay-engine-'));
  const file = join(root, 'quotes.jsonl');
  const records: MarketQuoteRecord[] = recordedAtValues.map((recordedAt, index) => ({
    recordedAt,
    quote: quote(index % 2 === 0 ? 'bybit' : 'okx', 1_000 + index),
  }));
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return { root, file };
}

async function captureReplay(speed: ReplaySpeed, recordedAt: readonly number[]) {
  const temporary = await fixture(recordedAt);
  const delays: number[] = [];
  const order: BestQuote['exchange'][] = [];
  const result = await replayMarketData({
    filePath: temporary.file,
    speed,
    sleep: async (delay) => {
      delays.push(delay);
    },
    onQuote: (value) => {
      order.push(value.exchange);
    },
  });
  await rm(temporary.root, { recursive: true, force: true });
  return { delays, order, result };
}

test('realtime uses recordedAt deltas and preserves quote order', async () => {
  const replay = await captureReplay('realtime', [1_000, 1_015, 1_010, 1_040]);

  assert.deepEqual(replay.delays, [15, 30]);
  assert.deepEqual(replay.order, ['bybit', 'okx', 'bybit', 'okx']);
  assert.equal(replay.result.processedRecords, 4);
});

test('fast applies 10x acceleration', async () => {
  const replay = await captureReplay('fast', [1_000, 1_100, 1_150]);
  assert.deepEqual(replay.delays, [10, 5]);
});

test('max adds no artificial delay', async () => {
  const replay = await captureReplay('max', [1_000, 2_000, 3_000]);
  assert.deepEqual(replay.delays, []);
  assert.deepEqual(replay.order, ['bybit', 'okx', 'bybit']);
});
