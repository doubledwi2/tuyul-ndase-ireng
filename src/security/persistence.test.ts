import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadPrivateConfig } from './private-config.js';
import { safeJson } from './secrets.js';
import { DurablePaperStateStore, writeAtomicCheckpoint } from '../persistence/durable-paper-state.js';
import { LatencyPaperTradingEngine } from '../paper/latency-engine.js';
import { PaperExecutionRecorder } from '../paper/execution-recorder.js';
import type { PaperExecutionEvent } from '../paper/types.js';
import { getHealthHttpResponse } from '../operations/health-server.js';
import { OperationalStateManager } from '../operations/operational-state.js';

const fake = (part: string) => ['FAKE', part, 'SECRET', '654321'].join('_');
const env = { BYBIT_API_KEY: fake('BYBIT_KEY'), BYBIT_API_SECRET: fake('BYBIT'),
  OKX_API_KEY: fake('OKX_KEY'), OKX_API_SECRET: fake('OKX'), OKX_API_PASSPHRASE: fake('PASSPHRASE') };
const event = { type: 'ORDER', recordedAt: 1, order: {} } as unknown as PaperExecutionEvent;
function absent(text: string) { for (const value of Object.values(env)) assert.ok(!text.includes(value)); }

test('health, metrics and readiness wire serialization redact accidental values', async () => {
  await loadPrivateConfig(env);
  const health = new OperationalStateManager().getHealth(new LatencyPaperTradingEngine().getRiskSummary());
  const polluted = { ...health, diagnostic: { value: env.BYBIT_API_SECRET } };
  for (const path of ['/health', '/metrics', '/ready']) {
    const result = getHealthHttpResponse('GET', path, polluted, { debug: env.OKX_API_SECRET });
    const wire = safeJson(result.body);
    absent(wire);
    if (path !== '/ready') assert.match(wire, /REDACTED/);
  }
});
test('fake configured credentials never enter checkpoint, journal, event or extracted backup', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tuyul-secret-state-'));
  try {
    await loadPrivateConfig(env);
    const engine = new LatencyPaperTradingEngine();
    const { store } = await DurablePaperStateStore.open({ dataDir });
    store.attachStateProvider(() => engine.exportState());
    await store.record(event);
    await store.checkpoint();
    const eventPath = join(dataDir, 'paper-events.jsonl');
    const recorder = new PaperExecutionRecorder(eventPath);
    await recorder.record(event);
    for (const path of [store.checkpointPath, store.journalPath, eventPath]) absent(await readFile(path, 'utf8'));
    const childEnv = { PATH: process.env.PATH, DATA_DIR: dataDir, ...env };
    const backup = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/state-tools.ts', 'backup'], { env: childEnv, timeout: 15000 });
    absent(backup.stdout + backup.stderr);
    const archive = (await readdir(join(dataDir, 'backups'))).find(name => name.endsWith('.tar.gz'))!;
    const extracted = await mkdtemp(join(dataDir, 'extracted-'));
    await promisify(execFile)('tar', ['-xzf', join(dataDir, 'backups', archive), '-C', extracted]);
    for (const name of await readdir(join(extracted, 'state'))) absent(await readFile(join(extracted, 'state', name), 'utf8'));
    const restored = await DurablePaperStateStore.open({ dataDir: extracted });
    assert.deepEqual(restored.recoveredState, engine.exportState());
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
test('accidental secret payload fails persistence instead of mutating durable state', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tuyul-secret-guard-'));
  try {
    await loadPrivateConfig(env);
    const state = new LatencyPaperTradingEngine().exportState();
    const { store } = await DurablePaperStateStore.open({ dataDir });
    store.attachStateProvider(() => state);
    await store.record(event); await store.checkpoint();
    const before = await readFile(store.checkpointPath, 'utf8');
    await assert.rejects(writeAtomicCheckpoint(store.checkpointPath, {
      schemaVersion: 1, savedAt: 1, lastAppliedJournalSeq: 1,
      engineState: { ...state, seenEventIds: [env.BYBIT_API_SECRET] },
    }), /contains a configured secret/);
    assert.equal(await readFile(store.checkpointPath, 'utf8'), before);
    const leakedEvent = { ...event, note: env.OKX_API_SECRET };
    await store.record(leakedEvent);
    assert.equal(store.getHealth().journalHealthy, false);
    absent(await readFile(store.journalPath, 'utf8'));
    let rejected = false;
    const recorder = new PaperExecutionRecorder(join(dataDir, 'rejected.jsonl'), () => { rejected = true; });
    await recorder.record(leakedEvent);
    assert.equal(rejected, true);
    await assert.rejects(readFile(join(dataDir, 'rejected.jsonl')), { code: 'ENOENT' });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
test('state-check remains offline and ignores unusable private credential files', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tuyul-offline-state-'));
  try {
    const { store } = await DurablePaperStateStore.open({ dataDir });
    store.attachStateProvider(() => new LatencyPaperTradingEngine().exportState());
    await store.checkpoint();
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/state-tools.ts', 'check'], {
      env: { PATH: process.env.PATH, DATA_DIR: dataDir, BYBIT_API_KEY_FILE: '/nonexistent/unused' }, timeout: 15000,
    });
    assert.match(result.stdout, /VALID/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
