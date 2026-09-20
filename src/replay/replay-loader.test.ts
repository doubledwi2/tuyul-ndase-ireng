import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { BestQuote } from '../types/market.js';
import { loadMarketQuoteRecords } from './replay-loader.js';

function quote(exchange: BestQuote['exchange'], timestamp: number): BestQuote {
  return {
    exchange,
    symbol: 'BTC/USDT',
    bid: 100,
    bidSize: 1,
    ask: 101,
    askSize: 2,
    exchangeTimestamp: timestamp,
    matchingEngineTimestamp: null,
    receivedTimestamp: timestamp,
  };
}

async function fixture(lines: readonly string[]): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'replay-loader-'));
  const file = join(root, 'quotes.jsonl');
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return { root, file };
}

test('loads valid records in file order and skips blank lines', async (context) => {
  const records = [
    { recordedAt: 1_001, quote: quote('bybit', 1_000) },
    { recordedAt: 1_011, quote: quote('okx', 1_010) },
  ];
  const temporary = await fixture([
    JSON.stringify(records[0]),
    '',
    '   ',
    JSON.stringify(records[1]),
  ]);
  context.after(() => rm(temporary.root, { recursive: true, force: true }));
  const loaded = [];

  for await (const record of loadMarketQuoteRecords(temporary.file)) {
    loaded.push(record);
  }

  assert.deepEqual(loaded, records);
});

test('warns and skips malformed JSON and invalid quote records', async (context) => {
  const valid = { recordedAt: 1_021, quote: quote('bybit', 1_020) };
  const invalid = {
    recordedAt: 1_011,
    quote: { ...quote('okx', 1_010), askSize: 0 },
  };
  const temporary = await fixture([
    '{not-json',
    JSON.stringify(invalid),
    JSON.stringify(valid),
  ]);
  context.after(() => rm(temporary.root, { recursive: true, force: true }));
  const warnings: string[] = [];
  const loaded = [];

  for await (const record of loadMarketQuoteRecords(
    temporary.file,
    (message) => warnings.push(message),
  )) {
    loaded.push(record);
  }

  assert.equal(warnings.length, 2);
  assert.deepEqual(loaded, [valid]);
});

test('quote loader preserves optional monotonic timestamp', async (context) => {
  const record = {
    recordedAt: 2_001,
    quote: { ...quote('okx', 2_000), receivedMonotonicMs: 99.5 },
  };
  const temporary = await fixture([JSON.stringify(record)]);
  context.after(() => rm(temporary.root, { recursive: true, force: true }));
  const loaded = [];
  for await (const value of loadMarketQuoteRecords(temporary.file)) {
    loaded.push(value);
  }
  assert.equal(loaded[0]?.quote.receivedMonotonicMs, 99.5);
});
