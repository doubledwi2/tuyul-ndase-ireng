import assert from 'node:assert/strict';
import test from 'node:test';

import type { OpportunityEvent } from '../scanner/opportunity.js';
import { OpportunityMetrics } from './opportunity-metrics.js';

function completedEvent(
  overrides: Partial<OpportunityEvent> = {},
): OpportunityEvent {
  return {
    id: 'event',
    symbol: 'BTC/USDT',
    buyExchange: 'bybit',
    sellExchange: 'okx',
    state: 'DISAPPEARED',
    detectedAt: 100,
    updatedAt: 200,
    endedAt: 200,
    lifetimeMs: 100,
    initialGrossSpreadPercent: 0.01,
    currentGrossSpreadPercent: 0,
    peakGrossSpreadPercent: 0.02,
    initialGrossSpreadAbsolute: 1,
    currentGrossSpreadAbsolute: 0,
    peakGrossSpreadAbsolute: 2,
    initialEstimatedNetSpreadPercent: 0.008,
    currentEstimatedNetSpreadPercent: 0,
    peakEstimatedNetSpreadPercent: 0.012,
    initialEstimatedNetPnlAbsolute: 0.8,
    currentEstimatedNetPnlAbsolute: 0,
    peakEstimatedNetPnlAbsolute: 1.2,
    currentEstimatedTotalFee: 0.2,
    currentTradableSize: 0.3,
    peakTradableSize: 0.5,
    currentReceiveTimeDifferenceMs: 10,
    everActive: false,
    everInvalidSync: false,
    ...overrides,
  };
}

test('empty metrics are zero and null safe', () => {
  const summary = new OpportunityMetrics().getSummary();

  assert.equal(summary.totalCompletedEvents, 0);
  assert.equal(summary.eventsEverActive, 0);
  assert.equal(summary.eventsNeverActive, 0);
  assert.equal(summary.invalidSyncEvents, 0);
  assert.equal(summary.averageLifetimeMs, null);
  assert.equal(summary.p99LifetimeMs, null);
  assert.equal(summary.averagePeakSpreadPercent, null);
  assert.equal(summary.averagePeakNetSpreadPercent, null);
  assert.equal(summary.averagePeakNetPnlAbsolute, null);
});

test('counts completed events and ignores incomplete events', () => {
  const metrics = new OpportunityMetrics();
  metrics.recordCompleted(completedEvent());
  metrics.recordCompleted(completedEvent({ state: 'ACTIVE', lifetimeMs: null }));

  assert.equal(metrics.getSummary().totalCompletedEvents, 1);
});

test('counts ACTIVE history and events that never reached ACTIVE', () => {
  const metrics = new OpportunityMetrics();
  metrics.recordCompleted(completedEvent({ id: 'active', everActive: true }));
  metrics.recordCompleted(completedEvent({ id: 'never-active' }));

  const summary = metrics.getSummary();
  assert.equal(summary.eventsEverActive, 1);
  assert.equal(summary.eventsNeverActive, 1);
});

test('counts events that entered INVALID_SYNC', () => {
  const metrics = new OpportunityMetrics();
  metrics.recordCompleted(completedEvent({ everInvalidSync: true }));
  metrics.recordCompleted(completedEvent());

  assert.equal(metrics.getSummary().invalidSyncEvents, 1);
});

test('calculates average lifetime', () => {
  const metrics = new OpportunityMetrics();
  metrics.recordCompleted(completedEvent({ lifetimeMs: 100 }));
  metrics.recordCompleted(completedEvent({ lifetimeMs: 300 }));

  assert.equal(metrics.getSummary().averageLifetimeMs, 200);
});

test('calculates minimum and maximum lifetime', () => {
  const metrics = new OpportunityMetrics();
  metrics.recordCompleted(completedEvent({ lifetimeMs: 50 }));
  metrics.recordCompleted(completedEvent({ lifetimeMs: 500 }));
  metrics.recordCompleted(completedEvent({ lifetimeMs: 200 }));

  const summary = metrics.getSummary();
  assert.equal(summary.minLifetimeMs, 50);
  assert.equal(summary.maxLifetimeMs, 500);
});

test('calculates p50, p95, and p99 with nearest-rank', () => {
  const metrics = new OpportunityMetrics();
  for (let lifetime = 1; lifetime <= 100; lifetime += 1) {
    metrics.recordCompleted(completedEvent({ lifetimeMs: lifetime }));
  }

  const summary = metrics.getSummary();
  assert.equal(summary.p50LifetimeMs, 50);
  assert.equal(summary.p95LifetimeMs, 95);
  assert.equal(summary.p99LifetimeMs, 99);
});

test('aggregates peak spread percent and peak tradable size', () => {
  const metrics = new OpportunityMetrics();
  metrics.recordCompleted(
    completedEvent({ peakGrossSpreadPercent: 0.01, peakTradableSize: 0.2 }),
  );
  metrics.recordCompleted(
    completedEvent({ peakGrossSpreadPercent: 0.05, peakTradableSize: 0.8 }),
  );

  const summary = metrics.getSummary();
  assert.ok(
    summary.averagePeakSpreadPercent !== null &&
      Math.abs(summary.averagePeakSpreadPercent - 0.03) < 1e-12,
  );
  assert.equal(summary.maxPeakSpreadPercent, 0.05);
  assert.equal(summary.averagePeakTradableSize, 0.5);
  assert.equal(summary.maxPeakTradableSize, 0.8);
});

test('aggregates peak estimated net spread and PnL', () => {
  const metrics = new OpportunityMetrics();
  metrics.recordCompleted(
    completedEvent({
      peakEstimatedNetSpreadPercent: 0.01,
      peakEstimatedNetPnlAbsolute: 0.5,
    }),
  );
  metrics.recordCompleted(
    completedEvent({
      peakEstimatedNetSpreadPercent: 0.05,
      peakEstimatedNetPnlAbsolute: 2.5,
    }),
  );

  const summary = metrics.getSummary();
  assert.ok(
    summary.averagePeakNetSpreadPercent !== null &&
      Math.abs(summary.averagePeakNetSpreadPercent - 0.03) < 1e-12,
  );
  assert.equal(summary.maxPeakNetSpreadPercent, 0.05);
  assert.equal(summary.averagePeakNetPnlAbsolute, 1.5);
  assert.equal(summary.maxPeakNetPnlAbsolute, 2.5);
});
