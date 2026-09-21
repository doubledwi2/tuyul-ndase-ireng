import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAPER_RISK_CONFIG,
  type PaperRiskConfig,
} from '../config/risk.js';
import type { PaperBalances } from '../paper/balances.js';
import {
  PaperRiskManager,
  type PaperRiskAssessmentInput,
  type PaperRiskTradeSnapshot,
} from './paper-risk-manager.js';

function config(
  overrides: Partial<PaperRiskConfig> = {},
): PaperRiskConfig {
  return { ...PAPER_RISK_CONFIG, ...overrides };
}

function balances(
  overrides: Partial<{
    bybitBtc: number;
    okxBtc: number;
    bybitUsdt: number;
    okxUsdt: number;
  }> = {},
): PaperBalances {
  return {
    bybit: {
      exchange: 'bybit',
      btcAvailable: overrides.bybitBtc ?? 0.1,
      btcReserved: 0,
      usdtAvailable: overrides.bybitUsdt ?? 10_000,
      usdtReserved: 0,
    },
    okx: {
      exchange: 'okx',
      btcAvailable: overrides.okxBtc ?? 0.1,
      btcReserved: 0,
      usdtAvailable: overrides.okxUsdt ?? 10_000,
      usdtReserved: 0,
    },
  };
}

function trade(
  id: string,
  overrides: Partial<PaperRiskTradeSnapshot> = {},
): PaperRiskTradeSnapshot {
  return {
    id,
    buyExchange: 'bybit',
    sellExchange: 'okx',
    state: 'SUBMITTING',
    outcome: null,
    closedAt: null,
    residualBaseExposure: 0,
    realizedPaperPnl: 0,
    ...overrides,
  };
}

function assessment(
  overrides: Partial<PaperRiskAssessmentInput> = {},
): PaperRiskAssessmentInput {
  return {
    balances: balances(),
    trades: [],
    buyExchange: 'bybit',
    sellExchange: 'okx',
    requestedBaseSize: 0.01,
    projectedBuyUsdtCost: 1_000,
    ...overrides,
  };
}

test('direction worsening BTC venue imbalance is rejected while improving direction is allowed', () => {
  const paperBalances = balances({ bybitBtc: 0.16, okxBtc: 0.04 });
  const riskConfig = config({
    maxTotalBtcExposure: 1,
    maxVenueBtcImbalance: 0.05,
    minVenueBtcReserve: 0,
    minVenueUsdtReserve: 0,
    maxUnhedgedBtc: 1,
  });

  const worsening = new PaperRiskManager(riskConfig).assess(
    assessment({ balances: paperBalances }),
  );
  assert.equal(worsening.allowed, false);
  assert.ok(worsening.reasons.includes('VENUE_BTC_IMBALANCE'));

  const improving = new PaperRiskManager(riskConfig).assess(
    assessment({
      balances: paperBalances,
      buyExchange: 'okx',
      sellExchange: 'bybit',
    }),
  );
  assert.equal(improving.allowed, true);
  assert.deepEqual(improving.reasons, []);
});

test('projected BTC and USDT minimum reserves reject before balance mutation', () => {
  const original = balances({ okxBtc: 0.025, bybitUsdt: 1_005 });
  original.okx.btcReserved = 0.075;
  original.bybit.usdtReserved = 8_995;
  const snapshot = structuredClone(original);
  const manager = new PaperRiskManager(
    config({
      maxTotalBtcExposure: 1,
      maxVenueBtcImbalance: 1,
      maxUnhedgedBtc: 1,
    }),
  );
  const decision = manager.assess(
    assessment({ balances: original, projectedBuyUsdtCost: 10 }),
  );

  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes('LOW_BTC_RESERVE'));
  assert.ok(decision.reasons.includes('LOW_USDT_RESERVE'));
  assert.deepEqual(original, snapshot);
});

test('open trade limit releases capacity when a trade becomes terminal', () => {
  const manager = new PaperRiskManager(
    config({
      maxTotalBtcExposure: 1,
      maxVenueBtcImbalance: 1,
      minVenueBtcReserve: 0,
      minVenueUsdtReserve: 0,
      maxUnhedgedBtc: 1,
      maxOpenPaperTrades: 3,
    }),
  );
  const open = [trade('one'), trade('two'), trade('three')];
  const blocked = manager.assess(assessment({ trades: open }));
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reasons.includes('MAX_OPEN_TRADES'));

  const withCapacity = [
    { ...open[0]!, state: 'CLOSED', closedAt: 10 },
    open[1]!,
    open[2]!,
  ];
  assert.equal(manager.assess(assessment({ trades: withCapacity })).allowed, true);
});

test('global unhedged guard blocks worsening direction and allows offsetting direction', () => {
  const residual = trade('residual', {
    state: 'FAILED',
    outcome: 'UNWIND_FAILED',
    closedAt: 10,
    residualBaseExposure: 0.009,
  });
  const riskConfig = config({
    maxTotalBtcExposure: 1,
    maxVenueBtcImbalance: 1,
    minVenueBtcReserve: 0,
    minVenueUsdtReserve: 0,
    maxUnhedgedBtc: 0.01,
  });

  const worsening = new PaperRiskManager(riskConfig).assess(
    assessment({ trades: [residual], requestedBaseSize: 0.005 }),
  );
  assert.equal(worsening.allowed, false);
  assert.ok(worsening.reasons.includes('MAX_UNHEDGED_EXPOSURE'));

  const reducing = new PaperRiskManager(riskConfig).assess(
    assessment({
      trades: [residual],
      buyExchange: 'okx',
      sellExchange: 'bybit',
      requestedBaseSize: 0.005,
    }),
  );
  assert.equal(reducing.allowed, true);

  const overshooting = new PaperRiskManager(riskConfig).assess(
    assessment({
      trades: [residual],
      buyExchange: 'okx',
      sellExchange: 'bybit',
      requestedBaseSize: 0.02,
    }),
  );
  assert.equal(overshooting.allowed, false);
  assert.ok(overshooting.reasons.includes('MAX_UNHEDGED_EXPOSURE'));
});

test('total BTC exposure uses projected one-leg risk and venue percentages include reservations', () => {
  const manager = new PaperRiskManager(
    config({
      maxTotalBtcExposure: 0.205,
      maxVenueBtcImbalance: 1,
      minVenueBtcReserve: 0,
      minVenueUsdtReserve: 0,
      maxUnhedgedBtc: 1,
    }),
  );
  const decision = manager.assess(assessment({ requestedBaseSize: 0.01 }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes('MAX_TOTAL_BTC_EXPOSURE'));

  const reserved = balances();
  reserved.bybit.btcAvailable = 0.08;
  reserved.bybit.btcReserved = 0.02;
  reserved.okx.usdtAvailable = 8_000;
  reserved.okx.usdtReserved = 2_000;
  const metrics = manager.getSummary(reserved, []).metrics;
  assert.equal(metrics.bybitBtcPercentage, 50);
  assert.equal(metrics.okxUsdtPercentage, 50);
});

test('session loss limit creates a sticky risk halt for new entries', () => {
  const manager = new PaperRiskManager(
    config({
      maxTotalBtcExposure: 1,
      maxVenueBtcImbalance: 1,
      minVenueBtcReserve: 0,
      minVenueUsdtReserve: 0,
      maxUnhedgedBtc: 1,
      maxSessionPaperLossUsdt: 1,
    }),
  );
  manager.observeTerminalTrade(
    trade('loss', {
      state: 'CLOSED',
      outcome: 'CLEAN_FILL',
      closedAt: 10,
      realizedPaperPnl: -1,
    }),
  );

  const decision = manager.assess(assessment());
  const summary = manager.getSummary(balances(), []);
  assert.equal(summary.state, 'RISK_HALTED');
  assert.deepEqual(summary.haltReasons, ['SESSION_LOSS_LIMIT']);
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes('SESSION_LOSS_LIMIT'));
});

test('consecutive failures reset on success before threshold then halt at threshold', () => {
  const manager = new PaperRiskManager(
    config({
      maxTotalBtcExposure: 1,
      maxVenueBtcImbalance: 1,
      minVenueBtcReserve: 0,
      minVenueUsdtReserve: 0,
      maxUnhedgedBtc: 1,
      maxSessionPaperLossUsdt: 1_000,
      maxConsecutiveExecutionFailures: 3,
    }),
  );
  manager.observeTerminalTrade(
    trade('failure-before-reset', {
      state: 'FAILED',
      outcome: 'BUY_ONLY',
      closedAt: 1,
    }),
  );
  manager.observeTerminalTrade(
    trade('success', {
      state: 'CLOSED',
      outcome: 'UNWOUND',
      closedAt: 2,
    }),
  );
  assert.equal(manager.getSummary(balances(), []).consecutiveFailures, 0);

  for (let index = 0; index < 3; index += 1) {
    manager.observeTerminalTrade(
      trade(`failure-${index}`, {
        state: 'FAILED',
        outcome: 'UNWIND_FAILED',
        closedAt: 3 + index,
      }),
    );
  }
  const summary = manager.getSummary(balances(), []);
  assert.equal(summary.state, 'RISK_HALTED');
  assert.equal(summary.consecutiveFailures, 3);
  assert.ok(summary.haltReasons.includes('CONSECUTIVE_FAILURE_LIMIT'));
  assert.ok(
    manager.assess(assessment()).reasons.includes(
      'CONSECUTIVE_FAILURE_LIMIT',
    ),
  );
});

test('rebalancing suggestions are deterministic and balanced inventory emits none', () => {
  const manager = new PaperRiskManager(config());
  const skewed = manager.getRebalanceSuggestions(
    balances({ bybitBtc: 0.16, okxBtc: 0.04 }),
  );
  assert.deepEqual(skewed, [
    {
      fromExchange: 'bybit',
      toExchange: 'okx',
      asset: 'BTC',
      amount: 0.06,
      reason:
        'BTC allocation 80.00% Bybit / 20.00% OKX exceeds the 50/50 tolerance band',
    },
  ]);
  assert.deepEqual(manager.getRebalanceSuggestions(balances()), []);
});

test('identical risk sequences produce identical decisions, metrics, and suggestions', () => {
  const run = () => {
    const manager = new PaperRiskManager(config());
    const decisions = [
      manager.assess(assessment()),
      manager.assess(
        assessment({
          balances: balances({ bybitBtc: 0.16, okxBtc: 0.04 }),
        }),
      ),
    ];
    return {
      decisions,
      summary: manager.getSummary(
        balances({ bybitBtc: 0.16, okxBtc: 0.04 }),
        [],
      ),
    };
  };
  assert.deepEqual(run(), run());
});
