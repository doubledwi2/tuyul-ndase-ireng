import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { executionFixture } from './fixture.js';
import { ShadowExecutionEngine, MAX_ATTEMPT_DETAIL } from './shadow-execution-engine.js';
import { ShadowExecutionRuntime } from './shadow-execution-runtime.js';
import { PAPER_EXECUTION_CONFIG } from '../config/paper.js';
import { privateReadConfig } from '../private-read/config.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import { ShadowExecutionMetrics, SHADOW_EXECUTION_SAMPLE_LIMIT } from './shadow-execution-metrics.js';
import { MarketPipeline } from '../app/pipeline.js';
import { TIMING_CONFIG } from '../config/timing.js';
import { LatencyPaperTradingEngine } from '../paper/latency-engine.js';

const T = 1_700_000_000_000;
function setup(options: ConstructorParameters<typeof ShadowExecutionEngine>[0] = {}) {
  const { input, event } = executionFixture(); let id = 0;
  const engine = new ShadowExecutionEngine({ enabled: true, idGenerator: () => `shadow-${++id}`, ...options });
  assert.equal(engine.trigger(event, input).accepted, true);
  const book = (exchange: 'bybit' | 'okx', offset: number, size = 1, bid?: number, ask?: number): NormalizedOrderBook => {
    const b = structuredClone(input.books[exchange]); b.receivedTimestamp = T + offset; b.exchangeTimestamp = T + offset;
    b.bids = [{ price: bid ?? b.bids[0]!.price, size }]; b.asks = [{ price: ask ?? b.asks[0]!.price, size }]; return b;
  };
  return { input, event, engine, book, result: () => engine.getAttempts()[0]! };
}
interface Fixture { outcome: string; entryOutcome: string; steps: { at: number; exchange?: 'bybit' | 'okx'; size?: number; bid?: number; ask?: number }[] }
for (const name of await readdir('fixtures/shadow-execution')) {
  test(`shadow execution deterministic fixture: ${name}`, async () => {
    const fixture = JSON.parse(await readFile(join('fixtures/shadow-execution', name), 'utf8')) as Fixture;
    const run = () => {
      const s = setup();
      const clock = Date.now; Date.now = () => { throw new Error('Host clock forbidden'); };
      try {
        for (const step of fixture.steps) {
          if (step.exchange) s.engine.processOrderBook(s.book(step.exchange, step.at, step.size, step.bid, step.ask), T + step.at);
          else s.engine.tick(T + step.at);
        }
      } finally { Date.now = clock; }
      return { attempt: s.result(), metrics: s.engine.getMetrics() };
    };
    const first = run(); assert.deepEqual(run(), first);
    assert.equal(first.attempt.outcome, fixture.outcome); assert.equal(first.attempt.entryOutcome, fixture.entryOutcome);
    assert.equal(first.metrics.terminalAttempts, 1);
    for (const fill of first.attempt.fills) assert.ok(fill.at >= (fill.leg === 'unwind' ? first.attempt.unwind!.arrivalAt : T + 50));
    if (name === 'profit-decays-negative.json') {
      assert.ok(first.attempt.netPnlAfterFees! < 0); assert.equal(first.metrics.triggerPositiveFinalNegative, 1);
    }
    if (name === 'successful-unwind.json') {
      assert.equal(first.attempt.unwind!.firstFillAt, T + 300); assert.ok(first.attempt.unwindRealizedPnl < 0);
    }
  });
}
test('fees/funding frozen at trigger, observed rebate preserved, no actual snapshot mutation', () => {
  const { input, event } = executionFixture(); input.accounts.okx.fee!.takerFeeRate.normalizedCostRate = -0.001;
  input.accounts.bybit.balance!.btc.available = null; input.accounts.bybit.balance!.usdt.available = null;
  const original = structuredClone(input);
  const engine = new ShadowExecutionEngine({ enabled: true }); engine.trigger(event, input);
  assert.deepEqual(input, original);
  input.accounts.okx.fee!.takerFeeRate.normalizedCostRate = 0.04;
  input.accounts.bybit.balance!.usdt.available = 99999;
  for (const ex of ['bybit', 'okx'] as const) {
    const b = structuredClone(input.books[ex]); b.receivedTimestamp = T + 50; engine.processOrderBook(b, T + 50);
  }
  const a = engine.getAttempts()[0]!;
  assert.equal(a.outcome, 'CLEAN_FILL'); assert.equal(a.feeRates.okx, -0.001); assert.ok(a.sellFee < 0);
  assert.equal(a.fundingAssessment.status, 'UNKNOWN_AVAILABLE_BALANCE');
  assert.ok(Math.abs(a.netPnlAfterFees! - (1.03 - 1 - 0.001 + 0.00103)) < 1e-10);
});
test('stale private snapshots remain fallback/degraded and funding stale', () => {
  const { event, input } = executionFixture();
  for (const ex of ['bybit', 'okx'] as const) { input.accounts[ex].fee!.receivedAt -= 900001; input.accounts[ex].balance!.receivedAt -= 30001; }
  const engine = new ShadowExecutionEngine({ enabled: true }); const a = engine.trigger(event, input).attempt!;
  assert.equal(a.feeSources.bybit, 'SIMULATION_FALLBACK'); assert.equal(a.degraded, true);
  assert.equal(a.fundingAssessment.status, 'STALE_BALANCE');
});
test('same object cannot be double-consumed; same timestamp new objects are distinct inputs', () => {
  const s = setup(), b = s.book('bybit', 50, 0.004);
  s.engine.processOrderBook(b, T + 50); s.engine.processOrderBook(b, T + 50);
  assert.equal(s.result().buy.filledBtc, 0.004);
  s.engine.processOrderBook(s.book('bybit', 50, 0.009), T + 50);
  assert.equal(s.result().buy.filledBtc, 0.01);
});
test('concurrent attempts independently observe liquidity, no global depletion', () => {
  const s = setup(); s.engine.trigger({ ...s.event, id: 'second' }, s.input);
  s.engine.processOrderBook(s.book('bybit', 50, 0.01), T + 50);
  assert.deepEqual(s.engine.getAttempts().map(a => a.buy.filledBtc), [0.01, 0.01]);
});
test('partial matched PnL accounts only closed quantity, residual and fees explicit', () => {
  const s = setup(); s.engine.processOrderBook(s.book('bybit', 50, 0.006), T + 50);
  s.engine.processOrderBook(s.book('okx', 50, 0.004), T + 50);
  const a = s.result(); assert.ok(Math.abs(a.residualBtc - 0.002) < 1e-12);
  assert.ok(Math.abs(a.netPnlAfterFees! - (0.004 * 3 - 0.004 * 100 * .001 - 0.004 * 103 * .001)) < 1e-10);
  assert.ok(a.unallocatedEntryFees > 0); assert.equal(a.unhedgedStartedAt, T + 50);
});
test('SELL excess unwinds BUY on sell venue; partial unwind only uses new eligible inputs', () => {
  const s = setup(); s.engine.processOrderBook(s.book('okx', 50), T + 50); s.engine.tick(T + 250);
  assert.equal(s.result().unwind!.exchange, 'okx'); assert.equal(s.result().unwind!.side, 'BUY');
  s.engine.processOrderBook(s.book('okx', 299), T + 299); assert.equal(s.result().unwind!.filledBtc, 0);
  s.engine.processOrderBook(s.book('okx', 300, .004), T + 300);
  s.engine.processOrderBook(s.book('okx', 310, .006), T + 310);
  assert.equal(s.result().outcome, 'UNWOUND'); assert.equal(s.result().residualBtc, 0);
});
test('late book cannot fill entry or unwind; silent feed eventually terminal via logical ticks', () => {
  const s = setup(); s.engine.processOrderBook(s.book('bybit', 251), T + 251);
  assert.equal(s.result().outcome, 'TIMED_OUT'); assert.equal(s.result().fillCount, 0);
  const u = setup(); u.engine.processOrderBook(u.book('bybit', 50), T + 50); u.engine.tick(T + 250);
  u.engine.processOrderBook(u.book('bybit', 501), T + 501);
  assert.equal(u.result().outcome, 'UNWIND_FAILED'); assert.equal(u.result().residualBtc, .01);
});
test('shutdown aborts active attempts without fabricated fills or restart recovery', () => {
  const s = setup(); s.engine.processOrderBook(s.book('bybit', 50), T + 50); s.engine.shutdown(T + 60);
  assert.equal(s.result().outcome, 'ABORTED_SHUTDOWN'); assert.equal(s.result().fillCount, 1);
  assert.equal(s.engine.getHealth().activeAttempts, 0);
  assert.equal(new ShadowExecutionEngine({ enabled: true }).getAttempts().length, 0);
});
test('dedupe, capacity, bounded recent history and retired watermark', () => {
  const s = setup({ maxActive: 1, maxRecent: 1 });
  assert.equal(s.engine.trigger(s.event, s.input).reason, 'DUPLICATE_OR_RETIRED_OPPORTUNITY');
  assert.equal(s.engine.trigger({ ...s.event, id: 'capacity' }, s.input).reason, 'SHADOW_CAPACITY_LIMIT');
  s.engine.tick(T + 251);
  const later = executionFixture(T + 300); s.engine.trigger(later.event, later.input); s.engine.tick(T + 551);
  assert.equal(s.engine.getAttempts().length, 1);
  const old = { ...s.event, updatedAt: T + 551 };
  assert.equal(s.engine.trigger(old, { ...later.input, evaluatedAt: T + 551 }).reason, 'DUPLICATE_OR_RETIRED_OPPORTUNITY');
  assert.equal(s.engine.getMetrics().capacityRejected, 1);
});
test('disabled mode creates no attempts or factory side effects; strict config implication', () => {
  const s = executionFixture(), runtime = new ShadowExecutionRuntime(false);
  runtime.onOpportunity(s.event, () => { throw new Error('Must not call'); });
  assert.equal(runtime.getMetrics().attemptsTriggered, 0);
  assert.throws(() => privateReadConfig({ SHADOW_EXECUTION_ENABLED: 'true' }));
  assert.throws(() => privateReadConfig({ SHADOW_EXECUTION_ENABLED: 'true', SHADOW_MODE_ENABLED: 'true' }));
  assert.throws(() => privateReadConfig({ SHADOW_EXECUTION_ENABLED: 'yes' }));
  assert.doesNotThrow(() => privateReadConfig({ SHADOW_EXECUTION_ENABLED: 'true', SHADOW_MODE_ENABLED: 'true', PRIVATE_READ_ENABLED: 'true' }));
});
test('non-qualified, stale event, bad sync and future trigger books rejected', () => {
  for (const state of ['DETECTED', 'VALIDATING'] as const) {
    const s = executionFixture(); assert.equal(new ShadowExecutionEngine({ enabled: true }).trigger({ ...s.event, state }, s.input).accepted, false);
  }
  const s = executionFixture(); s.input.books.bybit.receivedTimestamp++;
  assert.equal(new ShadowExecutionEngine({ enabled: true }).trigger(s.event, s.input).accepted, false);
  assert.equal(new ShadowExecutionEngine({ enabled: true }).trigger({ ...s.event, updatedAt: T - 101 }, s.input).accepted, false);
});
test('attempt detail bounded and health/metrics do not contain private snapshots', () => {
  const s = setup();
  for (let i = 0; i < 100; i++) s.engine.processOrderBook(s.book('bybit', 50, .000001), T + 50);
  assert.equal(s.result().fills.length, MAX_ATTEMPT_DETAIL); assert.equal(s.result().fillCount, MAX_ATTEMPT_DETAIL);
  assert.equal(s.result().outcome, 'ABORTED_DETAIL_LIMIT'); assert.equal(s.result().feasibility, 'UNCERTAIN');
  assert.equal(s.engine.getMetrics().abortedDetailLimit, 1);
  const serialized = JSON.stringify({ a: s.result(), health: s.engine.getHealth(), metrics: s.engine.getMetrics() });
  assert.doesNotMatch(serialized, /"(?:balance|total|available|apiKey|uid|ip|rawRate)":/);
});
test('shared defaults and strict bounded latency options; production core has no networking or host clock', async () => {
  const s = setup(); assert.equal(s.result().buy.arrivalAt - T, PAPER_EXECUTION_CONFIG.buyOrderLatencyMs);
  assert.throws(() => new ShadowExecutionEngine({ config: { ...PAPER_EXECUTION_CONFIG, buyOrderLatencyMs: Infinity } }));
  for (const name of await readdir('src/shadow-execution')) {
    if (name.endsWith('.test.ts')) continue;
    assert.doesNotMatch(await readFile(join('src/shadow-execution', name), 'utf8'), /\bfetch\b|\bWebSocket\b|https?:\/\/|credentials|signer|API key|withdraw|transfer|Date\.now/);
  }
});

test('fresh-pair QUALIFIED is the only runtime trigger; fills need only their venue update', () => {
  const fixture = executionFixture(), runtime = new ShadowExecutionRuntime(true);
  const pipeline = new MarketPipeline({ timingConfig: { ...TIMING_CONFIG, minOffsetSamples: 1 },
    onEvent: event => {
      const s = pipeline.getLatestDepthSnapshot()!;
      runtime.onOpportunity(event, () => ({ ...fixture.input, evaluatedAt: event.updatedAt,
        books: { bybit: s.bybitBook, okx: s.okxBook }, sync: s.syncAssessment }));
    } });
  const feed = (ex: 'bybit' | 'okx', at: number) => {
    const b = structuredClone(fixture.input.books[ex]);
    runtime.onBook(b, T + at); pipeline.processOrderBook(b, T + at);
  };
  feed('bybit', 0); feed('okx', 0);
  for (const at of [30, 60, 100, 120]) feed('bybit', at);
  assert.equal(runtime.getMetrics().attemptsTriggered, 0);
  feed('okx', 120); assert.equal(runtime.getMetrics().attemptsTriggered, 1);
  feed('bybit', 170); assert.equal(runtime.getHealth().activeAttempts, 1);
  feed('okx', 170); assert.equal(runtime.getMetrics().cleanFills, 1);
});
test('phase 3 state remains unchanged; sanitized attempt ignores injected private metadata', () => {
  const paper = new LatencyPaperTradingEngine(), before = paper.exportState();
  const fixture = executionFixture(); const marker = 'PRIVATE_SENTINEL_938721';
  Object.assign(fixture.input.accounts.bybit.balance!, { uid: marker, apiKey: marker, note: marker });
  fixture.input.accounts.bybit.balance!.btc.total = 817263.91827;
  const engine = new ShadowExecutionEngine({ enabled: true }); engine.trigger(fixture.event, fixture.input);
  engine.shutdown(T + 100);
  assert.deepEqual(paper.exportState(), before);
  const result = JSON.stringify([engine.getAttempts(), engine.getHealth(), engine.getMetrics(), paper.exportState()]);
  assert.ok(!result.includes(marker)); assert.ok(!result.includes('817263.91827'));
});
test('bounded metric windows include per-direction survival and economically closed decay counts', () => {
  const s = setup(); s.engine.processOrderBook(s.book('bybit', 50), T + 50); s.engine.processOrderBook(s.book('okx', 50), T + 50);
  const metrics = new ShadowExecutionMetrics();
  for (let i = 0; i < SHADOW_EXECUTION_SAMPLE_LIMIT + 5; i++) { metrics.triggered(s.result()); metrics.terminal(s.result()); }
  const summary = metrics.summary();
  assert.equal(summary.distributions.netPnlAfterFees!.count, SHADOW_EXECUTION_SAMPLE_LIMIT);
  assert.equal(summary.cleanFillRate, 1);
  assert.equal(summary.byDirection.BUY_BYBIT_SELL_OKX.cleanFills, SHADOW_EXECUTION_SAMPLE_LIMIT + 5);
  assert.equal(summary.byDirection.BUY_OKX_SELL_BYBIT.cleanFills, 0);
});
test('zero-latency unwind still cannot consume the input that creates it', () => {
  const s = setup({ config: { ...PAPER_EXECUTION_CONFIG, maxUnhedgedDurationMs: 0, unwindOrderLatencyMs: 0 } });
  s.engine.processOrderBook(s.book('bybit', 50), T + 50);
  assert.equal(s.result().unwind!.filledBtc, 0);
  s.engine.processOrderBook(s.book('bybit', 50), T + 50);
  assert.equal(s.result().outcome, 'UNWOUND');
});
test('arrival delay and price drift use actual input time and fill VWAP', () => {
  const s = setup(); s.engine.processOrderBook(s.book('bybit', 70, 1, 100, 101), T + 70);
  s.engine.processOrderBook(s.book('okx', 80, 1, 102, 103), T + 80);
  assert.equal(s.result().buy.firstEligibleBookDelayMs, 20); assert.equal(s.result().sell.firstEligibleBookDelayMs, 30);
  assert.ok(Math.abs(s.result().buyPriceDriftBps! - 100) < 1e-9);
});
test('post-trigger sync does not cancel existing legs; only valid venue book and deadlines matter', () => {
  const s = setup(); s.input.sync.status = 'CLOCK_UNHEALTHY';
  s.engine.processOrderBook(s.book('bybit', 50), T + 50); s.engine.processOrderBook(s.book('okx', 50), T + 50);
  assert.equal(s.result().outcome, 'CLEAN_FILL');
});
