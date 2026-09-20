import assert from 'node:assert/strict';
import test from 'node:test';

import type { TimingConfig } from '../config/timing.js';
import { SourceClockOffsetEstimator } from './source-clock-offset.js';

const CONFIG: TimingConfig = {
  maxReceiveSkewMs: 100,
  maxBookAgeMs: 500,
  maxSourceTimestampSkewMs: 250,
  clockJumpThresholdMs: 50,
  minOffsetSamples: 3,
  offsetWindowSize: 5,
  maxOffsetDeviationMs: 100,
};

function observeIngress(
  estimator: SourceClockOffsetEstimator,
  observedIngressMs: number,
) {
  return estimator.observe(1_000 - observedIngressMs, 1_000);
}

test('offset estimator remains WARMING_UP before minimum samples', () => {
  const estimator = new SourceClockOffsetEstimator(CONFIG);
  assert.equal(observeIngress(estimator, -120).offsetStatus, 'WARMING_UP');
  const second = observeIngress(estimator, -118);
  assert.equal(second.offsetStatus, 'WARMING_UP');
  assert.equal(second.offsetSampleCount, 2);
});

test('offset estimator uses the median as its robust baseline', () => {
  const estimator = new SourceClockOffsetEstimator(CONFIG);
  observeIngress(estimator, -120);
  observeIngress(estimator, 500);
  const result = observeIngress(estimator, -118);
  assert.equal(result.baselineObservedIngressMs, -118);
  assert.equal(result.observedIngressDeviationMs, 0);
});

test('stable negative baseline is accepted after warm-up', () => {
  const estimator = new SourceClockOffsetEstimator(CONFIG);
  observeIngress(estimator, -120);
  observeIngress(estimator, -126);
  const result = observeIngress(estimator, -118);
  assert.equal(result.offsetStatus, 'STABLE');
  assert.equal(result.baselineObservedIngressMs, -120);
  assert.equal(result.observedIngressDeviationMs, 2);
});

test('stable positive baseline is accepted after warm-up', () => {
  const estimator = new SourceClockOffsetEstimator(CONFIG);
  observeIngress(estimator, 20);
  observeIngress(estimator, 25);
  const result = observeIngress(estimator, 22);
  assert.equal(result.offsetStatus, 'STABLE');
  assert.equal(result.baselineObservedIngressMs, 22);
});

test('large deviation is detected without clamping raw ingress', () => {
  const estimator = new SourceClockOffsetEstimator(CONFIG);
  observeIngress(estimator, -120);
  observeIngress(estimator, -121);
  observeIngress(estimator, -119);
  const result = observeIngress(estimator, 500);
  assert.equal(result.rawObservedIngressMs, 500);
  assert.equal(result.baselineObservedIngressMs, -119.5);
  assert.equal(result.observedIngressDeviationMs, 619.5);
  assert.equal(result.offsetStatus, 'DEVIATION_HIGH');
});

test('rolling window drops old samples deterministically', () => {
  const estimator = new SourceClockOffsetEstimator({
    ...CONFIG,
    minOffsetSamples: 1,
    offsetWindowSize: 3,
  });
  observeIngress(estimator, 0);
  observeIngress(estimator, 0);
  observeIngress(estimator, 100);
  const result = observeIngress(estimator, 100);
  assert.equal(result.baselineObservedIngressMs, 100);
  assert.equal(result.offsetSampleCount, 4);
});

test('null source timestamp is unavailable and does not invent a sample', () => {
  const estimator = new SourceClockOffsetEstimator(CONFIG);
  const result = estimator.observe(null, 1_000);
  assert.deepEqual(result, {
    rawObservedIngressMs: null,
    baselineObservedIngressMs: null,
    observedIngressDeviationMs: null,
    offsetSampleCount: 0,
    offsetStatus: 'UNAVAILABLE',
  });
});

test('identical sample sequences produce identical diagnostics', () => {
  const values = [-120, -118, -125, 400, -121, -119];
  const first = new SourceClockOffsetEstimator(CONFIG);
  const second = new SourceClockOffsetEstimator(CONFIG);
  const firstResults = values.map((value) => observeIngress(first, value));
  const secondResults = values.map((value) => observeIngress(second, value));
  assert.deepEqual(firstResults, secondResults);
});
