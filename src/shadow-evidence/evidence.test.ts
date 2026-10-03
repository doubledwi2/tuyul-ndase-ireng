import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, appendFile, readdir, access, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionFixture } from '../shadow-execution/fixture.js';
import { EvidenceScenarios } from './scenarios.js';
import { manifest } from './manifest.js';
import { evidenceConfig, latencyProfiles } from './config.js';
import type { EvidenceRecord } from './types.js';
import { EvidenceRecorder, pruneEvidence, MAX_EVIDENCE_QUEUE } from './recorder.js';
import { replayEvidence } from './replay.js';
import { reportEvidence } from './report.js';
import { ShadowEvidenceRuntime } from './runtime.js';
import { EvidenceStatistics } from './statistics.js';
import { PAPER_EXECUTION_CONFIG } from '../config/paper.js';
import { prepareShadowTrigger } from '../shadow-execution/prepared-trigger.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
const T = 1_700_000_000_000;
const temporary = () => mkdtemp(join(tmpdir(), 'tuyul-evidence-test-'));
function scenario(profiles = '25,50,100,200', live = false, options: ConstructorParameters<typeof EvidenceScenarios>[2] = {}) {
  const { event, input } = executionFixture(T);
  const records: EvidenceRecord[] = [];
  const m = manifest('test-run', T, latencyProfiles(profiles), !live);
  const s = new EvidenceScenarios(m, r => records.push(r), options);
  s.trigger(event, () => input);
  function pair(offset: number, sell = 103) {
    for (const ex of ['bybit','okx'] as const) {
      const b = structuredClone(input.books[ex]); b.receivedTimestamp = T + offset;
      if (ex === 'okx') b.bids = [{ price: sell, size: 1 }];
      s.onBook(b, T + offset);
    }
  }
  return { s, input, event, records, m, pair };
}
test('latency config exact identities/baseline/zero and bounded unique profiles', () => {
  assert.deepEqual(latencyProfiles().map(p => p.id), ['L25','L50','L100','L200']);
  assert.equal(latencyProfiles('0,50')[0]!.label, 'ZERO_LATENCY_IDEALIZED');
  assert.equal(latencyProfiles('50')[0]!.label, 'BASELINE_MODELED');
  for (const value of ['', '25,25','-1','1.5','2001','1,2,3,4,5,6,7,8,9',' 25']) assert.throws(() => latencyProfiles(value));
  assert.equal(evidenceConfig({}).enabled, false);
  assert.throws(() => evidenceConfig({ SHADOW_EVIDENCE_ENABLED: 'true' }));
  assert.throws(() => evidenceConfig({ SHADOW_EVIDENCE_RETENTION_DAYS: '0' }));
  assert.deepEqual(PAPER_EXECUTION_CONFIG, { buyOrderLatencyMs: 50, sellOrderLatencyMs: 50, unwindOrderLatencyMs: 50,
    orderTimeoutMs: 250, maxUnhedgedDurationMs: 200, allowPartialFill: true });
});
test('L25/L50 clean; L100/L200 no-fill exact sensitivity', () => {
  const a = scenario(); a.pair(25); a.pair(50); a.s.tick(T + 250);
  assert.deepEqual(a.records.map(r => [r.scenarioId, r.entryOutcome]), [['L25','CLEAN_FILL'],['L50','CLEAN_FILL'],['L100','NO_FILL'],['L200','NO_FILL']]);
  assert.equal(new Set(a.records.map(r => r.evidenceGroupId)).size, 1);
  assert.equal(a.s.summary().latencyDecay['L50->L100']!.cleanToNoFill, 1);
});
test('positive at 25/50, negative at 100, no-fill at 200; no cherry picking', () => {
  const a = scenario(); a.pair(25); a.pair(50); a.pair(100, 99); a.s.tick(T + 250);
  assert.ok(a.records[0]!.finalNetPnl! > 0); assert.ok(a.records[1]!.finalNetPnl! > 0); assert.ok(a.records[2]!.finalNetPnl! < 0);
  assert.equal(a.records[3]!.entryOutcome, 'NO_FILL');
  assert.equal(a.s.summary().latencyDecay['L50->L100']!.positiveToNegative, 1);
  assert.equal(a.s.summary().completeGroups, 1);
});
test('identical ordered book references go to every scenario', () => {
  const seen = new Map<string, NormalizedOrderBook[]>();
  const a = scenario(undefined, false, { onBookObserved: (id, b) => { const list = seen.get(id) ?? []; list.push(b); seen.set(id, list); } });
  a.pair(25); a.pair(50);
  const baseline = seen.get('L50')!;
  for (const stream of seen.values()) for (let i = 0; i < baseline.length; i++) assert.equal(stream[i], baseline[i]);
});
test('one cache read and frozen common fee/funding/rules despite later mutation', () => {
  const { event, input } = executionFixture(T); let calls = 0;
  const records: EvidenceRecord[] = [], m = manifest('freeze', T, latencyProfiles(), false);
  const s = new EvidenceScenarios(m, r => records.push(r));
  s.trigger(event, () => { calls++; return input; }); assert.equal(calls, 1);
  const p = prepareShadowTrigger(event, input); assert.ok(Object.isFrozen(p) && Object.isFrozen(p.rates));
  input.accounts.bybit.fee!.takerFeeRate.normalizedCostRate = .04;
  input.accounts.bybit.balance!.usdt.available = null; input.instrumentRules!.bybit!.instrumentStatus = 'NOT_TRADABLE';
  for (const ex of ['bybit','okx'] as const) { const b = structuredClone(input.books[ex]); b.receivedTimestamp = T + 200; s.onBook(b, T + 200); }
  assert.equal(records.length, 4);
  assert.equal(new Set(records.map(r => JSON.stringify([r.feeRates,r.fundingStatus,r.ruleAdjustedTarget,r.ruleFingerprint]))).size, 1);
  assert.ok(records.every(r => r.feeRates.bybit === .001 && r.cohort === 'ACCOUNT_CALIBRATED'));
});
test('unsafe diagnostic/unknown rules/fallback never account-calibrated; invalid rules do not trigger', () => {
  const { event, input } = executionFixture(T); delete input.instrumentRules;
  input.accounts.okx.feeHealthy = false;
  const rows: EvidenceRecord[] = [], s = new EvidenceScenarios(manifest('market', T, latencyProfiles('50')), r => rows.push(r));
  s.trigger(event, () => input); s.tick(T + 250);
  assert.equal(rows[0]!.cohort, 'MARKET_ONLY'); assert.equal(rows[0]!.ruleStatus, 'UNKNOWN');
  assert.equal(s.summary().splits['fee:MIXED']!.attempts, 1);
  const a = scenario(); a.input.instrumentRules!.bybit!.instrumentStatus = 'NOT_TRADABLE';
  a.s.trigger({ ...a.event, id: 'invalid' }, () => a.input);
  assert.equal(a.s.summary().drops.L50!.NOT_EXECUTABLE_RULES, 1);
});
test('latency at/above timeout expires without instantaneous fabricated fill', () => {
  const a = scenario('0,250,2000'); a.pair(0); a.pair(250); a.s.tick(T + 2500);
  assert.equal(a.records.find(r => r.scenarioId === 'L0')!.outcome, 'CLEAN_FILL');
  for (const id of ['L250','L2000']) assert.equal(a.records.find(r => r.scenarioId === id)!.entryOutcome, 'NO_FILL');
});
test('capacity/diagnostic failure degrades completeness without affecting other scenarios', () => {
  const a = scenario(undefined, false, { maxActive: 1 });
  a.s.trigger({ ...a.event, id: 'capacity' }, () => a.input);
  assert.equal(a.s.summary().capacityRejected, 4); assert.equal(a.s.summary().evidenceComplete, false);
  a.s.trigger({ ...a.event, id: 'broken' }, () => { throw new Error('private content'); });
  assert.equal(a.s.summary().diagnosticFailure, 1); a.s.shutdown(T + 10); assert.equal(a.records.length, 4);
});
test('deterministic MarketPipeline latency replay twice without host time; nonzero full-chain outcomes', async () => {
  const run = async () => { const rows: EvidenceRecord[] = []; const result = await replayEvidence('fixtures/shadow-evidence/latency.jsonl', { onRecord: r => rows.push(r) }); return { rows, result }; };
  const old = Date.now; Date.now = () => { throw new Error('No host clock'); };
  try {
    const a = await run(), b = await run(); assert.deepEqual(a, b);
    assert.equal(a.result.summary.groups, 1); assert.equal(a.rows.length, 4);
    assert.equal(a.result.summary.latencyDecay['L50->L100']!.positiveToNegative, 1);
  } finally { Date.now = old; }
});
test('recorder allowlist excludes private sentinels, flush report and fresh session restart', async () => {
  const root = await temporary(), { input, event } = executionFixture(T);
  Object.assign(input.accounts.bybit, { uid: 'sentinel-uid-28182', ip: '192.0.2.199', fakeKey: 'sentinel-key-919188' });
  input.accounts.bybit.balance!.usdt.available = 987654321.123456; input.accounts.bybit.balance!.usdt.total = 987654321.123456;
  const m = manifest('private-test', T, latencyProfiles(), true), recorder = await EvidenceRecorder.create(root, m);
  const s = new EvidenceScenarios(m, r => recorder.append(r)); s.trigger(event, () => input); s.tick(T + 250);
  await recorder.flush(); await recorder.close({ ...s.summary(), endedAt: T + 250 });
  const text = (await Promise.all((await readdir(recorder.directory)).map(n => readFile(join(recorder.directory,n), 'utf8')))).join('');
  for (const sentinel of ['sentinel-uid-28182','192.0.2.199','sentinel-key-919188','987654321.123456']) assert.ok(!text.includes(sentinel));
  const report = await reportEvidence(root); assert.equal(report.configurations[0]!.records, 4);
  await assert.rejects(EvidenceRecorder.create(root, m), { code: 'EEXIST' });
  const next = await EvidenceRecorder.create(root, manifest('new-session', T + 500, latencyProfiles(), true)); await next.close({ evidenceComplete: true, endedAt: T + 600 });
  assert.equal((await reportEvidence(root)).runCount, 2);
});
test('partial write latches failure; complete records survive and tail reported', async () => {
  const root = await temporary(), a = scenario(); a.pair(50); a.s.tick(T + 250);
  let writes = 0;
  const recorder = await EvidenceRecorder.create(root, a.m, async (h, line) => {
    if (++writes === 2) { await h.writeFile(line.slice(0, 30)); throw new Error('disk error'); }
    await h.writeFile(line);
  });
  for (const r of a.records) recorder.append(r);
  await recorder.flush(); await recorder.close({ endedAt: T + 250, evidenceComplete: recorder.health().evidenceComplete });
  assert.equal(recorder.health().healthy, false); assert.equal(recorder.health().recordsWritten, 1);
  const report = await reportEvidence(root); assert.equal(report.configurations[0]!.records, 1);
  assert.ok(report.configurations[0]!.dataQualityWarnings.includes('TRUNCATED_FINAL_LINE'));
});
test('malformed interior warns, unknown future schema rejects clearly', async () => {
  const root = await temporary(), a = scenario('50'); a.s.tick(T + 250);
  const recorder = await EvidenceRecorder.create(root, a.m); recorder.append(a.records[0]!); await recorder.close({ endedAt: T + 250, evidenceComplete: true });
  await appendFile(join(recorder.directory, 'attempts.jsonl'), 'bad-json\n');
  assert.ok((await reportEvidence(root)).configurations[0]!.dataQualityWarnings.includes('MALFORMED_INTERIOR_RECORD'));
  await appendFile(join(recorder.directory, 'attempts.jsonl'), '{"schemaVersion":2}\n');
  await assert.rejects(reportEvidence(root), /Unsupported evidence schemaVersion/);
});
test('different config fingerprints never blindly merged', async () => {
  const root = await temporary();
  for (const [id,p] of [['a','25,50'],['b','100,200']] as const) {
    const r = await EvidenceRecorder.create(root, manifest(id,T,latencyProfiles(p),true)); await r.close({ endedAt: T + 100, evidenceComplete: true });
  }
  const report = await reportEvidence(root); assert.equal(report.configurations.length, 2); assert.ok(report.warnings.length);
});
test('retention uses injected time; never removes current/recent/unknown/symlink/crashed runs', async () => {
  const root = await temporary();
  for (const [id,at] of [['old',1],['current',1],['recent',T]] as const) {
    const r = await EvidenceRecorder.create(root, manifest(id,at,latencyProfiles(),true)); await r.close({ endedAt: at + 1 });
  }
  await mkdir(join(root,'unknown')); await symlink(join(root,'old'),join(root,'link'));
  const crashed = await EvidenceRecorder.create(root, manifest('crashed',1,latencyProfiles(),true)); await crashed.close({ endedAt: null });
  assert.equal(await pruneEvidence(root, 'current', T, 30), 1);
  await assert.rejects(access(join(root,'old')));
  for (const id of ['current','recent','unknown','crashed']) await access(join(root,id));
});
test('disabled runtime creates no directory and never evaluates context', async () => {
  const root = await temporary(); const r = await ShadowEvidenceRuntime.create(root, evidenceConfig({}));
  r.onOpportunity(executionFixture().event, () => { throw new Error('disabled'); }); await r.shutdown(T);
  assert.deepEqual(await readdir(root), []); assert.equal(r.getHealth().enabled, false);
});
test('startup recorder failure is isolated and health incomplete', async () => {
  const root = await temporary(); await writeFile(join(root,'shadow-evidence'), 'block directory');
  const r = await ShadowEvidenceRuntime.create(root, { enabled: true, profiles: latencyProfiles(), retentionDays: 30 });
  assert.equal(r.getHealth().healthy, false); assert.equal(r.getHealth().evidenceComplete, false); await r.shutdown(T);
});
test('bounded recorder queue refuses overflow and marks evidence incomplete', async () => {
  const root = await temporary(), a = scenario('50'); a.s.tick(T + 250);
  const recorder = await EvidenceRecorder.create(root, a.m);
  for (let i = 0; i < MAX_EVIDENCE_QUEUE + 1; i++) recorder.append(a.records[0]!);
  assert.ok(recorder.health().queueDepth <= MAX_EVIDENCE_QUEUE); assert.equal(recorder.health().evidenceComplete, false);
  await recorder.close({ evidenceComplete: false, endedAt: T + 250 });
});
test('statistics windows and pending group correlation are bounded', () => {
  const a = scenario('50'); a.s.tick(T + 250);
  const stats = new EvidenceStatistics(latencyProfiles('25,50'));
  for (let i = 0; i < 4000; i++) stats.add({ ...a.records[0]!, evidenceGroupId: String(i) });
  assert.equal(stats.summary().incompleteGroups, 1000); assert.equal(stats.summary().incompleteGroupEvictions, 3000);
  assert.equal(stats.summary().splits.aggregate!.timing.samples, 2048);
});
test('evidence/report runtime modules contain no new exchange endpoints or sensitive capability', async () => {
  for (const name of await readdir('src/shadow-evidence')) {
    if (name.endsWith('.test.ts')) continue;
    const source = await readFile(join('src/shadow-evidence', name), 'utf8');
    assert.doesNotMatch(source, /https?:\/\/|signer|API_KEY|API_SECRET|submitOrder|cancelOrder|withdraw|transfer|process\.env\.(?:BYBIT|OKX)/i);
  }
});
test('missing complete records cannot hide behind a clean session summary', async () => {
  const root = await temporary(), a = scenario(); a.pair(50); a.s.tick(T + 250);
  const r = await EvidenceRecorder.create(root, a.m);
  for (const record of a.records) r.append(record);
  await r.flush(); await r.close({ ...a.s.summary(), ...r.health(), endedAt: T + 250 });
  await writeFile(join(r.directory,'attempts.jsonl'), '');
  const report = await reportEvidence(root);
  assert.equal(report.configurations[0]!.evidenceComplete, false);
  assert.ok(report.configurations[0]!.dataQualityWarnings.includes('RECORD_COUNT_MISMATCH'));
});
test('two persisted deterministic replays produce the same records and report', async () => {
  const run = async () => {
    const root = await temporary(); const result = await replayEvidence('fixtures/shadow-evidence/latency.jsonl', { parent: root });
    return { records: await readFile(join(result.directory!, 'attempts.jsonl'),'utf8'), report: await reportEvidence(root) };
  };
  const a = await run(); assert.deepEqual(await run(), a);
  assert.deepEqual(a.report.configurations[0]!.contexts, ['SYNTHETIC_ACCOUNT_CONTEXT']);
});
test('eight profiles cap active attempts at 100 each; shutdown records all accepted attempts', () => {
  const a = scenario('0,25,50,100,200,250,500,2000');
  for (let i = 1; i < 101; i++) a.s.trigger({ ...a.event, id: `cap-${i}` }, () => a.input);
  assert.equal(Object.values(a.s.summary().profiles).reduce((sum,p) => sum + p.activeAttempts,0), 800);
  assert.equal(a.s.summary().capacityRejected, 8); a.s.shutdown(T + 1);
  assert.equal(a.records.length, 800); a.s.tick(T + 5000); a.s.shutdown(T + 5000);
  assert.equal(a.records.length, 800);
});
test('future manifest and summary schema versions are rejected', async () => {
  const root = await temporary(), m = manifest('future',T,latencyProfiles(),true);
  const r = await EvidenceRecorder.create(root, m); await r.close({ schemaVersion: 2, endedAt: T + 1, evidenceComplete: true });
  await assert.rejects(reportEvidence(root), /Unsupported evidence schemaVersion/);
  await writeFile(join(r.directory,'manifest.json'),JSON.stringify({ ...m, schemaVersion: 2 }));
  await assert.rejects(reportEvidence(root), /Unsupported evidence schemaVersion/);
});
