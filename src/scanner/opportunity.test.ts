import assert from 'node:assert/strict';
import test from 'node:test';

import type { SpreadComparison } from './comparator.js';
import { OpportunityTracker } from './opportunity.js';

const START = 1_700_000_000_000;

function comparison(
  overrides: Partial<SpreadComparison> = {},
): SpreadComparison {
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
    ...overrides,
  };
}

test('does not create an event when gross spread is not positive', () => {
  const tracker = new OpportunityTracker();

  assert.equal(
    tracker.process(
      comparison({ grossSpreadAbsolute: 0, grossSpreadPercent: 0 }),
      START,
    ),
    null,
  );
});

test('promotes consecutive valid observations through the lifecycle', () => {
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

test('creates an INVALID_SYNC event for a positive stale comparison', () => {
  const tracker = new OpportunityTracker();
  const event = tracker.process(comparison({ status: 'STALE' }), START);

  assert.equal(event?.state, 'INVALID_SYNC');
});

test('restarts valid observation sequence after INVALID_SYNC', () => {
  const tracker = new OpportunityTracker();
  const invalid = tracker.process(comparison({ status: 'STALE' }), START);
  const detected = tracker.process(comparison(), START + 1);
  const validating = tracker.process(comparison(), START + 2);

  assert.equal(detected?.state, 'DETECTED');
  assert.equal(validating?.state, 'VALIDATING');
  assert.equal(invalid?.id, detected?.id);
});

test('marks a live event DISAPPEARED when its spread is no longer positive', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison(), START);
  const disappeared = tracker.process(
    comparison({ grossSpreadAbsolute: -0.1, grossSpreadPercent: -0.1 }),
    START + 50,
  );

  assert.equal(disappeared?.state, 'DISAPPEARED');
  assert.equal(disappeared?.endedAt, START + 50);
});

test('calculates lifetime when an event disappears', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison(), START);
  const disappeared = tracker.process(
    comparison({ grossSpreadAbsolute: 0, grossSpreadPercent: 0 }),
    START + 143,
  );

  assert.equal(disappeared?.lifetimeMs, 143);
});

test('uses a new event ID when an opportunity returns after disappearing', () => {
  const tracker = new OpportunityTracker();
  const first = tracker.process(comparison(), START);
  tracker.process(
    comparison({ grossSpreadAbsolute: 0, grossSpreadPercent: 0 }),
    START + 1,
  );
  const second = tracker.process(comparison(), START + 2);

  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.id, second.id);
});

test('tracks peak gross spread percent without summing observations', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison({ grossSpreadPercent: 1 }), START);
  tracker.process(comparison({ grossSpreadPercent: 1.5 }), START + 1);
  const event = tracker.process(comparison({ grossSpreadPercent: 1.2 }), START + 2);

  assert.equal(event?.peakGrossSpreadPercent, 1.5);
});

test('tracks peak absolute gross spread', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison({ grossSpreadAbsolute: 1 }), START);
  tracker.process(comparison({ grossSpreadAbsolute: 2.5 }), START + 1);
  const event = tracker.process(comparison({ grossSpreadAbsolute: 2 }), START + 2);

  assert.equal(event?.peakGrossSpreadAbsolute, 2.5);
});

test('tracks peak tradable size without summing observations', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison({ tradableSize: 0.4 }), START);
  tracker.process(comparison({ tradableSize: 0.9 }), START + 1);
  const event = tracker.process(comparison({ tradableSize: 0.5 }), START + 2);

  assert.equal(event?.peakTradableSize, 0.9);
});

test('tracks both exchange directions independently', () => {
  const tracker = new OpportunityTracker();
  const bybitToOkx = tracker.process(comparison(), START);
  const okxToBybit = tracker.process(
    comparison({ buyExchange: 'okx', sellExchange: 'bybit' }),
    START,
  );
  const bybitValidating = tracker.process(comparison(), START + 1);

  assert.equal(bybitToOkx?.state, 'DETECTED');
  assert.equal(okxToBybit?.state, 'DETECTED');
  assert.notEqual(bybitToOkx?.id, okxToBybit?.id);
  assert.equal(bybitValidating?.state, 'VALIDATING');
});

test('does not emit another update when ACTIVE state remains unchanged', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison(), START);
  tracker.process(comparison(), START + 1);
  tracker.process(comparison(), START + 2);

  assert.equal(tracker.process(comparison(), START + 3), null);
});

test('sets everActive after the event reaches ACTIVE', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison(), START);
  tracker.process(comparison(), START + 1);
  const active = tracker.process(comparison(), START + 2);

  assert.equal(active?.everActive, true);
});

test('sets everInvalidSync after the event reaches INVALID_SYNC', () => {
  const tracker = new OpportunityTracker();
  const invalid = tracker.process(comparison({ status: 'STALE' }), START);

  assert.equal(invalid?.everInvalidSync, true);
});

test('retains historical flags on the final DISAPPEARED event', () => {
  const tracker = new OpportunityTracker();
  tracker.process(comparison({ status: 'STALE' }), START);
  tracker.process(comparison(), START + 1);
  tracker.process(comparison(), START + 2);
  tracker.process(comparison(), START + 3);
  const disappeared = tracker.process(
    comparison({ grossSpreadAbsolute: 0, grossSpreadPercent: 0 }),
    START + 4,
  );

  assert.equal(disappeared?.state, 'DISAPPEARED');
  assert.equal(disappeared?.everActive, true);
  assert.equal(disappeared?.everInvalidSync, true);
});
