import assert from 'node:assert/strict';
import test from 'node:test';

import type { OpportunityEvent } from '../scanner/opportunity.js';
import type { DepthComparison } from '../scanner/depth-comparator.js';
import type { ExecutionSimulation } from '../scanner/execution-simulator.js';
import type { OpportunityQualification } from '../scanner/opportunity-filter.js';
import type { SyncAssessment } from '../timing/sync-model.js';
import { DETERMINISTIC_HEALTHY_CLOCK } from '../timing/clock-health.js';
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
    qualifiedAt: null,
    timeToQualifiedMs: null,
    everQualified: false,
    currentQualificationReasons: [],
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
    targetBaseSize: 0.01,
    buyAverageExecutionPrice: 100.1,
    sellAverageExecutionPrice: 100.2,
    buySlippagePercent: 0.01,
    sellSlippagePercent: -0.01,
    simulatedBuyNotional: 1.001,
    simulatedSellNotional: 1.002,
    currentTradableSize: 0.3,
    peakTradableSize: 0.5,
    currentReceiveTimeDifferenceMs: 10,
    currentReceiveSkewMs: 10,
    currentSourceTimestampSkewMs: 5,
    currentMaxBookAgeMs: 20,
    currentSyncStatus: 'SYNC_HEALTHY',
    currentSyncReasons: [],
    peakReceiveSkewMs: 15,
    everActive: false,
    everInvalidSync: false,
    ...overrides,
  };
}

function execution(side: 'BUY' | 'SELL'): ExecutionSimulation {
  return {
    side,
    requestedSize: 0.01,
    filledSize: 0.01,
    unfilledSize: 0,
    fullyFilled: true,
    notional: 1,
    averageExecutionPrice: 100,
    bestPrice: 100,
    slippageAbsolute: 0,
    slippagePercent: 0,
  };
}

function depthComparison(
  status: DepthComparison['status'] = 'EXECUTABLE_NET_POSITIVE',
): DepthComparison {
  return {
    symbol: 'BTC/USDT',
    buyExchange: 'bybit',
    sellExchange: 'okx',
    targetBaseSize: 0.01,
    buyExecution: execution('BUY'),
    sellExecution: execution('SELL'),
    buyFeeRate: 0,
    sellFeeRate: 0,
    simulatedBuyNotional: 1,
    simulatedSellNotional: 1.01,
    estimatedBuyFee: 0,
    estimatedSellFee: 0,
    estimatedTotalFee: 0,
    grossPnlAbsolute: 0.01,
    estimatedNetPnlAbsolute: 0.01,
    estimatedNetSpreadPercent: 1,
    bestGrossSpreadAbsolute: 1,
    bestGrossSpreadPercent: 1,
    tradableSize: 0.01,
    buyReceivedTimestamp: 1,
    sellReceivedTimestamp: 2,
    receiveTimeDifferenceMs: 1,
    syncStatus: status === 'STALE' ? 'STALE' : 'SYNC_OK',
    status,
  };
}

function qualification(
  qualified: boolean,
  reasons: OpportunityQualification['reasons'] = [],
): OpportunityQualification {
  return {
    qualified,
    reasons,
    netSpreadOk: qualified,
    netPnlOk: qualified,
    syncOk: qualified,
    depthOk: qualified,
    requiredActiveDurationMs: 100,
  };
}

function syncAssessment(
  receiveSkewMs: number,
  overrides: Partial<SyncAssessment> = {},
): SyncAssessment {
  return {
    status: 'SYNC_HEALTHY',
    receiveSkewMs,
    sourceTimestampSkewMs: receiveSkewMs + 1,
    matchingEngineSkewMs: null,
    bybitBookAgeMs: 1,
    okxBookAgeMs: 2,
    maxBookAgeMs: 2,
    bybitObservedIngressMs: 10,
    okxObservedIngressMs: 20,
    bybitObservedMatchingEngineIngressMs: 11,
    okxObservedMatchingEngineIngressMs: null,
    bybitSourceClock: {
      rawObservedIngressMs: 10,
      baselineObservedIngressMs: 8,
      observedIngressDeviationMs: 2,
      offsetSampleCount: 30,
      offsetStatus: 'STABLE',
    },
    okxSourceClock: {
      rawObservedIngressMs: 20,
      baselineObservedIngressMs: 18,
      observedIngressDeviationMs: 2,
      offsetSampleCount: 30,
      offsetStatus: 'STABLE',
    },
    clockHealth: DETERMINISTIC_HEALTHY_CLOCK,
    reasons: [],
    ...overrides,
  };
}

test('empty metrics are zero and null safe', () => {
  const summary = new OpportunityMetrics().getSummary();

  assert.equal(summary.totalCompletedEvents, 0);
  assert.equal(summary.comparisonsTotal, 0);
  assert.equal(summary.insufficientDepthCount, 0);
  assert.equal(summary.averageBuySlippagePercent, null);
  assert.equal(summary.eventsEverActive, 0);
  assert.equal(summary.eventsNeverActive, 0);
  assert.equal(summary.invalidSyncEvents, 0);
  assert.equal(summary.averageLifetimeMs, null);
  assert.equal(summary.p99LifetimeMs, null);
  assert.equal(summary.averagePeakSpreadPercent, null);
  assert.equal(summary.averagePeakNetSpreadPercent, null);
  assert.equal(summary.averagePeakNetPnlAbsolute, null);
  assert.equal(summary.p95ReceiveSkewMs, null);
  assert.equal(summary.syncHealthyCount, 0);
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

test('counts qualified comparisons and rejection reasons independently', () => {
  const metrics = new OpportunityMetrics();
  metrics.recordComparison(depthComparison(), qualification(true));
  metrics.recordComparison(
    depthComparison(),
    qualification(false, ['NET_SPREAD_TOO_SMALL', 'NET_PNL_TOO_SMALL']),
  );
  metrics.recordComparison(
    depthComparison(),
    qualification(false, ['SYNC_TOO_WIDE']),
  );
  metrics.recordComparison(
    depthComparison('INSUFFICIENT_DEPTH'),
    qualification(false, ['INSUFFICIENT_DEPTH']),
  );
  metrics.recordComparison(
    depthComparison('STALE'),
    qualification(false, ['STALE']),
  );
  metrics.recordComparison(
    depthComparison('EXECUTABLE_NET_ZERO_OR_NEGATIVE'),
    qualification(false, ['NOT_NET_POSITIVE']),
  );

  const summary = metrics.getSummary();
  assert.equal(summary.totalNetPositiveComparisons, 3);
  assert.equal(summary.qualifiedComparisons, 1);
  assert.equal(summary.qualificationRejectedCount, 5);
  assert.equal(summary.rejectedSmallNetSpread, 1);
  assert.equal(summary.rejectedSmallNetPnl, 1);
  assert.equal(summary.rejectedWideSync, 1);
  assert.equal(summary.rejectedInsufficientDepth, 1);
  assert.equal(summary.rejectedStale, 1);
  assert.equal(summary.rejectedNotNetPositive, 1);
});

test('aggregates qualified event count and qualification times', () => {
  const metrics = new OpportunityMetrics();
  metrics.recordCompleted(
    completedEvent({ everQualified: true, timeToQualifiedMs: 100 }),
  );
  metrics.recordCompleted(
    completedEvent({ everQualified: true, timeToQualifiedMs: 200 }),
  );
  metrics.recordCompleted(completedEvent());

  const summary = metrics.getSummary();
  assert.equal(summary.eventsEverQualified, 2);
  assert.equal(summary.eventsNeverQualified, 1);
  assert.equal(summary.averageTimeToQualifiedMs, 150);
  assert.equal(summary.p50TimeToQualifiedMs, 100);
  assert.equal(summary.p95TimeToQualifiedMs, 200);
});

test('aggregates timing distributions and sync reason counts', () => {
  const metrics = new OpportunityMetrics();
  metrics.recordTiming(syncAssessment(10), 0.1, 'bybit');
  metrics.recordTiming(syncAssessment(20), 0.2, 'okx');
  metrics.recordTiming(
    syncAssessment(30, {
      status: 'SYNC_WARMING_UP',
      reasons: ['SYNC_WARMING_UP'],
      bybitSourceClock: {
        rawObservedIngressMs: 10,
        baselineObservedIngressMs: 9,
        observedIngressDeviationMs: 1,
        offsetSampleCount: 2,
        offsetStatus: 'WARMING_UP',
      },
    }),
    0.3,
    'bybit',
  );
  metrics.recordTiming(
    syncAssessment(120, {
      status: 'RECEIVE_SKEW_HIGH',
      maxBookAgeMs: 600,
      reasons: [
        'RECEIVE_SKEW_HIGH',
        'BOOK_TOO_OLD',
        'SOURCE_OFFSET_DEVIATION_HIGH',
      ],
      okxSourceClock: {
        rawObservedIngressMs: 120,
        baselineObservedIngressMs: -120,
        observedIngressDeviationMs: 240,
        offsetSampleCount: 40,
        offsetStatus: 'DEVIATION_HIGH',
      },
    }),
    0.4,
    'okx',
  );

  const summary = metrics.getSummary();
  assert.equal(summary.timingAssessmentsTotal, 4);
  assert.equal(summary.syncHealthyCount, 2);
  assert.equal(summary.receiveSkewHighCount, 1);
  assert.equal(summary.bookTooOldCount, 1);
  assert.equal(summary.p50ReceiveSkewMs, 20);
  assert.equal(summary.p95ReceiveSkewMs, 120);
  assert.equal(summary.p99ReceiveSkewMs, 120);
  assert.equal(summary.maxReceiveSkewMs, 120);
  assert.equal(summary.bybitAverageObservedIngressMs, 10);
  assert.equal(summary.okxAverageObservedIngressMs, 20);
  assert.equal(summary.bybitObservedIngressBaselineMs, 9);
  assert.equal(summary.bybitP95AbsoluteOffsetDeviationMs, 2);
  assert.equal(summary.okxObservedIngressBaselineMs, -120);
  assert.equal(summary.okxMaxAbsoluteOffsetDeviationMs, 240);
  assert.equal(summary.sourceClockWarmingUpCount, 1);
  assert.equal(summary.sourceOffsetDeviationHighCount, 1);
  assert.equal(summary.p95ProcessingDurationMs, 0.4);
  assert.equal(summary.maxProcessingDurationMs, 0.4);
});
