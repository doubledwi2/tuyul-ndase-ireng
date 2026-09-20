import assert from 'node:assert/strict';
import test from 'node:test';

import { OPPORTUNITY_QUALITY_CONFIG } from '../config/opportunity.js';
import type { DepthComparison } from './depth-comparator.js';
import type { ExecutionSimulation } from './execution-simulator.js';
import { qualifyOpportunity } from './opportunity-filter.js';
import { DETERMINISTIC_HEALTHY_CLOCK } from '../timing/clock-health.js';
import type { SyncAssessment } from '../timing/sync-model.js';

function warmingSyncAssessment(): SyncAssessment {
  const sourceClock = {
    rawObservedIngressMs: -120,
    baselineObservedIngressMs: -120,
    observedIngressDeviationMs: 0,
    offsetSampleCount: 1,
    offsetStatus: 'WARMING_UP' as const,
  };
  return {
    status: 'SYNC_WARMING_UP',
    receiveSkewMs: 10,
    sourceTimestampSkewMs: 5,
    matchingEngineSkewMs: null,
    bybitBookAgeMs: 10,
    okxBookAgeMs: 20,
    maxBookAgeMs: 20,
    bybitObservedIngressMs: -120,
    okxObservedIngressMs: -125,
    bybitObservedMatchingEngineIngressMs: -121,
    okxObservedMatchingEngineIngressMs: null,
    bybitSourceClock: sourceClock,
    okxSourceClock: { ...sourceClock, rawObservedIngressMs: -125 },
    clockHealth: DETERMINISTIC_HEALTHY_CLOCK,
    reasons: ['SYNC_WARMING_UP'],
  };
}

function execution(side: 'BUY' | 'SELL'): ExecutionSimulation {
  return {
    side,
    requestedSize: 0.01,
    filledSize: 0.01,
    unfilledSize: 0,
    fullyFilled: true,
    notional: 100,
    averageExecutionPrice: 10_000,
    bestPrice: 10_000,
    slippageAbsolute: 0,
    slippagePercent: 0,
  };
}

function comparison(overrides: Partial<DepthComparison> = {}): DepthComparison {
  return {
    symbol: 'BTC/USDT',
    buyExchange: 'bybit',
    sellExchange: 'okx',
    targetBaseSize: 0.01,
    buyExecution: execution('BUY'),
    sellExecution: execution('SELL'),
    buyFeeRate: 0.001,
    sellFeeRate: 0.001,
    simulatedBuyNotional: 100,
    simulatedSellNotional: 100.2,
    estimatedBuyFee: 0.1,
    estimatedSellFee: 0.1002,
    estimatedTotalFee: 0.2002,
    grossPnlAbsolute: 0.4,
    estimatedNetPnlAbsolute: 0.02,
    estimatedNetSpreadPercent: 0.04,
    bestGrossSpreadAbsolute: 40,
    bestGrossSpreadPercent: 0.4,
    tradableSize: 0.01,
    buyReceivedTimestamp: 1_000,
    sellReceivedTimestamp: 1_020,
    receiveTimeDifferenceMs: 20,
    syncStatus: 'SYNC_OK',
    status: 'EXECUTABLE_NET_POSITIVE',
    ...overrides,
  };
}

test('rejects net-positive comparison below spread threshold', () => {
  const result = qualifyOpportunity(
    comparison({ estimatedNetSpreadPercent: 0.029 }),
    OPPORTUNITY_QUALITY_CONFIG,
  );
  assert.equal(result.qualified, false);
  assert.deepEqual(result.reasons, ['NET_SPREAD_TOO_SMALL']);
});

test('rejects net-positive comparison below PnL threshold', () => {
  const result = qualifyOpportunity(
    comparison({ estimatedNetPnlAbsolute: 0.009 }),
    OPPORTUNITY_QUALITY_CONFIG,
  );
  assert.deepEqual(result.reasons, ['NET_PNL_TOO_SMALL']);
});

test('rejects an otherwise valid comparison with wide sync', () => {
  const result = qualifyOpportunity(
    comparison({ receiveTimeDifferenceMs: 101 }),
    OPPORTUNITY_QUALITY_CONFIG,
  );
  assert.deepEqual(result.reasons, ['SYNC_TOO_WIDE']);
});

test('reports insufficient depth as a structural rejection', () => {
  const partial = { ...execution('BUY'), fullyFilled: false, filledSize: 0.005 };
  const result = qualifyOpportunity(
    comparison({
      buyExecution: partial,
      status: 'INSUFFICIENT_DEPTH',
      estimatedNetPnlAbsolute: null,
      estimatedNetSpreadPercent: null,
    }),
    OPPORTUNITY_QUALITY_CONFIG,
  );
  assert.deepEqual(result.reasons, ['INSUFFICIENT_DEPTH']);
});

test('reports stale separately from ordinary quality failures', () => {
  const result = qualifyOpportunity(
    comparison({ status: 'STALE', syncStatus: 'STALE' }),
    OPPORTUNITY_QUALITY_CONFIG,
  );
  assert.deepEqual(result.reasons, ['STALE']);
});

test('accepts comparison when every quality rule passes', () => {
  const result = qualifyOpportunity(comparison(), OPPORTUNITY_QUALITY_CONFIG);
  assert.equal(result.qualified, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.requiredActiveDurationMs, 100);
});

test('does not qualify a candidate while source clocks are warming up', () => {
  const result = qualifyOpportunity(
    comparison(),
    OPPORTUNITY_QUALITY_CONFIG,
    warmingSyncAssessment(),
  );
  assert.equal(result.qualified, false);
  assert.equal(result.syncOk, false);
  assert.deepEqual(result.reasons, ['STALE']);
});
