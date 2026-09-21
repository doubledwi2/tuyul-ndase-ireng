import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INITIAL_PAPER_BALANCES,
  PAPER_EXECUTION_CONFIG,
  type PaperExecutionConfig,
} from '../config/paper.js';
import type { OpportunityEvent } from '../scanner/opportunity.js';
import type { OpportunityQualification } from '../scanner/opportunity-filter.js';
import { DETERMINISTIC_HEALTHY_CLOCK } from '../timing/clock-health.js';
import type { SyncAssessment } from '../timing/sync-model.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import type { PaperBalances } from './balances.js';
import { LatencyPaperTradingEngine } from './latency-engine.js';

const DECISION_AT = 1_000;

function book(
  exchange: 'bybit' | 'okx',
  timestamp: number,
  bid: number,
  ask: number,
  bidSize = 1,
  askSize = 1,
): NormalizedOrderBook {
  return {
    exchange,
    symbol: 'BTC/USDT',
    bids: [{ price: bid, size: bidSize }],
    asks: [{ price: ask, size: askSize }],
    exchangeTimestamp: timestamp,
    matchingEngineTimestamp: exchange === 'bybit' ? timestamp : null,
    receivedTimestamp: timestamp,
  };
}

function event(id = 'event-1'): OpportunityEvent {
  return {
    id,
    symbol: 'BTC/USDT',
    buyExchange: 'bybit',
    sellExchange: 'okx',
    state: 'QUALIFIED',
    detectedAt: 900,
    updatedAt: DECISION_AT,
    endedAt: null,
    lifetimeMs: null,
    qualifiedAt: DECISION_AT,
    timeToQualifiedMs: 100,
    everQualified: true,
    currentQualificationReasons: [],
    initialGrossSpreadPercent: 3,
    currentGrossSpreadPercent: 3,
    peakGrossSpreadPercent: 3,
    initialGrossSpreadAbsolute: 3,
    currentGrossSpreadAbsolute: 3,
    peakGrossSpreadAbsolute: 3,
    initialEstimatedNetSpreadPercent: 2.8,
    currentEstimatedNetSpreadPercent: 2.8,
    peakEstimatedNetSpreadPercent: 2.8,
    initialEstimatedNetPnlAbsolute: 0.02797,
    currentEstimatedNetPnlAbsolute: 0.02797,
    peakEstimatedNetPnlAbsolute: 0.02797,
    currentEstimatedTotalFee: 0.00203,
    targetBaseSize: 0.01,
    buyAverageExecutionPrice: 100,
    sellAverageExecutionPrice: 103,
    buySlippagePercent: 0,
    sellSlippagePercent: 0,
    simulatedBuyNotional: 1,
    simulatedSellNotional: 1.03,
    currentTradableSize: 0.01,
    peakTradableSize: 0.01,
    currentReceiveTimeDifferenceMs: 0,
    currentReceiveSkewMs: 0,
    currentSourceTimestampSkewMs: 0,
    currentMaxBookAgeMs: 0,
    currentSyncStatus: 'SYNC_HEALTHY',
    currentSyncReasons: [],
    peakReceiveSkewMs: 0,
    everActive: true,
    everInvalidSync: false,
  };
}

function stableSource() {
  return {
    rawObservedIngressMs: 0,
    baselineObservedIngressMs: 0,
    observedIngressDeviationMs: 0,
    offsetSampleCount: 30,
    offsetStatus: 'STABLE' as const,
  };
}

const SYNC: SyncAssessment = {
  status: 'SYNC_HEALTHY',
  receiveSkewMs: 0,
  sourceTimestampSkewMs: 0,
  matchingEngineSkewMs: null,
  bybitBookAgeMs: 0,
  okxBookAgeMs: 0,
  maxBookAgeMs: 0,
  bybitObservedIngressMs: 0,
  okxObservedIngressMs: 0,
  bybitObservedMatchingEngineIngressMs: null,
  okxObservedMatchingEngineIngressMs: null,
  bybitSourceClock: stableSource(),
  okxSourceClock: stableSource(),
  clockHealth: DETERMINISTIC_HEALTHY_CLOCK,
  reasons: [],
};

const QUALIFIED: OpportunityQualification = {
  qualified: true,
  reasons: [],
  netSpreadOk: true,
  netPnlOk: true,
  syncOk: true,
  depthOk: true,
  requiredActiveDurationMs: 100,
};

function executionConfig(
  overrides: Partial<PaperExecutionConfig> = {},
): PaperExecutionConfig {
  return { ...PAPER_EXECUTION_CONFIG, ...overrides };
}

function engine(options: {
  config?: Partial<PaperExecutionConfig>;
  balances?: PaperBalances;
} = {}): LatencyPaperTradingEngine {
  let id = 0;
  return new LatencyPaperTradingEngine({
    executionConfig: executionConfig(options.config),
    ...(options.balances === undefined
      ? {}
      : { initialBalances: options.balances }),
    idGenerator: () => `id-${++id}`,
  });
}

function trigger(
  paperEngine: LatencyPaperTradingEngine,
  opportunity = event(),
) {
  return paperEngine.triggerOpportunity({
    event: opportunity,
    bybitBook: book('bybit', DECISION_AT, 99, 100),
    okxBook: book('okx', DECISION_AT, 103, 104),
    syncAssessment: SYNC,
    latestQualification: QUALIFIED,
    timestamp: DECISION_AT,
  });
}

test('trigger reserves BUY USDT and SELL BTC without filling at decision time', () => {
  const paperEngine = engine();
  const trade = trigger(paperEngine);
  const balances = paperEngine.getBalances();
  assert.equal(trade.state, 'SUBMITTING');
  assert.equal(paperEngine.getFills().length, 0);
  assert.ok(Math.abs(balances.bybit.usdtReserved - 1.001) < 1e-12);
  assert.ok(Math.abs(balances.bybit.usdtAvailable - 9_998.999) < 1e-12);
  assert.equal(balances.okx.btcReserved, 0.01);
  assert.ok(Math.abs(balances.okx.btcAvailable - 0.09) < 1e-12);
});

test('no future leakage and no lookahead: pre-arrival and later better books are not used', () => {
  const paperEngine = engine();
  trigger(paperEngine);
  paperEngine.processOrderBook(book('bybit', 1_040, 89, 90), 1_040);
  assert.equal(paperEngine.getFills().length, 0);
  paperEngine.processOrderBook(book('bybit', 1_050, 99, 100), 1_050);
  paperEngine.processOrderBook(book('okx', 1_050, 103, 104), 1_050);
  paperEngine.processOrderBook(book('bybit', 1_060, 49, 50), 1_060);

  const buyFills = paperEngine.getFills().filter((fill) => fill.side === 'BUY');
  assert.equal(buyFills.length, 1);
  assert.equal(buyFills[0]?.timestamp, 1_050);
  assert.equal(buyFills[0]?.averagePrice, 100);
  assert.equal(paperEngine.getTrades()[0]?.outcome, 'CLEAN_FILL');
});

test('successive updates fill remaining size and retain multiple fill records', () => {
  const paperEngine = engine();
  trigger(paperEngine);
  const firstBuyUpdate = book('bybit', 1_050, 99, 100, 1, 0.004);
  paperEngine.processOrderBook(firstBuyUpdate, 1_050);
  paperEngine.processOrderBook(firstBuyUpdate, 1_050);
  assert.equal(paperEngine.getFills().length, 1);
  paperEngine.processOrderBook(book('okx', 1_050, 103, 104), 1_050);
  paperEngine.processOrderBook(book('bybit', 1_060, 99, 100, 1, 0.006), 1_060);

  const trade = paperEngine.getTrades()[0];
  assert.equal(paperEngine.getFills().length, 3);
  assert.equal(trade?.buyFilledSize, 0.01);
  assert.equal(trade?.sellFilledSize, 0.01);
  assert.equal(trade?.outcome, 'CLEAN_FILL');
});

test('two simultaneous candidates cannot oversubscribe reserved funds', () => {
  const balances: PaperBalances = {
    bybit: {
      ...INITIAL_PAPER_BALANCES.bybit,
      usdtAvailable: 1.5,
    },
    okx: { ...INITIAL_PAPER_BALANCES.okx },
  };
  const paperEngine = engine({ balances });
  assert.equal(trigger(paperEngine, event('event-a')).state, 'SUBMITTING');
  const rejected = trigger(paperEngine, event('event-b'));
  assert.equal(rejected.state, 'REJECTED');
  assert.equal(rejected.rejectionReason, 'INSUFFICIENT_BUY_USDT');
  assert.ok(paperEngine.getBalances().bybit.usdtAvailable >= 0);
  assert.equal(paperEngine.getMetrics().pretradeRejections, 1);
  assert.equal(paperEngine.getMetrics().executionFailures, 0);
});

test('duplicate opportunity cannot create another entry order pair', () => {
  const paperEngine = engine();
  trigger(paperEngine);
  const duplicate = trigger(paperEngine);
  assert.equal(duplicate.rejectionReason, 'DUPLICATE_EVENT');
  assert.equal(paperEngine.getOrders().length, 2);
});

test('timeout with no fills releases every reservation', () => {
  const paperEngine = engine({ config: { allowPartialFill: false } });
  trigger(paperEngine);
  paperEngine.processOrderBook(book('bybit', 1_050, 99, 100, 1, 0.001), 1_050);
  paperEngine.processOrderBook(book('okx', 1_050, 103, 104, 0.001, 1), 1_050);
  paperEngine.finish();

  const trade = paperEngine.getTrades()[0];
  assert.equal(trade?.outcome, 'TIMEOUT_NO_FILL');
  assert.equal(paperEngine.getMetrics().timeouts, 2);
  assert.deepEqual(paperEngine.getBalances(), {
    bybit: { ...INITIAL_PAPER_BALANCES.bybit },
    okx: { ...INITIAL_PAPER_BALANCES.okx },
  });
  paperEngine.processOrderBook(book('bybit', 1_300, 99, 100), 1_300);
  paperEngine.processOrderBook(book('okx', 1_300, 103, 104), 1_300);
  assert.equal(paperEngine.getFills().length, 0);
});

test('BUY-only and SELL-only execution failures remain distinguishable', () => {
  const buyOnly = engine({
    config: { allowPartialFill: false, maxUnhedgedDurationMs: 300 },
  });
  trigger(buyOnly);
  buyOnly.processOrderBook(book('bybit', 1_050, 99, 100), 1_050);
  buyOnly.processOrderBook(book('okx', 1_050, 103, 104, 0.001, 1), 1_050);
  buyOnly.finish();
  assert.equal(buyOnly.getTrades()[0]?.outcome, 'BUY_ONLY');
  assert.equal(buyOnly.getTrades()[0]?.state, 'FAILED');

  const sellOnly = engine({
    config: { allowPartialFill: false, maxUnhedgedDurationMs: 300 },
  });
  trigger(sellOnly);
  sellOnly.processOrderBook(book('bybit', 1_050, 99, 100, 1, 0.001), 1_050);
  sellOnly.processOrderBook(book('okx', 1_050, 103, 104), 1_050);
  sellOnly.finish();
  assert.equal(sellOnly.getTrades()[0]?.outcome, 'SELL_ONLY');
  assert.equal(sellOnly.getTrades()[0]?.state, 'FAILED');
});

test('partial mismatch is explicit when unwind threshold has not elapsed', () => {
  const paperEngine = engine({ config: { maxUnhedgedDurationMs: 300 } });
  trigger(paperEngine);
  paperEngine.processOrderBook(book('bybit', 1_050, 99, 100, 1, 0.006), 1_050);
  paperEngine.processOrderBook(book('okx', 1_050, 103, 104, 0.004, 1), 1_050);
  paperEngine.finish();
  const trade = paperEngine.getTrades()[0];
  assert.equal(trade?.outcome, 'PARTIAL_BOTH');
  assert.equal(trade?.state, 'FAILED');
  assert.ok(Math.abs((trade?.residualBaseExposure ?? 0) - 0.002) < 1e-12);
});

test('unhedged BUY excess is unwound on current book with fee and zero residual', () => {
  const paperEngine = engine();
  trigger(paperEngine);
  paperEngine.processOrderBook(book('bybit', 1_050, 99, 100), 1_050);
  paperEngine.processOrderBook(book('okx', 1_050, 103, 104, 0.006, 1), 1_050);
  paperEngine.processOrderBook(book('bybit', 1_250, 98, 99), 1_250);

  const trade = paperEngine.getTrades()[0];
  const unwindFill = paperEngine.getFills().find((fill) => fill.isUnwind);
  assert.equal(trade?.outcome, 'UNWOUND');
  assert.equal(trade?.state, 'CLOSED');
  assert.equal(trade?.residualBaseExposure, 0);
  assert.equal(unwindFill?.side, 'SELL');
  assert.ok((unwindFill?.fee ?? 0) > 0);
});

test('insufficient unwind depth leaves residual exposure and fails trade', () => {
  const paperEngine = engine();
  trigger(paperEngine);
  paperEngine.processOrderBook(book('bybit', 1_050, 99, 100), 1_050);
  paperEngine.processOrderBook(book('okx', 1_050, 103, 104, 0.006, 1), 1_050);
  paperEngine.processOrderBook(book('bybit', 1_250, 98, 99, 0.001, 1), 1_250);

  const trade = paperEngine.getTrades()[0];
  assert.equal(trade?.outcome, 'UNWIND_FAILED');
  assert.equal(trade?.state, 'FAILED');
  assert.ok(Math.abs((trade?.residualBaseExposure ?? 0) - 0.003) < 1e-12);
  assert.equal(paperEngine.getMetrics().unwindFailures, 1);
});

test('SELL excess uses a BUY unwind on the sell venue', () => {
  const paperEngine = engine({ config: { allowPartialFill: false } });
  trigger(paperEngine);
  paperEngine.processOrderBook(book('bybit', 1_050, 99, 100, 1, 0.001), 1_050);
  paperEngine.processOrderBook(book('okx', 1_050, 103, 104), 1_050);
  paperEngine.processOrderBook(book('okx', 1_250, 103, 104), 1_250);

  const trade = paperEngine.getTrades()[0];
  const unwindFill = paperEngine.getFills().find((fill) => fill.isUnwind);
  assert.equal(trade?.outcome, 'UNWOUND');
  assert.equal(trade?.residualBaseExposure, 0);
  assert.equal(unwindFill?.exchange, 'okx');
  assert.equal(unwindFill?.side, 'BUY');
});
