import assert from 'node:assert/strict';
import test from 'node:test';

import type { TimingConfig } from '../config/timing.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import {
  DETERMINISTIC_HEALTHY_CLOCK,
  type ClockHealth,
} from './clock-health.js';
import { assessSynchronization } from './sync-model.js';

const NOW = 10_000;
const CONFIG: TimingConfig = {
  maxReceiveSkewMs: 100,
  maxBookAgeMs: 500,
  maxSourceTimestampSkewMs: 250,
  clockJumpThresholdMs: 50,
};

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

test('one null source timestamp skips source skew honestly', () => {
  const result = assessSynchronization(
    book('bybit', NOW, NOW - 10),
    book('okx', NOW, null),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
  );
  assert.equal(result.sourceTimestampSkewMs, null);
  assert.equal(result.status, 'SYNC_HEALTHY');
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

test('negative observed ingress is preserved and flagged as anomaly', () => {
  const result = assessSynchronization(
    book('bybit', NOW, NOW + 5),
    book('okx', NOW, NOW - 5),
    NOW,
    DETERMINISTIC_HEALTHY_CLOCK,
    CONFIG,
  );
  assert.equal(result.bybitObservedIngressMs, -5);
  assert.equal(result.status, 'TIMESTAMP_ANOMALY');
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
  );
  assert.deepEqual(result.reasons, [
    'TIMESTAMP_ANOMALY',
    'CLOCK_UNHEALTHY',
    'RECEIVE_SKEW_HIGH',
    'SOURCE_SKEW_HIGH',
    'BOOK_TOO_OLD',
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
