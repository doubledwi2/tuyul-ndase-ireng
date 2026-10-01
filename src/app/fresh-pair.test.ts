import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketPipeline } from './pipeline.js';
import type { OpportunityEvent } from '../scanner/opportunity.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import { TIMING_CONFIG } from '../config/timing.js';
import { DETERMINISTIC_HEALTHY_CLOCK } from '../timing/clock-health.js';
import { replayOrderBooks } from '../replay/orderbook-replay-engine.js';

function book(exchange: 'bybit' | 'okx'): NormalizedOrderBook {
  return { exchange, symbol: 'BTC/USDT', bids: [{ price: exchange === 'bybit' ? 99 : 102, size: 1 }],
    asks: [{ price: exchange === 'bybit' ? 100 : 103, size: 1 }],
    receivedTimestamp: 1000, exchangeTimestamp: 1000, matchingEngineTimestamp: null };
}
function setup(duration = 100) {
  const events: OpportunityEvent[] = [];
  const pipeline = new MarketPipeline({ fees: { bybit: { takerRate: 0 }, okx: { takerRate: 0 } },
    targetBaseSize: 0.1, timingConfig: { ...TIMING_CONFIG, minOffsetSamples: 1 },
    qualityConfig: { minNetSpreadPercent: 0.5, minNetPnlUsdt: 0.001, minActiveDurationMs: duration, maxSyncDiffMsForQualified: 100 },
    onEvent: event => { if (event.buyExchange === 'bybit') events.push(event); } });
  const update = (exchange: 'bybit' | 'okx', at: number) => pipeline.processOrderBook(book(exchange), at);
  update('bybit', 1000); update('okx', 1000);
  const states = () => events.map(e => e.state);
  return { pipeline, events, update, states };
}
for (const exchange of ['bybit', 'okx'] as const) test(`fresh pair: repeated ${exchange} cannot advance despite elapsed duration`, () => {
  const s = setup();
  for (const at of [1010, 1020, 1100, 1200]) s.update(exchange, at);
  assert.deepEqual(s.states(), ['DETECTED']);
  assert.equal(s.pipeline.getMetricsSummary().comparisonsTotal, 10);
  s.update(exchange === 'bybit' ? 'okx' : 'bybit', 1200);
  assert.deepEqual(s.states(), ['DETECTED', 'QUALIFIED']);
});
test('fresh pair: same-millisecond receipt generations support alternating validation', () => {
  const s = setup();
  s.update('bybit', 1040); assert.deepEqual(s.states(), ['DETECTED']);
  s.update('okx', 1040); assert.deepEqual(s.states(), ['DETECTED', 'VALIDATING']);
  s.update('okx', 1110); assert.equal(s.events.at(-1)!.state, 'VALIDATING');
  s.update('bybit', 1110); assert.equal(s.events.at(-1)!.state, 'QUALIFIED');
  assert.equal(s.events.at(-1)!.qualifiedAt, 1110);
  s.update('bybit', 1120); s.update('okx', 1120);
  assert.deepEqual(s.states(), ['DETECTED', 'VALIDATING', 'QUALIFIED']);
});
test('fresh pair: equal logical and receipt timestamps still count distinct generations', () => {
  const s = setup(0); s.update('bybit', 1000); s.update('okx', 1000);
  assert.deepEqual(s.states(), ['DETECTED', 'QUALIFIED']);
});
test('fresh pair: invalid input does not increment counterpart generation', () => {
  const s = setup(0);
  assert.equal(s.pipeline.processOrderBook({ ...book('bybit'), asks: [] }, 1000), null);
  s.update('okx', 1000); assert.deepEqual(s.states(), ['DETECTED']);
  s.update('bybit', 1000); assert.equal(s.events.at(-1)!.state, 'QUALIFIED');
});
for (const stage of ['DETECTED', 'VALIDATING', 'QUALIFIED'] as const) {
  for (const failure of ['economic', 'depth', 'quality', 'sync'] as const) {
    test(`fresh pair: ${stage} one-sided ${failure} failure is immediate`, () => {
      const s = setup();
      if (stage !== 'DETECTED') { s.update('bybit', 1020); s.update('okx', 1020); }
      if (stage === 'QUALIFIED') { s.update('bybit', 1100); s.update('okx', 1100); }
      const bad = book('bybit');
      if (failure === 'economic') bad.asks = [{ price: 103, size: 1 }];
      if (failure === 'depth') bad.asks[0]!.size = 0.001;
      if (failure === 'quality') bad.asks = [{ price: 101.99, size: 1 }];
      const clock = failure === 'sync' ? { ...DETERMINISTIC_HEALTHY_CLOCK, status: 'CLOCK_JUMP_DETECTED' as const } : DETERMINISTIC_HEALTHY_CLOCK;
      s.pipeline.processOrderBook(bad, 1120, clock);
      assert.equal(s.events.at(-1)!.state, failure === 'sync' ? 'INVALID_SYNC' : 'DISAPPEARED');
    });
  }
}
test('fresh pair: recovery waits for both after invalidation and restarts full duration', () => {
  const s = setup();
  s.pipeline.processOrderBook(book('bybit'), 1020, { ...DETERMINISTIC_HEALTHY_CLOCK, status: 'CLOCK_JUMP_DETECTED' });
  for (const at of [1030, 1100, 1200]) s.update('bybit', at);
  assert.deepEqual(s.states(), ['DETECTED', 'INVALID_SYNC']);
  s.update('okx', 1200); assert.equal(s.events.at(-1)!.state, 'DETECTED');
  assert.equal(s.events.at(-1)!.detectedAt, 1200);
  s.update('bybit', 1240); s.update('okx', 1240);
  assert.equal(s.events.at(-1)!.state, 'VALIDATING');
  s.update('bybit', 1300); assert.equal(s.events.at(-1)!.state, 'VALIDATING');
  s.update('okx', 1300); assert.equal(s.events.at(-1)!.qualifiedAt, 1300);
  assert.equal(s.events.at(-1)!.timeToQualifiedMs, 100);
});
test('fresh pair: repeated unhealthy observations reset recovery baseline again', () => {
  const s = setup(); const badClock = { ...DETERMINISTIC_HEALTHY_CLOCK, status: 'CLOCK_JUMP_DETECTED' as const };
  s.pipeline.processOrderBook(book('bybit'), 1020, badClock);
  s.pipeline.processOrderBook(book('okx'), 1030, badClock);
  s.update('bybit', 1040); assert.deepEqual(s.states(), ['DETECTED', 'INVALID_SYNC']);
  s.update('okx', 1050); assert.equal(s.events.at(-1)!.state, 'DETECTED');
});
test('fresh pair: book age failure is immediate without a counterpart update', () => {
  const s = setup();
  s.pipeline.processOrderBook({ ...book('bybit'), receivedTimestamp: 1600, exchangeTimestamp: 1600 }, 1600);
  assert.equal(s.events.at(-1)!.state, 'INVALID_SYNC');
  assert.ok(s.events.at(-1)!.currentSyncReasons.includes('BOOK_TOO_OLD'));
});

test('fresh pair: direct and twice-replayed ordered dataset have identical lifecycle and metrics', async () => {
  const records = [
    { recordedAt: 1040, orderBook: book('bybit') },
    { recordedAt: 1110, orderBook: book('bybit') },
    { recordedAt: 1120, orderBook: book('okx') },
    { recordedAt: 1130, orderBook: { ...book('bybit'), asks: [{ price: 104, size: 1 }] } },
  ];
  const dir = await mkdtemp(join(tmpdir(), 'fresh-pair-replay-'));
  try {
    const file = join(dir, 'books.jsonl');
    await writeFile(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
    const direct = setup();
    for (const r of records) direct.pipeline.processOrderBook(r.orderBook, r.recordedAt);
    const normalize = (s: ReturnType<typeof setup>) => ({
      events: s.events.map(({ id: _id, ...event }) => event), metrics: s.pipeline.getMetricsSummary(),
    });
    for (let i = 0; i < 2; i++) {
      const replay = setup();
      await replayOrderBooks({ filePath: file, speed: 'max',
        onOrderBook: (b, at) => { replay.pipeline.processOrderBook(b, at); } });
      assert.deepEqual(normalize(replay), normalize(direct));
    }
    assert.deepEqual(direct.states(), ['DETECTED', 'QUALIFIED', 'DISAPPEARED']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
