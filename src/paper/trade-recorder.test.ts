import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PaperTrade } from './types.js';
import {
  createLivePaperTradePath,
  createReplayPaperTradePath,
  PaperTradeRecorder,
  type PaperTradeRecord,
} from './trade-recorder.js';

const TRADE: PaperTrade = {
  id: 'trade-1',
  opportunityEventId: 'event-1',
  symbol: 'BTC/USDT',
  buyExchange: 'bybit',
  sellExchange: 'okx',
  requestedBaseSize: 0.01,
  state: 'FILLED',
  createdAt: 1_000,
  filledAt: 1_000,
  buyAveragePrice: 60_000,
  sellAveragePrice: 60_150,
  buyNotional: 600,
  sellNotional: 601.5,
  buyFee: 0.6,
  sellFee: 0.6015,
  totalFee: 1.2015,
  grossPnl: 1.5,
  netPnl: 0.2985,
  buyFilledSize: 0.01,
  sellFilledSize: 0.01,
  rejectionReason: null,
};

test('paper trade recorder writes append-only JSONL records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-recorder-'));
  const filePath = join(directory, 'trades.jsonl');
  const recorder = new PaperTradeRecorder(filePath);

  await recorder.record(TRADE, 1_001);
  await recorder.record({ ...TRADE, id: 'trade-2' }, 1_002);
  await recorder.flush();

  const records = (await readFile(filePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as PaperTradeRecord);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], { recordedAt: 1_001, trade: TRADE });
  assert.equal(records[1]?.trade.id, 'trade-2');
});

test('paper live and replay paths are isolated and run-specific', () => {
  const live = createLivePaperTradePath(1_000, 'abcdefgh-1234');
  const replay = createReplayPaperTradePath(1_000, 'abcdefgh-1234');
  assert.equal(live, 'data/paper/live-1000-abcdefgh/trades.jsonl');
  assert.equal(
    replay,
    'data/replays/paper-1000-abcdefgh/paper-trades.jsonl',
  );
  assert.notEqual(live, replay);
});
