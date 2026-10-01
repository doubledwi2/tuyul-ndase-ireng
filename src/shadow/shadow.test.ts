import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { shadowFixture, runShadowFixture } from './fixture.js';
import { evaluateShadow } from './shadow-evaluator.js';
import { ShadowRuntime } from './shadow-runtime.js';
import { ShadowMetrics, SHADOW_METRICS_WINDOW } from './shadow-metrics.js';
import { privateReadConfig, MAX_BALANCE_AGE_MS, MAX_DIAGNOSTIC_AGE_MS } from '../private-read/config.js';
import { LatencyPaperTradingEngine } from '../paper/latency-engine.js';
import { DurablePaperStateStore } from '../persistence/durable-paper-state.js';
import { PaperExecutionRecorder } from '../paper/execution-recorder.js';
import type { PaperExecutionEvent } from '../paper/types.js';

test('lower observed fees flip negative baseline positive; higher fees flip positive baseline negative', () => {
  const { assessments, metrics } = runShadowFixture();
  assert.equal(assessments[0]!.directions[0].economicsStatus, 'SHADOW_POSITIVE');
  assert.ok(assessments[0]!.directions[0].baselineNetPnl! < 0);
  assert.equal(assessments[1]!.directions[0].economicsStatus, 'SHADOW_ZERO_OR_NEGATIVE');
  assert.ok(assessments[1]!.directions[0].baselineNetPnl! > 0);
  assert.equal(metrics.baselineNegativeShadowPositive, 1);
  assert.equal(metrics.baselinePositiveShadowNegative, 1);
});
test('economics matches notional fee formula and spread denominator', () => {
  const d = evaluateShadow(shadowFixture()).directions[0];
  const expected = 1.0015 * (1 - 0.0001) - 1 * (1 + 0.0001);
  assert.ok(Math.abs(d.shadowNetPnl! - expected) < 1e-12);
  assert.ok(Math.abs(d.shadowNetSpread! - expected * 100) < 1e-12);
  assert.ok(Math.abs(d.feeImpactUsdt! - (d.shadowNetPnl! - d.baselineNetPnl!)) < 1e-12);
});
test('OKX rebate remains negative cost and improves economics without reducing upfront funding', () => {
  const input = shadowFixture();
  input.accounts.okx.fee!.takerFeeRate = { rawRate: '0.001', normalizedCostRate: -0.001 };
  input.accounts.okx.balance!.usdt.available = 1;
  const result = evaluateShadow(input);
  assert.ok(result.directions[0].shadowNetPnl! > evaluateShadow(shadowFixture()).directions[0].shadowNetPnl!);
  assert.ok(result.directions[1].fundingReasons.includes('INSUFFICIENT_FUNDS'));
});
for (const offset of [-MAX_DIAGNOSTIC_AGE_MS - 1, 1]) test(`stale/future fees (${offset}) are labeled fallback and degraded`, () => {
  const input = shadowFixture(); input.accounts.bybit.fee!.receivedAt += offset;
  const a = evaluateShadow(input);
  assert.equal(a.feeSourceByExchange.bybit, 'SIMULATION_FALLBACK'); assert.equal(a.degraded, true);
  assert.equal(a.freshness.bybit.fee, false);
});
test('invalid normalized fee cannot generate NaN or claim account calibration', () => {
  const input = shadowFixture(); input.accounts.bybit.fee!.takerFeeRate.normalizedCostRate = NaN;
  const a = evaluateShadow(input); assert.equal(a.feeSourceByExchange.bybit, 'SIMULATION_FALLBACK');
  assert.ok(Number.isFinite(a.directions[0].shadowNetPnl));
});
for (const offset of [-MAX_BALANCE_AGE_MS - 1, 1]) test(`stale/future balance (${offset}) blocks funding but not independent economics`, () => {
  const input = shadowFixture(); input.accounts.bybit.balance!.receivedAt += offset;
  const a = evaluateShadow(input);
  assert.equal(a.directions[0].fundingStatus, 'STALE_BALANCE');
  assert.equal(a.directions[0].economicsStatus, 'SHADOW_POSITIVE');
});
test('Bybit null availability never uses total; UNKNOWN compatibility remains visible', () => {
  const input = shadowFixture(); const b = input.accounts.bybit;
  b.balance!.btc.available = null; b.balance!.usdt.available = null;
  b.compatibility!.value.status = 'UNKNOWN';
  const a = evaluateShadow(input);
  for (const d of a.directions) {
    assert.equal(d.fundingStatus, 'UNKNOWN_AVAILABLE_BALANCE');
    assert.ok(d.fundingReasons.includes('ACCOUNT_COMPATIBILITY_UNKNOWN'));
  }
  assert.equal(b.compatibility!.value.status, 'UNKNOWN');
});
for (const status of ['UNKNOWN', 'INCOMPATIBLE'] as const) test(`account compatibility ${status} blocks funded claim`, () => {
  const input = shadowFixture(); input.accounts.bybit.compatibility!.value.status = status;
  const a = evaluateShadow(input);
  assert.equal(a.directions[0].fundingStatus, status === 'UNKNOWN' ? 'ACCOUNT_COMPATIBILITY_UNKNOWN' : 'ACCOUNT_INCOMPATIBLE');
  assert.equal(a.directions[0].economicsStatus, 'SHADOW_POSITIVE');
});
test('unsafe permission carries review reason; does not alter economics', () => {
  const input = shadowFixture(); input.accounts.okx.permission!.value.status = 'UNSAFE_WRITE_ENABLED';
  const a = evaluateShadow(input); assert.ok(a.reasons.includes('CREDENTIAL_PERMISSION_REVIEW_REQUIRED'));
  assert.equal(a.directions[0].economicsStatus, 'SHADOW_POSITIVE');
});
test('future config and permission snapshots cannot qualify current diagnostics', () => {
  const input = shadowFixture();
  const accounts = { ...input.accounts, bybit: { ...input.accounts.bybit,
    compatibility: { ...input.accounts.bybit.compatibility!, receivedAt: input.evaluatedAt + 1 },
    permission: { ...input.accounts.bybit.permission!, receivedAt: input.evaluatedAt + 1 } } };
  const a = evaluateShadow({ ...input, accounts });
  assert.equal(a.freshness.bybit.config, false); assert.equal(a.freshness.bybit.permission, false);
  assert.equal(a.directions[0].fundingStatus, 'ACCOUNT_COMPATIBILITY_UNKNOWN');
});
test('future/stale books, insufficient depth and unhealthy synchronization are uncertain', () => {
  for (const kind of ['future', 'stale', 'depth', 'sync']) {
    const input = shadowFixture();
    if (kind === 'future') input.books.bybit.receivedTimestamp++;
    if (kind === 'stale') input.books.bybit.receivedTimestamp -= 501;
    if (kind === 'depth') input.books.bybit.asks[0]!.size = 0.001;
    if (kind === 'sync') input.sync.status = 'SYNC_WARMING_UP';
    const a = evaluateShadow(input); assert.equal(a.directions[0].economicsStatus, 'SHADOW_UNCERTAIN');
    if (kind !== 'sync') assert.equal(a.directions[0].shadowNetPnl, null);
  }
});
test('multi-level depth uses existing simulation, not best-price multiplication', () => {
  const input = shadowFixture(); input.books.bybit.asks = [{ price: 100, size: 0.005 }, { price: 101, size: 1 }];
  const a = evaluateShadow(input);
  const expected = 1.0015 * 0.9999 - 1.005 * 1.0001;
  assert.ok(Math.abs(a.directions[0].shadowNetPnl! - expected) < 1e-12);
});
test('funding checks available amounts, not totals', () => {
  const input = shadowFixture(); input.accounts.bybit.balance!.usdt.available = 0;
  assert.equal(evaluateShadow(input).directions[0].fundingStatus, 'INSUFFICIENT_FUNDS');
});
test('metrics distributions stay bounded; counter units are evaluation or direction as documented', () => {
  const metrics = new ShadowMetrics(), a = evaluateShadow(shadowFixture());
  for (let i = 0; i < SHADOW_METRICS_WINDOW; i++) metrics.record(a);
  const m = metrics.summary(); assert.equal(m.shadowNetPnl.count, SHADOW_METRICS_WINDOW);
  assert.equal(m.feeImpactUsdt.count, SHADOW_METRICS_WINDOW);
  assert.equal(m.shadowEvaluations, SHADOW_METRICS_WINDOW); assert.equal(m.fundedBothDirections, SHADOW_METRICS_WINDOW);
  assert.ok(m.shadowNetPnl.P99! <= m.shadowNetPnl.max!);
});
test('fixture replay is deterministic without Date.now; inputs and paper state unmodified', () => {
  const engine = new LatencyPaperTradingEngine(), before = engine.exportState();
  const input = shadowFixture(), copy = structuredClone(input), original = Date.now;
  Date.now = () => { throw new Error('Host clock forbidden'); };
  try { assert.deepEqual(runShadowFixture(), runShadowFixture()); evaluateShadow(input); }
  finally { Date.now = original; }
  assert.deepEqual(input, copy); assert.deepEqual(engine.exportState(), before);
});
test('disabled shadow does not evaluate or increment metrics; no recorder created', () => {
  const runtime = new ShadowRuntime(false);
  assert.equal(runtime.evaluate(shadowFixture()), null); assert.equal(runtime.getMetrics().shadowEvaluations, 0);
  assert.equal(runtime.getHealth(100).status, 'DISABLED');
});
test('health warms up and degrades when evaluations stop; no account or economics amounts', () => {
  const runtime = new ShadowRuntime(true), input = shadowFixture();
  assert.equal(runtime.getHealth(input.evaluatedAt).status, 'WARMING_UP');
  runtime.evaluate(input); assert.equal(runtime.getHealth(input.evaluatedAt).status, 'ACTIVE');
  assert.equal(runtime.getHealth(input.evaluatedAt + 501).status, 'DEGRADED');
  assert.doesNotMatch(JSON.stringify(runtime.getHealth(input.evaluatedAt)), /total|available|NetPnl|rawRate/);
});
test('shadow enabled without private reads fails config; flag is strict and default disabled', () => {
  assert.throws(() => privateReadConfig({ SHADOW_MODE_ENABLED: 'true', PRIVATE_READ_ENABLED: 'false' }));
  assert.throws(() => privateReadConfig({ SHADOW_MODE_ENABLED: 'yes' }));
  assert.doesNotThrow(() => privateReadConfig({}));
  assert.doesNotThrow(() => privateReadConfig({ SHADOW_MODE_ENABLED: 'true', PRIVATE_READ_ENABLED: 'true' }));
});
test('shadow production layer contains no networking, auth, order calls or wall-clock decisions', async () => {
  for (const file of await readdir('src/shadow')) {
    if (file.endsWith('.test.ts')) continue;
    const source = await readFile(join('src/shadow', file), 'utf8');
    assert.doesNotMatch(source, /\bfetch\b|\bWebSocket\b|https?:\/\/|signer|credentials|submitOrder|cancelOrder|withdraw|transfer|Date\.now/);
  }
});
test('private balances/metadata never enter derived results, paper events, checkpoint, journal or backup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shadow-privacy-'));
  try {
    const input = shadowFixture();
    const marker = 'private-marker-564738291'; const amount = 876543.21987;
    Object.assign(input.accounts.bybit.balance!, { apiKey: marker, uid: marker, ip: marker, note: marker });
    input.accounts.bybit.balance!.btc.total = amount; input.accounts.bybit.balance!.usdt.total = amount;
    input.accounts.bybit.balance!.btc.available = amount; input.accounts.bybit.balance!.usdt.available = amount;
    const runtime = new ShadowRuntime(true), assessment = runtime.evaluate(input);
    const engine = new LatencyPaperTradingEngine(); const { store } = await DurablePaperStateStore.open({ dataDir: dir });
    const recorder = new PaperExecutionRecorder(join(dir, 'paper.jsonl'));
    store.attachStateProvider(() => engine.exportState());
    const event = { type: 'ORDER', recordedAt: input.evaluatedAt, order: {} } as unknown as PaperExecutionEvent;
    await store.record(event); await recorder.record(event); await recorder.flush(); await store.checkpoint();
    await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/state-tools.ts', 'backup'], {
      env: { PATH: process.env.PATH, DATA_DIR: dir }, timeout: 15000 });
    const archive = (await readdir(join(dir, 'backups'))).find(f => f.endsWith('.tar.gz'))!;
    const backup = await promisify(execFile)('tar', ['-xOzf', join(dir, 'backups', archive)]);
    const outputs = [JSON.stringify(assessment), JSON.stringify(runtime.getMetrics()), JSON.stringify(runtime.getHealth(input.evaluatedAt)),
      await readFile(store.checkpointPath, 'utf8'), await readFile(store.journalPath, 'utf8'), await readFile(join(dir, 'paper.jsonl'), 'utf8'), backup.stdout];
    for (const output of outputs) { assert.ok(!output.includes(marker)); assert.ok(!output.includes(String(amount))); }
    assert.ok(!(await readdir(dir)).includes('shadow')); // Optional recorder deliberately not implemented.
  } finally { await rm(dir, { recursive: true, force: true }); }
});
