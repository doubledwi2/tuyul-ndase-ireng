import assert from 'node:assert/strict';
import test from 'node:test';

import type { DepthComparison } from './depth-comparator.js';
import type { ExecutionSimulation } from './execution-simulator.js';
import { OpportunityTracker } from './opportunity.js';

const START = 1_700_000_000_000;

function execution(side: 'BUY' | 'SELL'): ExecutionSimulation {
  return {
    side,
    requestedSize: 0.01,
    filledSize: 0.01,
    unfilledSize: 0,
    fullyFilled: true,
    notional: side === 'BUY' ? 1 : 1.01,
    averageExecutionPrice: side === 'BUY' ? 100 : 101,
    bestPrice: side === 'BUY' ? 100 : 101,
    slippageAbsolute: 0,
    slippagePercent: 0,
  };
}

function comparison(
  overrides: Partial<DepthComparison> = {},
): DepthComparison {
  return {
    symbol: 'BTC/USDT',
    buyExchange: 'bybit',
    sellExchange: 'okx',
    targetBaseSize: 0.01,
    buyExecution: execution('BUY'),
    sellExecution: execution('SELL'),
    buyFeeRate: 0.001,
    sellFeeRate: 0.001,
    simulatedBuyNotional: 1,
    simulatedSellNotional: 1.01,
    estimatedBuyFee: 0.001,
    estimatedSellFee: 0.00101,
    estimatedTotalFee: 0.00201,
    grossPnlAbsolute: 0.01,
    estimatedNetPnlAbsolute: 0.00799,
    estimatedNetSpreadPercent: 0.799,
    bestGrossSpreadAbsolute: 1,
    bestGrossSpreadPercent: 1,
    tradableSize: 0.01,
    buyReceivedTimestamp: START - 10,
    sellReceivedTimestamp: START - 5,
    receiveTimeDifferenceMs: 5,
    syncStatus: 'SYNC_OK',
    status: 'EXECUTABLE_NET_POSITIVE',
    ...overrides,
  };
}

function netNonPositive(): DepthComparison {
  return comparison({
    estimatedNetPnlAbsolute: -0.01,
    estimatedNetSpreadPercent: -1,
    status: 'EXECUTABLE_NET_ZERO_OR_NEGATIVE',
  });
}

test('gross positive but simulated net negative creates no event', () => {
  assert.equal(new OpportunityTracker().process(netNonPositive(), START), null);
});

test('net positive observations promote DETECTED, VALIDATING, and ACTIVE', () => {
  const tracker = new OpportunityTracker();
  const detected = tracker.process(comparison(), START);
  const validating = tracker.process(comparison(), START + 1);
  const active = tracker.process(comparison(), START + 2);
  assert.equal(detected?.state, 'DETECTED');
  assert.equal(validating?.state, 'VALIDATING');
  assert.equal(active?.state, 'ACTIVE');
  assert.equal(detected?.id, active?.id);
});

test('stale comparison creates no event but invalidates a live event', () => {
  const stale = comparison({ status: 'STALE', syncStatus: 'STALE' });
  const emptyTracker = new OpportunityTracker();
  assert.equal(emptyTracker.process(stale, START), null);

  const tracker = new OpportunityTracker();
  const detected = tracker.process(comparison(), START);
  const invalid = tracker.process(stale, START + 1);
  const redetected = tracker.process(comparison(), START + 2);
  assert.equal(invalid?.state, 'INVALID_SYNC');
  assert.equal(redetected?.state, 'DETECTED');
  assert.equal(detected?.id, invalid?.id);
});

test('active event disappears when simulated net becomes non-positive', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison(), START);
  tracker.process(comparison(), START + 1);
  tracker.process(comparison(), START + 2);
  const disappeared = tracker.process(netNonPositive(), START + 50);
  assert.equal(disappeared?.state, 'DISAPPEARED');
  assert.equal(disappeared?.lifetimeMs, 50);
});

test('active event disappears on insufficient depth', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison(), START);
  tracker.process(comparison(), START + 1);
  tracker.process(comparison(), START + 2);
  const partialBuy = {
    ...execution('BUY'),
    filledSize: 0.005,
    unfilledSize: 0.005,
    fullyFilled: false,
  };
  const disappeared = tracker.process(
    comparison({
      buyExecution: partialBuy,
      simulatedBuyNotional: null,
      simulatedSellNotional: null,
      estimatedBuyFee: null,
      estimatedSellFee: null,
      estimatedTotalFee: null,
      grossPnlAbsolute: null,
      estimatedNetPnlAbsolute: null,
      estimatedNetSpreadPercent: null,
      tradableSize: 0.005,
      status: 'INSUFFICIENT_DEPTH',
    }),
    START + 3,
  );
  assert.equal(disappeared?.state, 'DISAPPEARED');
  assert.equal(disappeared?.buyAverageExecutionPrice, 100);
});

test('tracks peak estimated net spread and PnL using max', () => {
  const tracker = new OpportunityTracker();
  tracker.process(
    comparison({ estimatedNetSpreadPercent: 0.4, estimatedNetPnlAbsolute: 0.2 }),
    START,
  );
  tracker.process(
    comparison({ estimatedNetSpreadPercent: 0.9, estimatedNetPnlAbsolute: 0.7 }),
    START + 1,
  );
  const event = tracker.process(
    comparison({ estimatedNetSpreadPercent: 0.6, estimatedNetPnlAbsolute: 0.5 }),
    START + 2,
  );
  assert.equal(event?.peakEstimatedNetSpreadPercent, 0.9);
  assert.equal(event?.peakEstimatedNetPnlAbsolute, 0.7);
});

test('tracks directions independently and carries simulated execution fields', () => {
  const tracker = new OpportunityTracker();
  const first = tracker.process(comparison(), START);
  const reverse = tracker.process(
    comparison({ buyExchange: 'okx', sellExchange: 'bybit' }),
    START,
  );
  assert.notEqual(first?.id, reverse?.id);
  assert.equal(first?.targetBaseSize, 0.01);
  assert.equal(first?.simulatedBuyNotional, 1);
  assert.equal(first?.simulatedSellNotional, 1.01);
});

test('retains ACTIVE and INVALID_SYNC history on final event', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison(), START);
  tracker.process(comparison(), START + 1);
  tracker.process(comparison(), START + 2);
  tracker.process(
    comparison({ status: 'STALE', syncStatus: 'STALE' }),
    START + 3,
  );
  const disappeared = tracker.process(netNonPositive(), START + 4);
  assert.equal(disappeared?.everActive, true);
  assert.equal(disappeared?.everInvalidSync, true);
});

test('does not emit another update while ACTIVE state is unchanged', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison(), START);
  tracker.process(comparison(), START + 1);
  tracker.process(comparison(), START + 2);
  assert.equal(tracker.process(comparison(), START + 3), null);
});
