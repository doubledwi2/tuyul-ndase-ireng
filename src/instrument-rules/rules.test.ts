import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { decimal, onStep, quantize, commonExecutableQuantity, normalizeHypotheticalOrder } from './rounding.js';
import { ruleFixture } from './fixture.js';
import { assessCrossVenueRules, assessOrderRules } from './validator.js';
import { parseInstrumentRules, RuleError } from './parsers.js';
import { instrumentRulesConfig } from './config.js';
import { InstrumentRulesCollector } from './collector.js';
import { publicTransport, PUBLIC_ENDPOINTS, type RequestKind } from './client.js';
import { evaluateShadow } from '../shadow/shadow-evaluator.js';
import { executionFixture } from '../shadow-execution/fixture.js';
import { ShadowExecutionEngine } from '../shadow-execution/shadow-execution-engine.js';
import { RuleCalibrationMetrics } from './metrics.js';

const T = 1_700_000_000_000;
const payloads = { bybit: JSON.parse(await readFile('fixtures/instrument-rules/bybit.json', 'utf8')),
  okx: JSON.parse(await readFile('fixtures/instrument-rules/okx.json', 'utf8')) };
function rules() { return { bybit: ruleFixture('bybit', T), okx: ruleFixture('okx', T) }; }
const notionals = () => ({ bybit: 100, okx: 101 });
test('decimal non-binary fraction uses exact integer step checks', () => {
  assert.ok(onStep('0.01000', decimal('0.00001')));
  assert.equal(onStep('0.010001', decimal('0.00001')), false);
  assert.equal(quantize('0.010009', decimal('0.00001')), '0.010000');
  assert.equal(onStep(0.1 + 0.2, decimal('0.1')), false);
});
test('explicit scientific expansion and malformed decimals', () => {
  assert.deepEqual(decimal('1e-5'), { raw: '1e-5', units: 1n, scale: 5 });
  assert.equal(decimal('1.2e2').units, 120n);
  for (const s of ['NaN', 'Infinity', '-1', '1x', '0x10', '', ' 1', '1e9999', '1.2.3']) assert.throws(() => decimal(s));
});
test('different steps intersection floors target identically for both venues', () => {
  assert.equal(commonExecutableQuantity(0.01057, ruleFixture('bybit', T, '0.001'), ruleFixture('okx', T, '0.0001')), 0.01);
});
test('awkward step intersection uses LCM not maximum step or independent floors', () => {
  const a = ruleFixture('bybit', T, '0.0006'), b = ruleFixture('okx', T, '0.0004');
  assert.equal(commonExecutableQuantity(0.01057, a, b), 0.0096);
  assert.ok(onStep(0.0096, a.quantityStep) && onStep(0.0096, b.quantityStep));
});
test('minimum quantity rejects, no automatic upsizing', () => {
  const r = rules(); r.okx.minQuantity = 0.02; r.okx.exact.minQuantity = decimal('0.02');
  assert.equal(commonExecutableQuantity(0.01, r.bybit, r.okx), null);
  const a = assessCrossVenueRules(0.01, r, T, notionals);
  assert.equal(a.status, 'NOT_EXECUTABLE'); assert.ok(a.okx.reasons.includes('BELOW_MIN_QUANTITY'));
});
test('above maximum target rejects even if rounding would lower it', () => {
  const r = rules(); r.bybit.maxQuantity = 0.01; r.bybit.exact.maxQuantity = decimal('0.01');
  assert.equal(commonExecutableQuantity(0.010009, r.bybit, r.okx), null);
  assert.ok(assessCrossVenueRules(0.010009, r, T, notionals).bybit.reasons.includes('ABOVE_MAX_QUANTITY'));
});
test('minimum/maximum notionals apply to both simulated sides', () => {
  const r = rules(); r.bybit.exact.minNotional = decimal('5'); r.okx.exact.maxNotional = decimal('10');
  const a = assessCrossVenueRules(0.01, r, T, () => ({ bybit: 4, okx: 11 }));
  assert.equal(a.status, 'NOT_EXECUTABLE');
  assert.ok(a.bybit.reasons.includes('BELOW_MIN_NOTIONAL')); assert.ok(a.okx.reasons.includes('ABOVE_MAX_NOTIONAL'));
});
test('suspended instrument invalid; unknown status unknown', () => {
  const r = rules(); r.bybit.instrumentStatus = 'NOT_TRADABLE';
  assert.equal(assessCrossVenueRules(0.01, r, T, notionals).status, 'NOT_EXECUTABLE');
  r.bybit.instrumentStatus = 'UNKNOWN';
  assert.equal(assessCrossVenueRules(0.01, r, T, notionals).status, 'UNKNOWN');
});
for (const [offset, reason] of [[-900001, 'RULE_STALE'], [1, 'RULE_FUTURE']] as const) {
  test(`no stale/future verification: ${reason}`, () => {
    const r = rules(); r.bybit.receivedAt += offset;
    const a = assessCrossVenueRules(0.01, r, T, notionals);
    assert.equal(a.status, 'UNKNOWN'); assert.ok(a.bybit.reasons.includes(reason)); assert.equal(a.commonQuantity, null);
  });
}
test('missing source, missing notional, USD conversion and direct step mismatch explicit', () => {
  const r = rules();
  assert.equal(assessCrossVenueRules(0.01, { ...r, okx: null }, T, notionals).status, 'UNKNOWN');
  assert.equal(assessCrossVenueRules(0.01, r, T, () => ({ bybit: null, okx: null })).status, 'UNKNOWN');
  r.okx.maxNotionalUsd = decimal('1000000');
  assert.ok(assessCrossVenueRules(0.01, r, T, notionals).okx.reasons.includes('USD_CONVERSION_UNAVAILABLE'));
  assert.ok(assessOrderRules('bybit', r.bybit, T, 0.01, 0.000001, 100).reasons.includes('STEP_MISMATCH'));
});
test('market has no invented price, limit conservative policies and original values', () => {
  const r = rules().bybit;
  const market = normalizeHypotheticalOrder(r, 'bybit', 'BUY', 0.010009, 'MARKET');
  assert.equal(market.normalizedPrice, null); assert.equal(market.originalQuantity, 0.010009); assert.equal(market.normalizedQuantity, 0.01);
  assert.equal(normalizeHypotheticalOrder(r, 'bybit', 'BUY', 0.01, 'LIMIT', 100.019).normalizedPrice, 100.01);
  assert.equal(normalizeHypotheticalOrder(r, 'bybit', 'SELL', 0.01, 'LIMIT', 100.019).normalizedPrice, 100.02);
});
test('official schema fixtures: Bybit deprecated filters ignored; OKX market cap is USDT not BTC', () => {
  const b = parseInstrumentRules('bybit', payloads.bybit, T), o = parseInstrumentRules('okx', payloads.okx, T);
  assert.equal(b.maxQuantity, 41.5); assert.equal(b.minQuantity, null); assert.equal(b.minNotional, 5); assert.equal(b.maxNotional, null);
  assert.equal(o.maxQuantity, null); assert.equal(o.maxNotional, 1_000_000); assert.equal(o.minNotional, null); assert.equal(o.minQuantity, 0.00001);
});
test('schema drift, wrong symbol/type, malformed required constraints fail closed', () => {
  for (const value of [null, {}, { retCode: 0, result: { category: 'linear', list: [] } }]) assert.throws(() => parseInstrumentRules('bybit', value, T), /SCHEMA/);
  const b = structuredClone(payloads.bybit); delete b.result.list[0].lotSizeFilter.maxMarketOrderQty;
  assert.throws(() => parseInstrumentRules('bybit', b, T), /SCHEMA/);
  const o = structuredClone(payloads.okx); o.data[0].lotSz = '0';
  assert.throws(() => parseInstrumentRules('okx', o, T), /SCHEMA/);
  o.data[0].lotSz = '1e-8'; o.data[0].instId = 'ETH-USDT';
  assert.throws(() => parseInstrumentRules('okx', o, T), /SCHEMA/);
});
test('collector cache survives schema failure then expires; refresh isolated, no body leaked', async () => {
  let time = T, fail = false;
  const c = new InstrumentRulesCollector({ enabled: true, pollIntervalMs: 300000 }, async kind => {
    if (fail && kind === 'BYBIT_SPOT_INSTRUMENT') return {};
    return kind === 'BYBIT_SPOT_INSTRUMENT' ? payloads.bybit : payloads.okx;
  }, () => time);
  await c.pollOnce(); assert.equal(c.getMetrics().successes, 2);
  const previous = c.getSnapshots().bybit;
  fail = true; time += 100; await c.pollOnce();
  assert.deepEqual(c.getSnapshots().bybit, previous); assert.equal(c.getHealth().bybit.lastError?.category, 'SCHEMA');
  assert.equal(c.getHealth().okx.lastSuccessAt, time);
  time += 900001; assert.equal(c.getHealth().bybitFresh, false);
  assert.equal(c.getHealth().bybitStatus, 'UNKNOWN'); await c.stop();
});
test('collector retries transient only once and coalesces concurrent polls', async () => {
  const calls: RequestKind[] = [];
  const c = new InstrumentRulesCollector({ enabled: true, pollIntervalMs: 300000 }, async kind => {
    calls.push(kind); throw new RuleError('HTTP', 503, true);
  }, () => T);
  await Promise.all([c.pollOnce(), c.pollOnce()]); assert.equal(calls.length, 4);
  assert.equal(c.getMetrics().failures, 4); await c.stop();
});
test('disabled collector performs zero requests; config validated', async () => {
  const c = new InstrumentRulesCollector({ enabled: false, pollIntervalMs: 300000 }, async () => { throw new Error('must not run'); });
  c.start(); await c.pollOnce(); await c.stop(); assert.equal(c.getMetrics().requests, 0);
  assert.equal(instrumentRulesConfig({}).enabled, true);
  for (const raw of ['', '0', '29999', '900001', 'NaN']) assert.throws(() => instrumentRulesConfig({ INSTRUMENT_RULES_POLL_INTERVAL_MS: raw }));
  assert.throws(() => instrumentRulesConfig({ INSTRUMENT_RULES_ENABLED: '1' }));
});
test('public transport only hardcoded GET URLs, no auth, redirects error, bounded body and sanitized errors', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, PUBLIC_ENDPOINTS.BYBIT_SPOT_INSTRUMENT); assert.equal(options?.method, 'GET');
      assert.equal(options?.redirect, 'error'); assert.equal(options?.headers, undefined);
      return new Response(JSON.stringify(payloads.bybit));
    };
    await publicTransport('BYBIT_SPOT_INSTRUMENT');
    await assert.rejects(publicTransport('ARBITRARY' as RequestKind), /SCHEMA/);
    globalThis.fetch = async () => new Response('x'.repeat(1_048_577));
    await assert.rejects(publicTransport('OKX_SPOT_INSTRUMENT'), /BODY_LIMIT/);
    globalThis.fetch = async () => { throw new Error('sensitive arbitrary response'); };
    await assert.rejects(publicTransport('OKX_SPOT_INSTRUMENT'), { message: 'NETWORK' });
  } finally { globalThis.fetch = original; }
});
test('unknown rules continue configured-target degraded; known invalid rejects', () => {
  const { input, event } = executionFixture(); delete input.instrumentRules;
  const a = new ShadowExecutionEngine({ enabled: true }).trigger(event, input).attempt!;
  assert.equal(a.targetBtcSize, event.targetBaseSize); assert.ok(a.reasons.includes('RULE_SOURCE_UNAVAILABLE'));
  assert.equal(a.ruleAssessment.status, 'UNKNOWN'); assert.equal(a.ruleFreshAtTrigger, false);
  input.instrumentRules = rules(); input.instrumentRules.bybit!.instrumentStatus = 'NOT_TRADABLE';
  assert.equal(new ShadowExecutionEngine({ enabled: true }).trigger(event, input).reason, 'NOT_EXECUTABLE_RULES');
});
test('rule changes do not mutate active target; next attempt uses updated common size', () => {
  const { input, event } = executionFixture();
  input.instrumentRules!.bybit!.quantityStep = decimal('0.003');
  const engine = new ShadowExecutionEngine({ enabled: true });
  const a = engine.trigger(event, input).attempt!; assert.equal(a.ruleAdjustedTargetBtc, 0.009);
  input.instrumentRules!.bybit!.quantityStep = decimal('0.004');
  const b = engine.trigger({ ...event, id: 'new' }, input).attempt!;
  assert.equal(b.ruleAdjustedTargetBtc, 0.008); assert.equal(engine.getAttempts()[0]!.targetBtcSize, 0.009);
  assert.equal(a.configuredTargetBtc, 0.01); assert.equal(a.buy.requestedBtc, a.sell.requestedBtc);
});
test('re-simulates multiple levels at adjusted size, preserves original economics and deterministic no host clock', () => {
  const { input } = executionFixture(); input.instrumentRules!.bybit!.quantityStep = decimal('0.006');
  input.books.bybit.asks = [{ price: 100, size: 0.006 }, { price: 110, size: 1 }];
  const old = Date.now; Date.now = () => { throw new Error('host clock'); };
  try {
    const a = evaluateShadow(input), b = evaluateShadow(input); assert.deepEqual(a, b);
    assert.equal(a.directions[0].ruleAssessment.commonQuantity, 0.006);
    assert.equal(a.directions[0].ruleCalibratedBuyNotional, 0.6);
    assert.notEqual(a.directions[0].ruleCalibratedNetPnl, a.directions[0].shadowNetPnl! * 0.6);
    assert.ok(a.directions[0].shadowNetPnl! < 0); assert.ok(a.directions[0].ruleCalibratedNetPnl! > 0);
    const metrics = new RuleCalibrationMetrics(); metrics.record(a.directions[0].ruleAssessment, a.directions[0].shadowNetPnl, a.directions[0].ruleCalibratedNetPnl);
    assert.equal(metrics.summary().preRuleNegativePostRulePositive, 1);
  } finally { Date.now = old; }
});
test('calibration aggregate sample storage bounded', () => {
  const m = new RuleCalibrationMetrics(), a = assessCrossVenueRules(0.01, rules(), T, notionals);
  for (let i = 0; i < 3000; i++) m.record(a, 1, -1);
  assert.equal(m.summary().ruleAssessments, 3000); assert.equal(m.summary().postRuleNetPnl.count, 2048);
  assert.equal(m.summary().preRulePositivePostRuleNegative, 3000);
});
test('cache-only shadow evaluation issues no metadata calls and UNKNOWN retains pre-rule metrics', async () => {
  let requests = 0;
  const c = new InstrumentRulesCollector({ enabled: true, pollIntervalMs: 300000 }, async kind => {
    requests++; return kind === 'BYBIT_SPOT_INSTRUMENT' ? payloads.bybit : payloads.okx;
  }, () => T);
  await c.pollOnce();
  const { input } = executionFixture(); input.instrumentRules = c.getSnapshots();
  evaluateShadow(input); evaluateShadow(input); assert.equal(requests, 2); await c.stop();
  const m = new RuleCalibrationMetrics();
  m.record(assessCrossVenueRules(0.01, { bybit: null, okx: null }, T, notionals), 1, null);
  assert.equal(m.summary().preRuleNetPnl.average, 1); assert.equal(m.summary().postRuleNetPnl.count, 0);
});
test('real transport timeout aborts fetch and returns sanitized TIMEOUT', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('untrusted message')), { once: true });
  });
  try { await assert.rejects(publicTransport('BYBIT_SPOT_INSTRUMENT'), { category: 'TIMEOUT', message: 'TIMEOUT' }); }
  finally { globalThis.fetch = original; }
});
test('runtime instrument module has no private execution dependencies or exchange write paths', async () => {
  for (const file of await readdir('src/instrument-rules')) {
    if (file.endsWith('.test.ts')) continue;
    const source = await readFile(`src/instrument-rules/${file}`, 'utf8');
    assert.doesNotMatch(source, /private-read|signing|API_KEY|submitOrder|cancelOrder|withdraw|transfer|method:\s*['"](?:POST|PUT|PATCH|DELETE)/i);
  }
});
