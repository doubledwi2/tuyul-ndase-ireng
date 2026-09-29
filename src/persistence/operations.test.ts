import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireRuntimeLock } from './runtime-lock.js';
import { syncDirectory } from './directory-sync.js';
import { DurablePaperStateStore } from './durable-paper-state.js';
import { LatencyPaperTradingEngine } from '../paper/latency-engine.js';
import type { PaperExecutionEvent } from '../paper/types.js';

const event = { type: 'ORDER', recordedAt: 1, order: {} } as unknown as PaperExecutionEvent;
async function temp(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'tuyul-ops-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('lock rejects active instance and graceful release removes own lock', () => temp(async dir => {
  const lock = await acquireRuntimeLock(dir, () => true);
  await assert.rejects(acquireRuntimeLock(dir, () => true), /locked/);
  await lock.release();
  await assert.rejects(readFile(join(dir, 'state/runtime.lock')), { code: 'ENOENT' });
}));
test('stale PID lock recovered; previous owner cannot remove replacement', () => temp(async dir => {
  const first = await acquireRuntimeLock(dir);
  const second = await acquireRuntimeLock(dir, () => false);
  await assert.rejects(first.release(), /ownership/);
  assert.equal(JSON.parse(await readFile(join(dir, 'state/runtime.lock'), 'utf8')).hostname, hostname());
  await second.release();
}));
test('foreign host and malformed lock fail closed', () => temp(async dir => {
  const first = await acquireRuntimeLock(dir);
  const path = join(dir, 'state/runtime.lock');
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...value, hostname: 'other-host' }));
  await assert.rejects(acquireRuntimeLock(dir, () => false), /unverifiable/);
  await writeFile(path, '{');
  await assert.rejects(acquireRuntimeLock(dir, () => false));
  await writeFile(path, JSON.stringify(value));
  await first.release();
}));
test('directory fsync unsupported is explicit; I/O failures propagate', async () => {
  assert.equal(await syncDirectory('.', async () => { throw Object.assign(new Error(), { code: 'EINVAL' }); }), false);
  await assert.rejects(syncDirectory('.', async () => { throw Object.assign(new Error(), { code: 'EIO' }); }));
});
test('compaction retains monotonically increasing sequence and bounded archives', () => temp(async dataDir => {
  const engine = new LatencyPaperTradingEngine();
  const opened = await DurablePaperStateStore.open({ dataDir, checkpointEveryEvents: 1, compactAfterRecords: 2, maxArchives: 2 });
  opened.store.attachStateProvider(() => engine.exportState());
  for (let i = 0; i < 8; i++) await opened.store.record(event);
  assert.equal(opened.store.getHealth().journalBytes, 0);
  assert.equal((await readdir(join(dataDir, 'state'))).filter(name => /^journal\.\d/.test(name)).length, 2);
  const restored = await DurablePaperStateStore.open({ dataDir });
  assert.deepEqual(restored.recoveredState, engine.exportState());
  assert.equal(restored.store.getHealth().lastJournalSeq, 8);
  restored.store.attachStateProvider(() => engine.exportState());
  await restored.store.record(event);
  assert.equal((await DurablePaperStateStore.open({ dataDir })).store.getHealth().lastJournalSeq, 9);
}));
for (const step of ['beforeCheckpoint', 'afterCheckpoint', 'afterRotate'] as const) {
  test(`compaction crash at ${step} recovers last journaled state`, () => temp(async dataDir => {
    const engine = new LatencyPaperTradingEngine();
    const opened = await DurablePaperStateStore.open({ dataDir, checkpointEveryEvents: 1, compactAfterRecords: 1,
      fault: current => { if (current === step) throw new Error('simulated crash'); } });
    opened.store.attachStateProvider(() => engine.exportState());
    await opened.store.record(event);
    assert.equal(opened.store.getHealth().checkpointHealthy, false);
    const restored = await DurablePaperStateStore.open({ dataDir });
    assert.deepEqual(restored.recoveredState, engine.exportState());
    assert.equal(restored.store.getHealth().lastJournalSeq, 1);
  }));
}
test('repeated checkpoint/recovery loops preserve balances, risk and sequences', () => temp(async dataDir => {
  let engine = new LatencyPaperTradingEngine();
  const expected = engine.exportState();
  for (let iteration = 0; iteration < 6; iteration++) {
    const opened = await DurablePaperStateStore.open({ dataDir, checkpointEveryEvents: 1, compactAfterRecords: 1 });
    if (opened.recoveredState !== null) engine = LatencyPaperTradingEngine.fromState(opened.recoveredState);
    opened.store.attachStateProvider(() => engine.exportState());
    engine.applyRecoveryPolicy(1000 + iteration);
    await opened.store.record(event);
    await opened.store.flushAndCheckpoint();
    const state = engine.exportState();
    assert.deepEqual(state.balances, expected.balances);
    assert.deepEqual(state.riskState, expected.riskState);
    assert.equal(opened.store.getHealth().lastJournalSeq, iteration + 1);
  }
}));
test('missing checkpoint with archives fails closed instead of starting empty', () => temp(async dataDir => {
  const opened = await DurablePaperStateStore.open({ dataDir, checkpointEveryEvents: 1, compactAfterRecords: 1 });
  opened.store.attachStateProvider(() => new LatencyPaperTradingEngine().exportState());
  await opened.store.record(event);
  await rm(opened.store.checkpointPath);
  await assert.rejects(DurablePaperStateStore.open({ dataDir }), /without checkpoint/);
}));

test('byte threshold compacts and pending journal queue drains', () => temp(async dataDir => {
  const opened = await DurablePaperStateStore.open({ dataDir, checkpointEveryEvents: 2, journalMaxBytes: 1 });
  opened.store.attachStateProvider(() => new LatencyPaperTradingEngine().exportState());
  const first = opened.store.record(event);
  const second = opened.store.record(event);
  assert.equal(opened.store.getHealth().queueDepth, 2);
  await Promise.all([first, second]);
  assert.equal(opened.store.getHealth().queueDepth, 0);
  assert.equal(opened.store.getHealth().journalBytes, 0);
  assert.equal(opened.store.getHealth().dirtySince, null);
  assert.equal((await DurablePaperStateStore.open({ dataDir })).store.getHealth().lastJournalSeq, 2);
}));
test('journal sequence gap after a checkpoint fails closed', () => temp(async dataDir => {
  const opened = await DurablePaperStateStore.open({ dataDir });
  opened.store.attachStateProvider(() => new LatencyPaperTradingEngine().exportState());
  await opened.store.checkpoint();
  await opened.store.record(event);
  const raw = JSON.parse(await readFile(opened.store.journalPath, 'utf8')) as Record<string, unknown>;
  await writeFile(opened.store.journalPath, `${JSON.stringify({ ...raw, seq: 2 })}\n`);
  await assert.rejects(DurablePaperStateStore.open({ dataDir }), /sequence gap/);
}));
test('state check and backup are offline, lock-protected and preserve recoverable files', () => temp(async dataDir => {
  const opened = await DurablePaperStateStore.open({ dataDir });
  opened.store.attachStateProvider(() => new LatencyPaperTradingEngine().exportState());
  await opened.store.record(event);
  await opened.store.checkpoint();
  const checkpointBefore = await readFile(opened.store.checkpointPath, 'utf8');
  const run = (mode: string) => promisify(execFile)(process.execPath,
    ['--import', 'tsx', 'src/state-tools.ts', mode], { env: { ...process.env, DATA_DIR: dataDir }, timeout: 15000 });
  const lock = await acquireRuntimeLock(dataDir);
  try { await assert.rejects(run('check'), /locked/); } finally { await lock.release(); }
  assert.match((await run('check')).stdout, /VALID/);
  await run('backup');
  assert.equal(await readFile(opened.store.checkpointPath, 'utf8'), checkpointBefore);
  const archives = await readdir(join(dataDir, 'backups'));
  assert.equal(archives.length, 1);
  const listing = await promisify(execFile)('tar', ['-tzf', join(dataDir, 'backups', archives[0]!)]);
  assert.match(listing.stdout, /state\/checkpoint.json/);
  assert.match(listing.stdout, /state\/journal.jsonl/);
  assert.doesNotMatch(listing.stdout, /runtime.lock|orderbooks/);
  const extracted = await mkdtemp(join(dataDir, 'restore-'));
  await promisify(execFile)('tar', ['-xzf', join(dataDir, 'backups', archives[0]!), '-C', extracted]);
  const restored = await DurablePaperStateStore.open({ dataDir: extracted });
  assert.deepEqual(restored.recoveredState, new LatencyPaperTradingEngine().exportState());
}));
