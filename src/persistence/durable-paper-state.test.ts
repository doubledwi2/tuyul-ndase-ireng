import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LatencyPaperTradingEngine } from '../paper/latency-engine.js';
import type { PaperExecutionEvent } from '../paper/types.js';
import {
  DurablePaperStateStore,
  type PaperEngineCheckpoint,
} from './durable-paper-state.js';

const EVENT = {
  type: 'ORDER',
  recordedAt: 1,
  order: {},
} as unknown as PaperExecutionEvent;

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tuyul-state-test-'));
}

test('checkpoint plus newer journal records recover deterministically once', async () => {
  const dataDir = await temporaryDirectory();
  try {
    const opened = await DurablePaperStateStore.open({
      dataDir,
      checkpointEveryEvents: 100,
      now: () => 1_000,
    });
    let state = new LatencyPaperTradingEngine().exportState();
    opened.store.attachStateProvider(() => structuredClone(state));
    await opened.store.record(EVENT);
    await opened.store.checkpoint();
    state = { ...state, lastLogicalTimestamp: 123 };
    await opened.store.record({ ...EVENT, recordedAt: 2 });
    await opened.store.flush();

    const recovered = await DurablePaperStateStore.open({ dataDir });
    assert.equal(recovered.replayedJournalRecords, 1);
    assert.equal(recovered.recoveredState?.lastLogicalTimestamp, 123);
    assert.equal(recovered.store.getHealth().lastJournalSeq, 2);

    const repeated = await DurablePaperStateStore.open({ dataDir });
    assert.deepEqual(repeated.recoveredState, recovered.recoveredState);
    assert.equal(repeated.replayedJournalRecords, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('interrupted temporary checkpoint cannot replace the valid checkpoint', async () => {
  const dataDir = await temporaryDirectory();
  try {
    const opened = await DurablePaperStateStore.open({ dataDir });
    const state = new LatencyPaperTradingEngine().exportState();
    opened.store.attachStateProvider(() => state);
    await opened.store.checkpoint();
    await writeFile(`${opened.store.checkpointPath}.tmp`, '{interrupted', 'utf8');

    const recovered = await DurablePaperStateStore.open({ dataDir });
    assert.deepEqual(recovered.recoveredState, state);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('malformed and future-version checkpoints fail closed', async () => {
  const dataDir = await temporaryDirectory();
  const checkpointPath = join(dataDir, 'state', 'checkpoint.json');
  try {
    const opened = await DurablePaperStateStore.open({ dataDir });
    const state = new LatencyPaperTradingEngine().exportState();
    opened.store.attachStateProvider(() => state);
    await opened.store.checkpoint();
    await writeFile(checkpointPath, '{malformed', 'utf8');
    await assert.rejects(
      DurablePaperStateStore.open({ dataDir }),
      /Checkpoint JSON is malformed/,
    );

    const future: Omit<PaperEngineCheckpoint, 'schemaVersion'> & {
      schemaVersion: number;
    } = {
      schemaVersion: 2,
      savedAt: 1,
      lastAppliedJournalSeq: 0,
      engineState: state,
    };
    await writeFile(checkpointPath, JSON.stringify(future), 'utf8');
    await assert.rejects(
      DurablePaperStateStore.open({ dataDir }),
      /schemaVersion/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('duplicate journal sequence is rejected instead of replayed twice', async () => {
  const dataDir = await temporaryDirectory();
  try {
    const opened = await DurablePaperStateStore.open({ dataDir });
    const state = new LatencyPaperTradingEngine().exportState();
    opened.store.attachStateProvider(() => state);
    await opened.store.record(EVENT);
    const journal = await readFile(opened.store.journalPath, 'utf8');
    await writeFile(opened.store.journalPath, `${journal}${journal}`, 'utf8');
    await assert.rejects(
      DurablePaperStateStore.open({ dataDir }),
      /sequence or event integrity/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('journal write failure marks persistence unhealthy', async () => {
  const dataDir = await temporaryDirectory();
  try {
    const opened = await DurablePaperStateStore.open({ dataDir });
    const state = new LatencyPaperTradingEngine().exportState();
    opened.store.attachStateProvider(() => state);
    await opened.store.checkpoint();
    const stateDirectory = join(dataDir, 'state');
    await rm(stateDirectory, { recursive: true, force: true });
    await writeFile(stateDirectory, 'not-a-directory', 'utf8');

    await opened.store.record(EVENT);
    const health = opened.store.getHealth();
    assert.equal(health.journalHealthy, false);
    assert.match(health.lastError ?? '', /ENOTDIR|EEXIST/);
    await opened.store.checkpoint();
    assert.equal(opened.store.getHealth().checkpointHealthy, false);
    assert.equal(opened.store.getHealth().queueDepth, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
