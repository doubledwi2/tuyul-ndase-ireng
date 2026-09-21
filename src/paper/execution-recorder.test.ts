import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createLivePaperEventPath,
  createReplayPaperEventPath,
  PaperExecutionRecorder,
} from './execution-recorder.js';
import type { PaperExecutionEvent } from './types.js';

test('paper execution recorder preserves append-only order, fill, and trade events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-events-'));
  const filePath = join(directory, 'paper-events.jsonl');
  const recorder = new PaperExecutionRecorder(filePath);
  const orderEvent: PaperExecutionEvent = {
    type: 'ORDER',
    recordedAt: 1_000,
    order: {
      id: 'order-1',
      tradeId: 'trade-1',
      exchange: 'bybit',
      side: 'BUY',
      requestedSize: 0.01,
      filledSize: 0,
      remainingSize: 0.01,
      state: 'SUBMITTED',
      submittedAt: 1_000,
      arrivalAt: 1_050,
      firstFillAt: null,
      completedAt: null,
      averageFillPrice: null,
      notional: 0,
      fee: 0,
      isUnwind: false,
    },
  };
  const fillEvent: PaperExecutionEvent = {
    type: 'FILL',
    recordedAt: 1_050,
    fill: {
      id: 'fill-1',
      orderId: 'order-1',
      tradeId: 'trade-1',
      exchange: 'bybit',
      side: 'BUY',
      timestamp: 1_050,
      size: 0.01,
      averagePrice: 100,
      notional: 1,
      fee: 0.001,
      isUnwind: false,
    },
  };
  await recorder.record(orderEvent);
  await recorder.record(fillEvent);
  await recorder.flush();

  const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
  assert.deepEqual(JSON.parse(lines[0] ?? ''), orderEvent);
  assert.deepEqual(JSON.parse(lines[1] ?? ''), fillEvent);
});

test('live and replay execution event paths are isolated', () => {
  assert.equal(
    createLivePaperEventPath(1_000, 'abcdefgh'),
    'data/paper/live-1000-abcdefgh/paper-events.jsonl',
  );
  assert.equal(
    createReplayPaperEventPath(1_000, 'abcdefgh'),
    'data/replays/paper-1000-abcdefgh/paper-events.jsonl',
  );
});
