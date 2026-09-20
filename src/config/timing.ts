export interface TimingConfig {
  maxReceiveSkewMs: number;
  maxBookAgeMs: number;
  maxSourceTimestampSkewMs: number;
  clockJumpThresholdMs: number;
  minOffsetSamples: number;
  offsetWindowSize: number;
  maxOffsetDeviationMs: number;
}

// Engineering baselines only. They are not optimal trading thresholds.
export const MAX_RECEIVE_SKEW_MS = 100;
export const MAX_BOOK_AGE_MS = 500;
export const MAX_SOURCE_TIMESTAMP_SKEW_MS = 250;
export const CLOCK_JUMP_THRESHOLD_MS = 50;
export const MIN_OFFSET_SAMPLES = 30;
export const OFFSET_WINDOW_SIZE = 200;
export const MAX_OFFSET_DEVIATION_MS = 100;

export const TIMING_CONFIG: Readonly<TimingConfig> = {
  maxReceiveSkewMs: MAX_RECEIVE_SKEW_MS,
  maxBookAgeMs: MAX_BOOK_AGE_MS,
  maxSourceTimestampSkewMs: MAX_SOURCE_TIMESTAMP_SKEW_MS,
  clockJumpThresholdMs: CLOCK_JUMP_THRESHOLD_MS,
  minOffsetSamples: MIN_OFFSET_SAMPLES,
  offsetWindowSize: OFFSET_WINDOW_SIZE,
  maxOffsetDeviationMs: MAX_OFFSET_DEVIATION_MS,
};

export function validateTimingConfig(config: TimingConfig): void {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be finite and non-negative.`);
    }
  }
  if (
    !Number.isSafeInteger(config.minOffsetSamples) ||
    config.minOffsetSamples < 1
  ) {
    throw new RangeError('minOffsetSamples must be a positive safe integer.');
  }
  if (
    !Number.isSafeInteger(config.offsetWindowSize) ||
    config.offsetWindowSize < 1
  ) {
    throw new RangeError('offsetWindowSize must be a positive safe integer.');
  }
  if (config.minOffsetSamples > config.offsetWindowSize) {
    throw new RangeError('minOffsetSamples cannot exceed offsetWindowSize.');
  }
}
