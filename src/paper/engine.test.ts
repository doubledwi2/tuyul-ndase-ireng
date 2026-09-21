import assert from 'node:assert/strict';
import test from 'node:test';

import type { OpportunityEvent } from '../scanner/opportunity.js';
import type { OpportunityQualification } from '../scanner/opportunity-filter.js';
import { DETERMINISTIC_HEALTHY_CLOCK } from '../timing/clock-health.js';
import type { SyncAssessment } from '../timing/sync-model.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import type { PaperBalances } from './balances.js';
import { PaperTradingEngine } from './engine.js';

const NOW = 1_000;

function book(
  exchange: 'bybit' | 'okx',
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
    exchangeTimestamp: NOW,
    matchingEngineTimestamp: null,
    receivedTimestamp: NOW,
  };
}

function event(overrides: Partial<OpportunityEvent> = {}): OpportunityEvent {
  return {
    id: 'opportunity-1',
    symbol: 'BTC/USDT',
    buyExchange: 'bybit',
    sellExchange: 'okx',
    state: 'QUALIFIED',
    detectedAt: NOW - 50,
    updatedAt: NOW,
    endedAt: null,
    lifetimeMs: null,
    qualifiedAt: NOW,
    timeToQualifiedMs: 50,
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
    ...overrides,
  };
}

function stableSource(raw: number) {
  return {
    rawObservedIngressMs: raw,
    baselineObservedIngressMs: raw,
    observedIngressDeviationMs: 0,
    offsetSampleCount: 30,
    offsetStatus: 'STABLE' as const,
  };
}

function sync(overrides: Partial<SyncAssessment> = {}): SyncAssessment {
  return {
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
    bybitSourceClock: stableSource(0),
    okxSourceClock: stableSource(0),
    clockHealth: DETERMINISTIC_HEALTHY_CLOCK,
    reasons: [],
    ...overrides,
  };
}

function engine(initialBalances?: PaperBalances): PaperTradingEngine {
  let id = 0;
  return new PaperTradingEngine({
    ...(initialBalances === undefined ? {} : { initialBalances }),
    idGenerator: () => `paper-${++id}`,
  });
}

function execute(
  paperEngine: PaperTradingEngine,
  overrides: {
    event?: OpportunityEvent;
    bybitBook?: NormalizedOrderBook;
    okxBook?: NormalizedOrderBook;
    syncAssessment?: SyncAssessment;
    latestQualification?: OpportunityQualification;
    timestamp?: number;
  } = {},
) {
  return paperEngine.executeQualifiedOpportunity({
    event: overrides.event ?? event(),
    bybitBook: overrides.bybitBook ?? book('bybit', 99, 100),
    okxBook: overrides.okxBook ?? book('okx', 103, 104),
    syncAssessment: overrides.syncAssessment ?? sync(),
    ...(overrides.latestQualification === undefined
      ? {}
      : { latestQualification: overrides.latestQualification }),
    timestamp: overrides.timestamp ?? NOW,
  });
}

test('QUALIFIED opportunity executes with correct notional, fees, and net PnL', () => {
  const paperEngine = engine();
  const trade = execute(paperEngine);
  assert.equal(trade.state, 'FILLED');
  assert.equal(trade.buyNotional, 1);
  assert.equal(trade.sellNotional, 1.03);
  assert.equal(trade.buyFee, 0.001);
  assert.equal(trade.sellFee, 0.00103);
  assert.ok(Math.abs((trade.netPnl ?? 0) - 0.02797) < 1e-12);
  const balances = paperEngine.getBalances();
  assert.ok(Math.abs(balances.bybit.btcAvailable - 0.11) < 1e-12);
  assert.ok(Math.abs(balances.bybit.usdtAvailable - 9_998.999) < 1e-12);
  assert.ok(Math.abs(balances.okx.btcAvailable - 0.09) < 1e-12);
  assert.ok(Math.abs(balances.okx.usdtAvailable - 10_001.02897) < 1e-9);
});

test('non-qualified event is rejected without balance mutation', () => {
  const paperEngine = engine();
  const before = paperEngine.getBalances();
  const trade = execute(paperEngine, { event: event({ state: 'VALIDATING' }) });
  assert.equal(trade.rejectionReason, 'NOT_QUALIFIED');
  assert.deepEqual(paperEngine.getBalances(), before);
});

test('duplicate opportunity event cannot fill twice', () => {
  const paperEngine = engine();
  assert.equal(execute(paperEngine).state, 'FILLED');
  const afterFirst = paperEngine.getBalances();
  const duplicate = execute(paperEngine);
  assert.equal(duplicate.rejectionReason, 'DUPLICATE_EVENT');
  assert.deepEqual(paperEngine.getBalances(), afterFirst);
  assert.equal(paperEngine.getSummary().tradesFilled, 1);
});

test('stale opportunity is rejected', () => {
  const paperEngine = engine();
  const trade = execute(paperEngine, { timestamp: NOW + 101 });
  assert.equal(trade.rejectionReason, 'STALE_OPPORTUNITY');
});

test('sync unhealthy opportunity is rejected', () => {
  const paperEngine = engine();
  const trade = execute(paperEngine, {
    syncAssessment: sync({
      status: 'RECEIVE_SKEW_HIGH',
      reasons: ['RECEIVE_SKEW_HIGH'],
    }),
  });
  assert.equal(trade.rejectionReason, 'SYNC_UNHEALTHY');
});

test('net non-positive execution is rejected', () => {
  const paperEngine = engine();
  const trade = execute(paperEngine, {
    okxBook: book('okx', 100, 101),
  });
  assert.equal(trade.rejectionReason, 'NET_NOT_POSITIVE');
});

test('latest quality failure rejects an otherwise net-positive trigger', () => {
  const paperEngine = engine();
  const trade = execute(paperEngine, {
    latestQualification: {
      qualified: false,
      reasons: ['NET_SPREAD_TOO_SMALL'],
      netSpreadOk: false,
      netPnlOk: true,
      syncOk: true,
      depthOk: true,
      requiredActiveDurationMs: 100,
    },
  });
  assert.equal(trade.rejectionReason, 'NOT_QUALIFIED');
});

test('insufficient buy USDT rejects with balances unchanged', () => {
  const paperEngine = engine({
    bybit: { exchange: 'bybit', btcAvailable: 0.1, usdtAvailable: 0.5 },
    okx: { exchange: 'okx', btcAvailable: 0.1, usdtAvailable: 10_000 },
  });
  const before = paperEngine.getBalances();
  const trade = execute(paperEngine);
  assert.equal(trade.rejectionReason, 'INSUFFICIENT_BUY_USDT');
  assert.deepEqual(paperEngine.getBalances(), before);
});

test('insufficient sell BTC rejects with balances unchanged', () => {
  const paperEngine = engine({
    bybit: { exchange: 'bybit', btcAvailable: 0.1, usdtAvailable: 10_000 },
    okx: { exchange: 'okx', btcAvailable: 0.005, usdtAvailable: 10_000 },
  });
  const before = paperEngine.getBalances();
  const trade = execute(paperEngine);
  assert.equal(trade.rejectionReason, 'INSUFFICIENT_SELL_BTC');
  assert.deepEqual(paperEngine.getBalances(), before);
});

test('buy fills but sell depth fails atomically', () => {
  const paperEngine = engine();
  const before = paperEngine.getBalances();
  const trade = execute(paperEngine, {
    okxBook: book('okx', 103, 104, 0.005, 1),
  });
  assert.equal(trade.rejectionReason, 'INSUFFICIENT_DEPTH');
  assert.deepEqual(paperEngine.getBalances(), before);
});

test('sell fills but buy depth fails atomically', () => {
  const paperEngine = engine();
  const before = paperEngine.getBalances();
  const trade = execute(paperEngine, {
    bybitBook: book('bybit', 99, 100, 1, 0.005),
  });
  assert.equal(trade.rejectionReason, 'INSUFFICIENT_DEPTH');
  assert.deepEqual(paperEngine.getBalances(), before);
});

test('portfolio summary distinguishes net trade PnL from MTM value', () => {
  const paperEngine = engine();
  const bybitBook = book('bybit', 99, 100);
  const okxBook = book('okx', 103, 104);
  paperEngine.observeBooks(bybitBook, okxBook);
  execute(paperEngine, { bybitBook, okxBook });
  const summary = paperEngine.getSummary();
  assert.ok(Math.abs(summary.netTradePnl - 0.02797) < 1e-12);
  assert.ok(
    summary.paperPortfolioPnlUsdt !== null &&
      Math.abs(summary.paperPortfolioPnlUsdt - 0.02797) < 1e-9,
  );
  assert.equal(summary.totalBTC, 0.2);
});
