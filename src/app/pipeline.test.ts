import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { FeeConfig } from '../config/fees.js';
import type { OpportunityQualityConfig } from '../config/opportunity.js';
import type { TimingConfig } from '../config/timing.js';
import type { MarketQuoteRecord } from '../recording/market-recorder.js';
import type { OrderBookRecord } from '../recording/orderbook-recorder.js';
import type { OpportunityEvent } from '../scanner/opportunity.js';
import type { BestQuote } from '../types/market.js';
import { replayMarketData } from '../replay/replay-engine.js';
import { replayOrderBooks } from '../replay/orderbook-replay-engine.js';
import { MarketPipeline } from './pipeline.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import {
  DETERMINISTIC_HEALTHY_CLOCK,
  type ClockHealth,
} from '../timing/clock-health.js';

const TEST_TIMING_CONFIG: TimingConfig = {
  maxReceiveSkewMs: 100,
  maxBookAgeMs: 500,
  maxSourceTimestampSkewMs: 250,
  clockJumpThresholdMs: 50,
  minOffsetSamples: 1,
  offsetWindowSize: 10,
  maxOffsetDeviationMs: 100,
};

function quote(
  exchange: BestQuote['exchange'],
  bid: number,
  ask: number,
  timestamp: number,
): BestQuote {
  return {
    exchange,
    symbol: 'BTC/USDT',
    bid,
    bidSize: 2,
    ask,
    askSize: 1,
    exchangeTimestamp: timestamp,
    matchingEngineTimestamp: null,
    receivedTimestamp: timestamp,
  };
}

function comparableEvent(event: OpportunityEvent) {
  const { id: _id, ...comparable } = event;
  return comparable;
}

function orderBook(
  exchange: BestQuote['exchange'],
  bid: number,
  ask: number,
  timestamp: number,
): NormalizedOrderBook {
  return {
    exchange,
    symbol: 'BTC/USDT',
    bids: [{ price: bid, size: 1 }, { price: bid - 1, size: 2 }],
    asks: [{ price: ask, size: 0.1 }, { price: ask + 1, size: 2 }],
    exchangeTimestamp: timestamp,
    matchingEngineTimestamp: null,
    receivedTimestamp: timestamp,
  };
}

test('direct and replay pipelines produce equivalent opportunity transitions', async (context) => {
  const records: MarketQuoteRecord[] = [
    { recordedAt: 1_000, quote: quote('bybit', 101, 102, 1_000) },
    { recordedAt: 1_010, quote: quote('okx', 99, 100, 1_010) },
    { recordedAt: 1_020, quote: quote('bybit', 102, 103, 1_020) },
    { recordedAt: 1_030, quote: quote('okx', 100, 101, 1_030) },
    { recordedAt: 1_040, quote: quote('bybit', 99, 100, 1_040) },
  ];
  const directEvents: OpportunityEvent[] = [];
  const direct = new MarketPipeline({ onEvent: (event) => directEvents.push(event) });
  for (const record of records) {
    direct.processQuote(record.quote, record.recordedAt);
  }

  const root = await mkdtemp(join(tmpdir(), 'pipeline-replay-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'quotes.jsonl');
  await writeFile(
    file,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
  const replayEvents: OpportunityEvent[] = [];
  const replay = new MarketPipeline({ onEvent: (event) => replayEvents.push(event) });
  await replayMarketData({
    filePath: file,
    speed: 'max',
    onQuote: (value, recordedAt) => {
      replay.processQuote(value, recordedAt);
    },
  });

  assert.deepEqual(
    directEvents.map((event) => event.state),
    ['DETECTED', 'QUALIFIED', 'DISAPPEARED'],
  );
  assert.deepEqual(
    replayEvents.map(comparableEvent),
    directEvents.map(comparableEvent),
  );
  assert.deepEqual(replay.getMetricsSummary(), direct.getMetricsSummary());
  assert.equal(replay.getOpenEventCount(), 0);
});

test('replaying identical raw quotes with different fees can change candidacy', async (context) => {
  const records: MarketQuoteRecord[] = [
    { recordedAt: 2_000, quote: quote('bybit', 99.9, 100, 2_000) },
    { recordedAt: 2_010, quote: quote('okx', 100.1, 100.2, 2_010) },
  ];
  const root = await mkdtemp(join(tmpdir(), 'pipeline-fees-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'quotes.jsonl');
  await writeFile(
    file,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
  const baselineEvents: OpportunityEvent[] = [];
  const zeroFeeEvents: OpportunityEvent[] = [];
  const zeroFees: FeeConfig = {
    bybit: { takerRate: 0 },
    okx: { takerRate: 0 },
  };
  const baseline = new MarketPipeline({
    onEvent: (event) => baselineEvents.push(event),
  });
  const zeroFee = new MarketPipeline({
    fees: zeroFees,
    onEvent: (event) => zeroFeeEvents.push(event),
  });

  await replayMarketData({
    filePath: file,
    speed: 'max',
    onQuote: (value, recordedAt) => {
      baseline.processQuote(value, recordedAt);
    },
  });
  await replayMarketData({
    filePath: file,
    speed: 'max',
    onQuote: (value, recordedAt) => {
      zeroFee.processQuote(value, recordedAt);
    },
  });

  const baselineComparison = baseline.getLatestSnapshot()?.feeAwareComparisons[0];
  const zeroFeeComparison = zeroFee.getLatestSnapshot()?.feeAwareComparisons[0];
  assert.equal(
    baselineComparison?.grossSpreadAbsolute,
    zeroFeeComparison?.grossSpreadAbsolute,
  );
  assert.equal(baselineComparison?.feeStatus, 'NET_ZERO_OR_NEGATIVE');
  assert.equal(zeroFeeComparison?.feeStatus, 'NET_POSITIVE');
  assert.equal(baselineEvents.length, 0);
  assert.deepEqual(zeroFeeEvents.map((event) => event.state), ['DETECTED']);
});

test('direct and replayed order books produce deterministic fills and lifecycle', async (context) => {
  const records: OrderBookRecord[] = [
    { recordedAt: 3_000, orderBook: orderBook('bybit', 99, 100, 3_000) },
    { recordedAt: 3_010, orderBook: orderBook('okx', 102, 103, 3_010) },
    { recordedAt: 3_020, orderBook: orderBook('bybit', 99, 100, 3_020) },
    { recordedAt: 3_030, orderBook: orderBook('okx', 102, 103, 3_030) },
    { recordedAt: 3_040, orderBook: orderBook('bybit', 99, 103, 3_040) },
  ];
  const zeroFees: FeeConfig = {
    bybit: { takerRate: 0 },
    okx: { takerRate: 0 },
  };
  const directEvents: OpportunityEvent[] = [];
  const qualityConfig: OpportunityQualityConfig = {
    minNetSpreadPercent: 0.03,
    minNetPnlUsdt: 0.01,
    minActiveDurationMs: 20,
    maxSyncDiffMsForQualified: 100,
  };
  const direct = new MarketPipeline({
    fees: zeroFees,
    targetBaseSize: 0.2,
    qualityConfig,
    timingConfig: TEST_TIMING_CONFIG,
    onEvent: (event) => directEvents.push(event),
  });
  for (const record of records) {
    direct.processOrderBook(record.orderBook, record.recordedAt);
  }

  const root = await mkdtemp(join(tmpdir(), 'pipeline-book-replay-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'orderbooks.jsonl');
  await writeFile(
    file,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
  const replayEvents: OpportunityEvent[] = [];
  const replay = new MarketPipeline({
    fees: zeroFees,
    targetBaseSize: 0.2,
    qualityConfig,
    timingConfig: TEST_TIMING_CONFIG,
    onEvent: (event) => replayEvents.push(event),
  });
  await replayOrderBooks({
    filePath: file,
    speed: 'max',
    onOrderBook: (value, recordedAt) => {
      replay.processOrderBook(value, recordedAt);
    },
  });

  assert.deepEqual(
    directEvents.map((event) => event.state),
    ['DETECTED', 'VALIDATING', 'QUALIFIED', 'DISAPPEARED'],
  );
  assert.deepEqual(
    replayEvents.map(comparableEvent),
    directEvents.map(comparableEvent),
  );
  assert.deepEqual(
    replay.getLatestDepthSnapshot()?.comparisons,
    direct.getLatestDepthSnapshot()?.comparisons,
  );
  assert.deepEqual(
    replay.getLatestDepthSnapshot()?.syncAssessment,
    direct.getLatestDepthSnapshot()?.syncAssessment,
  );
  assert.deepEqual(replay.getMetricsSummary(), direct.getMetricsSummary());
  assert.equal(replay.getMetricsSummary().comparisonsTotal, 8);
});

test('replay source-clock baseline is deterministic and host-time independent', async (context) => {
  const offsetBook = (
    exchange: 'bybit' | 'okx',
    receivedTimestamp: number,
    offsetMs: number,
  ): NormalizedOrderBook => ({
    ...orderBook(exchange, 99, 100, receivedTimestamp),
    exchangeTimestamp: receivedTimestamp - offsetMs,
  });
  const records: OrderBookRecord[] = [
    { recordedAt: 7_000, orderBook: offsetBook('bybit', 7_000, -120) },
    { recordedAt: 7_010, orderBook: offsetBook('okx', 7_010, -127) },
    { recordedAt: 7_020, orderBook: offsetBook('bybit', 7_020, -118) },
    { recordedAt: 7_030, orderBook: offsetBook('okx', 7_030, -125) },
    { recordedAt: 7_040, orderBook: offsetBook('bybit', 7_040, -122) },
    { recordedAt: 7_050, orderBook: offsetBook('okx', 7_050, -129) },
  ];
  const root = await mkdtemp(join(tmpdir(), 'pipeline-offset-replay-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'orderbooks.jsonl');
  await writeFile(
    file,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
  const timingConfig: TimingConfig = {
    ...TEST_TIMING_CONFIG,
    minOffsetSamples: 3,
  };
  const first = new MarketPipeline({ timingConfig });
  const second = new MarketPipeline({ timingConfig });

  for (const pipeline of [first, second]) {
    await replayOrderBooks({
      filePath: file,
      speed: 'max',
      onOrderBook: (value, recordedAt) => {
        pipeline.processOrderBook(value, recordedAt);
      },
    });
  }

  assert.deepEqual(
    first.getLatestDepthSnapshot()?.syncAssessment,
    second.getLatestDepthSnapshot()?.syncAssessment,
  );
  assert.deepEqual(first.getMetricsSummary(), second.getMetricsSummary());
  assert.equal(
    first.getLatestDepthSnapshot()?.syncAssessment.bybitSourceClock
      .baselineObservedIngressMs,
    -120,
  );
  assert.equal(
    first.getLatestDepthSnapshot()?.syncAssessment.okxSourceClock
      .baselineObservedIngressMs,
    -127,
  );
  assert.equal(
    first.getLatestDepthSnapshot()?.syncAssessment.status,
    'SYNC_HEALTHY',
  );
});

test('replay quality config override can change qualification result', async (context) => {
  const records: OrderBookRecord[] = [
    { recordedAt: 4_000, orderBook: orderBook('bybit', 99, 100, 4_000) },
    { recordedAt: 4_010, orderBook: orderBook('okx', 102, 103, 4_010) },
    { recordedAt: 4_120, orderBook: orderBook('bybit', 99, 100, 4_120) },
  ];
  const root = await mkdtemp(join(tmpdir(), 'pipeline-quality-config-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'orderbooks.jsonl');
  await writeFile(
    file,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
  const zeroFees: FeeConfig = {
    bybit: { takerRate: 0 },
    okx: { takerRate: 0 },
  };
  const looseEvents: OpportunityEvent[] = [];
  const strictEvents: OpportunityEvent[] = [];
  const loose = new MarketPipeline({
    fees: zeroFees,
    targetBaseSize: 0.2,
    qualityConfig: {
      minNetSpreadPercent: 0.03,
      minNetPnlUsdt: 0.01,
      minActiveDurationMs: 100,
      maxSyncDiffMsForQualified: 250,
    },
    timingConfig: {
      ...TEST_TIMING_CONFIG,
      maxReceiveSkewMs: 250,
    },
    onEvent: (event) => looseEvents.push(event),
  });
  const strict = new MarketPipeline({
    fees: zeroFees,
    targetBaseSize: 0.2,
    qualityConfig: {
      minNetSpreadPercent: 2,
      minNetPnlUsdt: 0.01,
      minActiveDurationMs: 100,
      maxSyncDiffMsForQualified: 250,
    },
    timingConfig: {
      ...TEST_TIMING_CONFIG,
      maxReceiveSkewMs: 250,
    },
    onEvent: (event) => strictEvents.push(event),
  });

  await replayOrderBooks({
    filePath: file,
    speed: 'max',
    onOrderBook: (value, recordedAt) => {
      loose.processOrderBook(value, recordedAt);
      strict.processOrderBook(value, recordedAt);
    },
  });

  assert.deepEqual(
    looseEvents.map((event) => event.state),
    ['DETECTED', 'QUALIFIED'],
  );
  assert.equal(strictEvents.length, 0);
  assert.ok(loose.getMetricsSummary().qualifiedComparisons > 0);
  assert.equal(strict.getMetricsSummary().qualifiedComparisons, 0);
  assert.ok(strict.getMetricsSummary().rejectedSmallNetSpread > 0);
});

test('sync health invalidates and recovery restarts qualification duration', () => {
  const events: OpportunityEvent[] = [];
  const pipeline = new MarketPipeline({
    fees: {
      bybit: { takerRate: 0 },
      okx: { takerRate: 0 },
    },
    targetBaseSize: 0.2,
    timingConfig: TEST_TIMING_CONFIG,
    onEvent: (event) => events.push(event),
  });
  const unhealthyClock: ClockHealth = {
    status: 'CLOCK_JUMP_DETECTED',
    wallTimestamp: 5_120,
    monotonicTimestamp: 120,
    clockDriftDeltaMs: 75,
  };

  pipeline.processOrderBook(orderBook('bybit', 99, 100, 5_000), 5_000);
  pipeline.processOrderBook(orderBook('okx', 102, 103, 5_010), 5_010);
  pipeline.processOrderBook(orderBook('bybit', 99, 100, 5_040), 5_040);
  pipeline.processOrderBook(orderBook('okx', 102, 103, 5_110), 5_110);
  pipeline.processOrderBook(
    orderBook('bybit', 99, 100, 5_120),
    5_120,
    unhealthyClock,
  );
  pipeline.processOrderBook(
    orderBook('okx', 102, 103, 5_130),
    5_130,
    DETERMINISTIC_HEALTHY_CLOCK,
  );
  pipeline.processOrderBook(orderBook('bybit', 99, 100, 5_180), 5_180);
  pipeline.processOrderBook(orderBook('okx', 102, 103, 5_230), 5_230);
  pipeline.processOrderBook(
    orderBook('bybit', 99, 103, 5_240),
    5_240,
    unhealthyClock,
  );

  assert.deepEqual(
    events.map((event) => event.state),
    [
      'DETECTED',
      'VALIDATING',
      'QUALIFIED',
      'INVALID_SYNC',
      'DETECTED',
      'VALIDATING',
      'QUALIFIED',
      'DISAPPEARED',
    ],
  );
  assert.equal(events[3]?.currentSyncStatus, 'CLOCK_UNHEALTHY');
  assert.deepEqual(events[3]?.currentSyncReasons, ['CLOCK_UNHEALTHY']);
  assert.deepEqual(events.at(-1)?.currentQualificationReasons, [
    'NOT_NET_POSITIVE',
    'STALE',
  ]);
  assert.equal(events.at(-1)?.everQualified, true);
});

test('processing duration uses injected monotonic time when available', () => {
  const pipeline = new MarketPipeline({
    monotonicNow: () => 205.5,
    timingConfig: TEST_TIMING_CONFIG,
  });
  pipeline.processOrderBook(
    { ...orderBook('bybit', 99, 100, 6_000), receivedMonotonicMs: 100 },
    6_000,
  );
  const snapshot = pipeline.processOrderBook(
    { ...orderBook('okx', 102, 103, 6_010), receivedMonotonicMs: 200 },
    6_010,
  );
  assert.equal(snapshot?.processingDurationMs, 5.5);
});
