import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { FeeConfig } from '../config/fees.js';
import type { MarketQuoteRecord } from '../recording/market-recorder.js';
import type { OrderBookRecord } from '../recording/orderbook-recorder.js';
import type { OpportunityEvent } from '../scanner/opportunity.js';
import type { BestQuote } from '../types/market.js';
import { replayMarketData } from '../replay/replay-engine.js';
import { replayOrderBooks } from '../replay/orderbook-replay-engine.js';
import { MarketPipeline } from './pipeline.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';

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
    ['DETECTED', 'VALIDATING', 'ACTIVE', 'DISAPPEARED'],
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
  const direct = new MarketPipeline({
    fees: zeroFees,
    targetBaseSize: 0.2,
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
    ['DETECTED', 'VALIDATING', 'ACTIVE', 'DISAPPEARED'],
  );
  assert.deepEqual(
    replayEvents.map(comparableEvent),
    directEvents.map(comparableEvent),
  );
  assert.deepEqual(
    replay.getLatestDepthSnapshot()?.comparisons,
    direct.getLatestDepthSnapshot()?.comparisons,
  );
  assert.deepEqual(replay.getMetricsSummary(), direct.getMetricsSummary());
  assert.equal(replay.getMetricsSummary().comparisonsTotal, 8);
});
