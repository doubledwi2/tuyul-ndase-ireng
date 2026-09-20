import assert from 'node:assert/strict';
import test from 'node:test';

import type { FeeAwareComparison } from './fee-model.js';
import { OpportunityTracker } from './opportunity.js';

const START = 1_700_000_000_000;

function comparison(
  overrides: Partial<FeeAwareComparison> = {},
): FeeAwareComparison {
  return {
    symbol: 'BTC/USDT',
    buyExchange: 'bybit',
    sellExchange: 'okx',
    buyPrice: 100,
    sellPrice: 101,
    grossSpreadAbsolute: 1,
    grossSpreadPercent: 1,
    tradableSize: 0.4,
    buyReceivedTimestamp: START - 10,
    sellReceivedTimestamp: START - 5,
    receiveTimeDifferenceMs: 5,
    status: 'SYNC_OK',
    buyFeeRate: 0.001,
    sellFeeRate: 0.001,
    buyNotional: 40,
    sellNotional: 40.4,
    estimatedBuyFee: 0.04,
    estimatedSellFee: 0.0404,
    estimatedTotalFee: 0.0804,
    grossPnlAbsolute: 0.4,
    estimatedNetPnlAbsolute: 0.3196,
    estimatedNetSpreadPercent: 0.799,
    feeStatus: 'NET_POSITIVE',
    ...overrides,
  };
}

function netZeroOrNegative(
  overrides: Partial<FeeAwareComparison> = {},
): FeeAwareComparison {
  return comparison({
    estimatedNetPnlAbsolute: -0.01,
    estimatedNetSpreadPercent: -0.025,
    feeStatus: 'NET_ZERO_OR_NEGATIVE',
    ...overrides,
  });
}

test('gross positive but estimated net negative creates no event', () => {
  const tracker = new OpportunityTracker();

  assert.equal(tracker.process(netZeroOrNegative(), START), null);
});

test('promotes consecutive net-positive observations through lifecycle', () => {
  const tracker = new OpportunityTracker();
  const detected = tracker.process(comparison(), START);
  const validating = tracker.process(comparison(), START + 1);
  const active = tracker.process(comparison(), START + 2);

  assert.equal(detected?.state, 'DETECTED');
  assert.equal(validating?.state, 'VALIDATING');
  assert.equal(active?.state, 'ACTIVE');
  assert.equal(detected?.id, validating?.id);
  assert.equal(validating?.id, active?.id);
});

test('stale comparison does not create a valid net event', () => {
  const tracker = new OpportunityTracker();
  const event = tracker.process(
    comparison({ status: 'STALE', feeStatus: 'STALE' }),
    START,
  );

  assert.equal(event, null);
  assert.equal(tracker.getOpenEventCount(), 0);
});

test('a live event enters INVALID_SYNC and restarts valid observations', () => {
  const tracker = new OpportunityTracker();
  const detected = tracker.process(comparison(), START);
  const invalid = tracker.process(
    comparison({ status: 'STALE', feeStatus: 'STALE' }),
    START + 1,
  );
  const redetected = tracker.process(comparison(), START + 2);
  const validating = tracker.process(comparison(), START + 3);

  assert.equal(invalid?.state, 'INVALID_SYNC');
  assert.equal(redetected?.state, 'DETECTED');
  assert.equal(validating?.state, 'VALIDATING');
  assert.equal(detected?.id, invalid?.id);
  assert.equal(invalid?.id, redetected?.id);
});

test('marks an active event DISAPPEARED when estimated net is non-positive', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison(), START);
  tracker.process(comparison(), START + 1);
  tracker.process(comparison(), START + 2);
  const disappeared = tracker.process(netZeroOrNegative(), START + 50);

  assert.equal(disappeared?.state, 'DISAPPEARED');
  assert.equal(disappeared?.endedAt, START + 50);
  assert.equal(disappeared?.lifetimeMs, 50);
});

test('uses a new event ID when a net opportunity returns', () => {
  const tracker = new OpportunityTracker();
  const first = tracker.process(comparison(), START);
  tracker.process(netZeroOrNegative(), START + 1);
  const second = tracker.process(comparison(), START + 2);

  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.id, second.id);
});

test('tracks peak gross spread values without summing observations', () => {
  const tracker = new OpportunityTracker();
  tracker.process(
    comparison({ grossSpreadPercent: 1, grossSpreadAbsolute: 1 }),
    START,
  );
  tracker.process(
    comparison({ grossSpreadPercent: 1.5, grossSpreadAbsolute: 2.5 }),
    START + 1,
  );
  const event = tracker.process(
    comparison({ grossSpreadPercent: 1.2, grossSpreadAbsolute: 2 }),
    START + 2,
  );

  assert.equal(event?.peakGrossSpreadPercent, 1.5);
  assert.equal(event?.peakGrossSpreadAbsolute, 2.5);
});

test('tracks peak estimated net spread and PnL without summing', () => {
  const tracker = new OpportunityTracker();
  tracker.process(
    comparison({
      estimatedNetSpreadPercent: 0.4,
      estimatedNetPnlAbsolute: 0.2,
    }),
    START,
  );
  tracker.process(
    comparison({
      estimatedNetSpreadPercent: 0.9,
      estimatedNetPnlAbsolute: 0.7,
    }),
    START + 1,
  );
  const event = tracker.process(
    comparison({
      estimatedNetSpreadPercent: 0.6,
      estimatedNetPnlAbsolute: 0.5,
    }),
    START + 2,
  );

  assert.equal(event?.peakEstimatedNetSpreadPercent, 0.9);
  assert.equal(event?.peakEstimatedNetPnlAbsolute, 0.7);
});

test('tracks peak tradable size and both directions independently', () => {
  const tracker = new OpportunityTracker();
  const bybitToOkx = tracker.process(comparison({ tradableSize: 0.4 }), START);
  const okxToBybit = tracker.process(
    comparison({ buyExchange: 'okx', sellExchange: 'bybit' }),
    START,
  );
  const bybitValidating = tracker.process(
    comparison({ tradableSize: 0.9 }),
    START + 1,
  );

  assert.equal(bybitToOkx?.state, 'DETECTED');
  assert.equal(okxToBybit?.state, 'DETECTED');
  assert.notEqual(bybitToOkx?.id, okxToBybit?.id);
  assert.equal(bybitValidating?.state, 'VALIDATING');
  assert.equal(bybitValidating?.peakTradableSize, 0.9);
});

test('retains ACTIVE and INVALID_SYNC history on final event', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison(), START);
  tracker.process(comparison(), START + 1);
  tracker.process(comparison(), START + 2);
  tracker.process(
    comparison({ status: 'STALE', feeStatus: 'STALE' }),
    START + 3,
  );
  const disappeared = tracker.process(netZeroOrNegative(), START + 4);

  assert.equal(disappeared?.state, 'DISAPPEARED');
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
