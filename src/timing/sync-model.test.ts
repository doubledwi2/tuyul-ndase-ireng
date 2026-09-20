import assert from 'node:assert/strict';
import test from 'node:test';

import type { TimingConfig } from '../config/timing.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import {
  DETERMINISTIC_HEALTHY_CLOCK,
  type ClockHealth,
} from './clock-health.js';
import type { SourceClockOffsetDiagnostic } from './source-clock-offset.js';
import {
  assessSynchronization,
  type SourceClockAssessments,
} from './sync-model.js';

const NOW = 10_000;
const CONFIG: TimingConfig = {
  maxReceiveSkewMs: 100,
  maxBookAgeMs: 500,
  maxSourceTimestampSkewMs: 250,
  clockJumpThresholdMs: 50,
  minOffsetSamples: 30,
  offsetWindowSize: 200,
  maxOffsetDeviationMs: 100,
};

function sourceClock(
  rawObservedIngressMs: number,
  offsetStatus: SourceClockOffsetDiagnostic['offsetStatus'] = 'STABLE',
): SourceClockOffsetDiagnostic {
  if (offsetStatus === 'UNAVAILABLE') {
    return {
      rawObservedIngressMs: null,
      baselineObservedIngressMs: null,
      observedIngressDeviationMs: null,
      offsetSampleCount: 0,
      offsetStatus,
    };
  }
  return {
    rawObservedIngressMs,
    baselineObservedIngressMs: -120,
    observedIngressDeviationMs: rawObservedIngressMs + 120,
    offsetSampleCount: 30,
    offsetStatus,
  };
}

function sourceClocks(
  bybitStatus: SourceClockOffsetDiagnostic['offsetStatus'] = 'STABLE',
  okxStatus: SourceClockOffsetDiagnostic['offsetStatus'] = 'STABLE',
): SourceClockAssessments {
  return {
    bybit: sourceClock(-120, bybitStatus),
    okx: sourceClock(-127, okxStatus),
  };
}

function book(
  exchange: 'bybit' | 'okx',
  receivedTimestamp: number,
  exchangeTimestamp: number | null = receivedTimestamp - 20,
  matchingEngineTimestamp: number | null = null,
): NormalizedOrderBook {
  return {
    exchange,
    symbol: 'BTC/USDT',
    bids: [{ price: 100, size: 1 }],
    asks: [{ price: 101, size: 1 }],
    exchangeTimestamp,
    matchingEngineTimestamp,
    receivedTimestamp,
    receivedMonotonicMs: 123.4,
  };
}

test('healthy market timing produces SYNC_HEALTHY', () => {
  const result = assessSynchronization(
    book('bybit', NOW - 20),
    book('okx', NOW - 40),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
    sourceClocks(),
  );
  assert.equal(result.status, 'SYNC_HEALTHY');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.receiveSkewMs, 20);
});

test('high receive skew is rejected', () => {
  const result = assessSynchronization(
    book('bybit', NOW),
    book('okx', NOW - 101),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
  );
  assert.equal(result.status, 'RECEIVE_SKEW_HIGH');
  assert.ok(result.reasons.includes('RECEIVE_SKEW_HIGH'));
});

test('high source timestamp skew is rejected', () => {
  const result = assessSynchronization(
    book('bybit', NOW, NOW - 10),
    book('okx', NOW, NOW - 300),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
  );
  assert.equal(result.status, 'SOURCE_SKEW_HIGH');
  assert.equal(result.sourceTimestampSkewMs, 290);
});

test('one null source timestamp is unavailable and skips source skew honestly', () => {
  const result = assessSynchronization(
    book('bybit', NOW, NOW - 10),
    book('okx', NOW, null),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
    sourceClocks('STABLE', 'UNAVAILABLE'),
  );
  assert.equal(result.sourceTimestampSkewMs, null);
  assert.equal(result.status, 'SOURCE_CLOCK_UNAVAILABLE');
  assert.deepEqual(result.reasons, ['SOURCE_CLOCK_UNAVAILABLE']);
});

test('Bybit unavailable source clock blocks healthy sync', () => {
  const result = assessSynchronization(
    book('bybit', NOW, null),
    book('okx', NOW, NOW - 10),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
    sourceClocks('UNAVAILABLE', 'STABLE'),
  );
  assert.equal(result.status, 'SOURCE_CLOCK_UNAVAILABLE');
  assert.deepEqual(result.reasons, ['SOURCE_CLOCK_UNAVAILABLE']);
});

test('OKX unavailable source clock blocks healthy sync', () => {
  const result = assessSynchronization(
    book('bybit', NOW, NOW - 10),
    book('okx', NOW, null),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
    sourceClocks('STABLE', 'UNAVAILABLE'),
  );
  assert.equal(result.status, 'SOURCE_CLOCK_UNAVAILABLE');
  assert.deepEqual(result.reasons, ['SOURCE_CLOCK_UNAVAILABLE']);
});

test('both unavailable source clocks produce one explicit reason', () => {
  const result = assessSynchronization(
    book('bybit', NOW, null),
    book('okx', NOW, null),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
    sourceClocks('UNAVAILABLE', 'UNAVAILABLE'),
  );
  assert.equal(result.status, 'SOURCE_CLOCK_UNAVAILABLE');
  assert.deepEqual(result.reasons, ['SOURCE_CLOCK_UNAVAILABLE']);
});

test('unavailable source clock preserves receive skew failure reason', () => {
  const result = assessSynchronization(
    book('bybit', NOW, null),
    book('okx', NOW - 101, NOW - 111),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
    sourceClocks('UNAVAILABLE', 'STABLE'),
  );
  assert.equal(result.status, 'RECEIVE_SKEW_HIGH');
  assert.deepEqual(result.reasons, [
    'RECEIVE_SKEW_HIGH',
    'SOURCE_CLOCK_UNAVAILABLE',
  ]);
});

test('old book produces BOOK_TOO_OLD', () => {
  const result = assessSynchronization(
    book('bybit', NOW - 501, NOW - 520),
    book('okx', NOW - 450, NOW - 470),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
  );
  assert.equal(result.status, 'BOOK_TOO_OLD');
});

test('negative book age produces TIMESTAMP_ANOMALY', () => {
  const result = assessSynchronization(
    book('bybit', NOW + 1, NOW - 10),
    book('okx', NOW, NOW - 10),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
  );
  assert.equal(result.status, 'TIMESTAMP_ANOMALY');
});

test('non-finite source timestamp is a fatal self-consistency anomaly', () => {
  const result = assessSynchronization(
    book('bybit', NOW, Number.NaN),
    book('okx', NOW, NOW - 10),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
  );
  assert.equal(result.status, 'TIMESTAMP_ANOMALY');
  assert.equal(result.bybitObservedIngressMs, null);
  assert.equal(result.sourceTimestampSkewMs, null);
});

test('impossible local monotonic timestamp is an anomaly', () => {
  const bybit = book('bybit', NOW, NOW - 10);
  bybit.receivedMonotonicMs = -1;
  const result = assessSynchronization(
    bybit,
    book('okx', NOW, NOW - 10),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
  );
  assert.equal(result.status, 'TIMESTAMP_ANOMALY');
});

test('raw negative ingress alone is preserved and is not an anomaly', () => {
  const result = assessSynchronization(
    book('bybit', NOW, NOW + 5),
    book('okx', NOW, NOW - 5),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
    sourceClocks(),
  );
  assert.equal(result.bybitObservedIngressMs, -5);
  assert.equal(result.status, 'SYNC_HEALTHY');
  assert.ok(!result.reasons.includes('TIMESTAMP_ANOMALY'));
});

test('-120 ms stable ingress can become healthy after offset warm-up', () => {
  const result = assessSynchronization(
    book('bybit', NOW, NOW + 120),
    book('okx', NOW, NOW + 127),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
    sourceClocks(),
  );
  assert.equal(result.bybitSourceClock.offsetStatus, 'STABLE');
  assert.equal(result.okxSourceClock.offsetStatus, 'STABLE');
  assert.equal(result.status, 'SYNC_HEALTHY');
});

test('source offset warm-up does not qualify as healthy', () => {
  const result = assessSynchronization(
    book('bybit', NOW, NOW + 120),
    book('okx', NOW, NOW + 127),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
    sourceClocks('WARMING_UP', 'STABLE'),
  );
  assert.equal(result.status, 'SYNC_WARMING_UP');
  assert.deepEqual(result.reasons, ['SYNC_WARMING_UP']);
});

test('source offset deviation blocks healthy sync', () => {
  const result = assessSynchronization(
    book('bybit', NOW, NOW - 5),
    book('okx', NOW, NOW - 5),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
    sourceClocks('DEVIATION_HIGH', 'STABLE'),
  );
  assert.equal(result.status, 'SOURCE_OFFSET_DEVIATION_HIGH');
  assert.ok(result.reasons.includes('SOURCE_OFFSET_DEVIATION_HIGH'));
});

test('unhealthy host clock overrides otherwise healthy timing', () => {
  const unhealthy: ClockHealth = {
    status: 'CLOCK_JUMP_DETECTED',
    wallTimestamp: NOW,
    monotonicTimestamp: 100,
    clockDriftDeltaMs: 75,
  };
  const result = assessSynchronization(
    book('bybit', NOW),
    book('okx', NOW),
    NOW,
    unhealthy,
    CONFIG,
  );
  assert.equal(result.status, 'CLOCK_UNHEALTHY');
});

test('multiple timing failure reasons are preserved', () => {
  const unhealthy: ClockHealth = {
    status: 'CLOCK_JUMP_DETECTED',
    wallTimestamp: NOW,
    monotonicTimestamp: 100,
    clockDriftDeltaMs: 75,
  };
  const result = assessSynchronization(
    book('bybit', NOW + 1, NOW + 10),
    book('okx', NOW - 600, NOW - 900),
    NOW,
    unhealthy,
    CONFIG,
    sourceClocks('DEVIATION_HIGH', 'WARMING_UP'),
  );
  assert.deepEqual(result.reasons, [
    'TIMESTAMP_ANOMALY',
    'CLOCK_UNHEALTHY',
    'RECEIVE_SKEW_HIGH',
    'SOURCE_SKEW_HIGH',
    'BOOK_TOO_OLD',
    'SOURCE_OFFSET_DEVIATION_HIGH',
    'SYNC_WARMING_UP',
  ]);
});

test('OKX null matching-engine timestamp keeps matching skew null', () => {
  const result = assessSynchronization(
    book('bybit', NOW, NOW - 10, NOW - 12),
    book('okx', NOW, NOW - 11, null),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
  );
  assert.equal(result.matchingEngineSkewMs, null);
  assert.equal(result.okxObservedMatchingEngineIngressMs, null);
});
