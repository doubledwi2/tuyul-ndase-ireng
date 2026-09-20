import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { BestQuote } from '../types/market.js';
import {
  MarketRecorder,
  type MarketQuoteRecord,
} from './market-recorder.js';

function quote(exchange: BestQuote['exchange'], timestamp: number): BestQuote {
  return {
    exchange,
    symbol: 'BTC/USDT',
    bid: 60_000 + timestamp,
    bidSize: 1.25,
    ask: 60_001 + timestamp,
    askSize: 0.75,
    exchangeTimestamp: timestamp,
    matchingEngineTimestamp: exchange === 'bybit' ? timestamp - 1 : null,
    receivedTimestamp: timestamp,
  };
}

async function temporaryPath(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'market-recorder-'));
  return { root, file: join(root, 'nested', 'quotes.jsonl') };
}

test('creates the directory and appends valid JSONL records', async (context) => {
  const temporary = await temporaryPath();
  context.after(() => rm(temporary.root, { recursive: true, force: true }));
  const recorder = new MarketRecorder(temporary.file);

  await recorder.record(quote('bybit', 1_000), 1_001);

  const line = (await readFile(temporary.file, 'utf8')).trim();
  assert.doesNotThrow(() => JSON.parse(line));
});

test('preserves quote order and complete BestQuote fields', async (context) => {
  const temporary = await temporaryPath();
  context.after(() => rm(temporary.root, { recursive: true, force: true }));
  const recorder = new MarketRecorder(temporary.file);
  const first = quote('bybit', 1_000);
  const second = quote('okx', 1_010);

  void recorder.record(first, 1_001);
  void recorder.record(second, 1_011);
  await recorder.flush();

  const records = (await readFile(temporary.file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as MarketQuoteRecord);
  assert.deepEqual(records.map((record) => record.quote.exchange), ['bybit', 'okx']);
  assert.deepEqual(records[0], { recordedAt: 1_001, quote: first });
  assert.deepEqual(Object.keys(records[0]?.quote ?? {}).sort(), [
    'ask',
    'askSize',
    'bid',
    'bidSize',
    'exchange',
    'exchangeTimestamp',
    'matchingEngineTimestamp',
    'receivedTimestamp',
    'symbol',
  ]);
});

test('does not overwrite an existing market file', async (context) => {
  const temporary = await temporaryPath();
  context.after(() => rm(temporary.root, { recursive: true, force: true }));
  const recorder = new MarketRecorder(temporary.file);
  await recorder.record(quote('bybit', 1_000), 1_001);
  const initial = await readFile(temporary.file, 'utf8');
  await writeFile(temporary.file, initial, 'utf8');

  await recorder.record(quote('okx', 1_010), 1_011);

  const lines = (await readFile(temporary.file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
});

test('flush waits for all pending market writes', async (context) => {
  const temporary = await temporaryPath();
  context.after(() => rm(temporary.root, { recursive: true, force: true }));
  const recorder = new MarketRecorder(temporary.file);

  for (let index = 0; index < 20; index += 1) {
    void recorder.record(quote(index % 2 === 0 ? 'bybit' : 'okx', 1_000 + index), 2_000 + index);
  }
  await recorder.flush();

  const lines = (await readFile(temporary.file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 20);
});
