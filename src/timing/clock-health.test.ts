import assert from 'node:assert/strict';
import test from 'node:test';

import { ClockHealthMonitor } from './clock-health.js';

test('initial clock health sample is WARMING_UP', () => {
  const result = new ClockHealthMonitor(50).sample(1_000, 10);
  assert.equal(result.status, 'WARMING_UP');
  assert.equal(result.clockDriftDeltaMs, null);
});

test('matching wall and monotonic deltas are HEALTHY', () => {
  const monitor = new ClockHealthMonitor(50);
  monitor.sample(1_000, 10);
  const result = monitor.sample(1_100, 110);
  assert.equal(result.status, 'HEALTHY');
  assert.equal(result.clockDriftDeltaMs, 0);
});

test('wall clock jump forward is detected deterministically', () => {
  const monitor = new ClockHealthMonitor(50);
  monitor.sample(1_000, 10);
  const result = monitor.sample(1_200, 110);
  assert.equal(result.status, 'CLOCK_JUMP_DETECTED');
  assert.equal(result.clockDriftDeltaMs, 100);
});

test('wall clock jump backward is detected deterministically', () => {
  const monitor = new ClockHealthMonitor(50);
  monitor.sample(1_000, 10);
  const result = monitor.sample(950, 110);
  assert.equal(result.status, 'CLOCK_JUMP_DETECTED');
  assert.equal(result.clockDriftDeltaMs, -150);
});

test('small wall versus monotonic drift is accepted', () => {
  const monitor = new ClockHealthMonitor(50);
  monitor.sample(1_000, 10);
  const result = monitor.sample(1_125, 110);
  assert.equal(result.status, 'HEALTHY');
  assert.equal(result.clockDriftDeltaMs, 25);
});
