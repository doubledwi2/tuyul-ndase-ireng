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
    notional: side === 'BUY' ? 100 : 100.2,
    averageExecutionPrice: side === 'BUY' ? 10_000 : 10_020,
    bestPrice: side === 'BUY' ? 10_000 : 10_020,
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
    buyReceivedTimestamp: START - 10,
    sellReceivedTimestamp: START - 5,
    receiveTimeDifferenceMs: 5,
    syncStatus: 'SYNC_OK',
    status: 'EXECUTABLE_NET_POSITIVE',
    ...overrides,
  };
}

function nonPositive(): DepthComparison {
  return comparison({
    estimatedNetPnlAbsolute: -0.01,
    estimatedNetSpreadPercent: -0.01,
    status: 'EXECUTABLE_NET_ZERO_OR_NEGATIVE',
  });
}

test('quality-valid first observation starts DETECTED', () => {
  const event = new OpportunityTracker().process(comparison(), START);
  assert.equal(event?.state, 'DETECTED');
  assert.equal(event?.everQualified, false);
});

test('candidate stays VALIDATING until elapsed duration is reached', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison(), START);
  const validating = tracker.process(comparison(), START + 40);
  assert.equal(validating?.state, 'VALIDATING');
  assert.equal(tracker.process(comparison(), START + 90), null);
});

test('elapsed duration promotes candidate to QUALIFIED with correct history', () => {
  const tracker = new OpportunityTracker();
  const detected = tracker.process(comparison(), START);
  tracker.process(comparison(), START + 40);
  const qualified = tracker.process(comparison(), START + 110);
  assert.equal(qualified?.state, 'QUALIFIED');
  assert.equal(qualified?.id, detected?.id);
  assert.equal(qualified?.qualifiedAt, START + 110);
  assert.equal(qualified?.timeToQualifiedMs, 110);
  assert.equal(qualified?.everQualified, true);
  assert.equal(qualified?.everActive, true);
});

test('quality failure after qualification ends event and retains qualified flag', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison(), START);
  tracker.process(comparison(), START + 110);
  const disappeared = tracker.process(nonPositive(), START + 150);
  assert.equal(disappeared?.state, 'DISAPPEARED');
  assert.equal(disappeared?.everQualified, true);
  assert.equal(disappeared?.timeToQualifiedMs, 110);
  assert.deepEqual(disappeared?.currentQualificationReasons, [
    'NOT_NET_POSITIVE',
  ]);
});

test('stale creates no event but moves an existing event to INVALID_SYNC', () => {
  const stale = comparison({ status: 'STALE', syncStatus: 'STALE' });
  assert.equal(new OpportunityTracker().process(stale, START), null);
  const tracker = new OpportunityTracker();
  tracker.process(comparison(), START);
  const invalid = tracker.process(stale, START + 20);
  assert.equal(invalid?.state, 'INVALID_SYNC');
  assert.equal(invalid?.everInvalidSync, true);
  assert.deepEqual(invalid?.currentQualificationReasons, ['STALE']);
});

test('recovery after INVALID_SYNC resets an unqualified duration window', () => {
  const tracker = new OpportunityTracker();
  const first = tracker.process(comparison(), START);
  tracker.process(
    comparison({ status: 'STALE', syncStatus: 'STALE' }),
    START + 20,
  );
  const recovered = tracker.process(comparison(), START + 30);
  const stillValidating = tracker.process(comparison(), START + 120);
  const qualified = tracker.process(comparison(), START + 130);
  assert.equal(recovered?.state, 'DETECTED');
  assert.equal(recovered?.id, first?.id);
  assert.equal(stillValidating?.state, 'VALIDATING');
  assert.equal(qualified?.state, 'QUALIFIED');
  assert.equal(qualified?.timeToQualifiedMs, 100);
});

test('insufficient depth ends an open candidate', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison(), START);
  const partialBuy = {
    ...execution('BUY'),
    filledSize: 0.005,
    unfilledSize: 0.005,
    fullyFilled: false,
  };
  const event = tracker.process(
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
    START + 50,
  );
  assert.equal(event?.state, 'DISAPPEARED');
  assert.deepEqual(event?.currentQualificationReasons, ['INSUFFICIENT_DEPTH']);
});

test('directions remain independent and execution fields are retained', () => {
  const tracker = new OpportunityTracker();
  const forward = tracker.process(comparison(), START);
  const reverse = tracker.process(
    comparison({ buyExchange: 'okx', sellExchange: 'bybit' }),
    START,
  );
  assert.notEqual(forward?.id, reverse?.id);
  assert.equal(forward?.simulatedBuyNotional, 100);
  assert.equal(forward?.simulatedSellNotional, 100.2);
});

test('does not emit duplicate snapshots while QUALIFIED remains unchanged', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison(), START);
  tracker.process(comparison(), START + 110);
  assert.equal(tracker.process(comparison(), START + 120), null);
});
