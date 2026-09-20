import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { OpportunityEvent } from '../scanner/opportunity.js';
import {
  EventRecorder,
  type OpportunityEventRecord,
} from './event-recorder.js';

function event(id: string, state: OpportunityEvent['state'] = 'DETECTED'): OpportunityEvent {
  const completed = state === 'DISAPPEARED';
  return {
    id,
    symbol: 'BTC/USDT',
    buyExchange: 'bybit',
    sellExchange: 'okx',
    state,
    detectedAt: 100,
    updatedAt: completed ? 200 : 100,
    endedAt: completed ? 200 : null,
    lifetimeMs: completed ? 100 : null,
    initialGrossSpreadPercent: 0.01,
    currentGrossSpreadPercent: completed ? 0 : 0.01,
    peakGrossSpreadPercent: 0.02,
    initialGrossSpreadAbsolute: 1,
    currentGrossSpreadAbsolute: completed ? 0 : 1,
    peakGrossSpreadAbsolute: 2,
    initialEstimatedNetSpreadPercent: 0.008,
    currentEstimatedNetSpreadPercent: completed ? -0.002 : 0.008,
    peakEstimatedNetSpreadPercent: 0.012,
    initialEstimatedNetPnlAbsolute: 0.8,
    currentEstimatedNetPnlAbsolute: completed ? -0.2 : 0.8,
    peakEstimatedNetPnlAbsolute: 1.2,
    currentEstimatedTotalFee: 0.2,
    targetBaseSize: 0.01,
    buyAverageExecutionPrice: 100.1,
    sellAverageExecutionPrice: 100.2,
    buySlippagePercent: 0.01,
    sellSlippagePercent: -0.01,
    simulatedBuyNotional: 1.001,
    simulatedSellNotional: 1.002,
    currentTradableSize: 0.3,
    peakTradableSize: 0.5,
    currentReceiveTimeDifferenceMs: 10,
    everActive: true,
    everInvalidSync: false,
  };
}

async function temporaryPath(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'opportunity-recorder-'));
  return { root, file: join(root, 'nested', 'events.jsonl') };
}

test('creates the data directory automatically', async (context) => {
  const temporary = await temporaryPath();
  context.after(() => rm(temporary.root, { recursive: true, force: true }));
  const recorder = new EventRecorder(temporary.file);

  await recorder.record(event('one'), 1_000);

  const content = await readFile(temporary.file, 'utf8');
  assert.notEqual(content, '');
});

test('appends one valid JSON object per line', async (context) => {
  const temporary = await temporaryPath();
  context.after(() => rm(temporary.root, { recursive: true, force: true }));
  const recorder = new EventRecorder(temporary.file);

  await recorder.record(event('one'), 1_000);
  await recorder.record(event('two'), 2_000);

  const lines = (await readFile(temporary.file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});

test('preserves event write order', async (context) => {
  const temporary = await temporaryPath();
  context.after(() => rm(temporary.root, { recursive: true, force: true }));
  const recorder = new EventRecorder(temporary.file);

  void recorder.record(event('first'), 1);
  void recorder.record(event('second'), 2);
  void recorder.record(event('third'), 3);
  await recorder.flush();

  const records = (await readFile(temporary.file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as OpportunityEventRecord);
  assert.deepEqual(
    records.map((record) => record.event.id),
    ['first', 'second', 'third'],
  );
});

test('does not overwrite an existing event file', async (context) => {
  const temporary = await temporaryPath();
  context.after(() => rm(temporary.root, { recursive: true, force: true }));
  const recorder = new EventRecorder(temporary.file);
  await recorder.record(event('existing'), 1);
  const firstContent = await readFile(temporary.file, 'utf8');

  await writeFile(temporary.file, firstContent, 'utf8');
  await recorder.record(event('new'), 2);

  const lines = (await readFile(temporary.file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(
    (JSON.parse(lines[0] ?? '') as OpportunityEventRecord).event.id,
    'existing',
  );
});

test('flush waits for all pending writes', async (context) => {
  const temporary = await temporaryPath();
  context.after(() => rm(temporary.root, { recursive: true, force: true }));
  const recorder = new EventRecorder(temporary.file);

  for (let index = 0; index < 20; index += 1) {
    void recorder.record(event(String(index)), index);
  }
  await recorder.flush();

  const lines = (await readFile(temporary.file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 20);
});
