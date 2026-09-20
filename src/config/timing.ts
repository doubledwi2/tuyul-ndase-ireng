export interface TimingConfig {
  maxReceiveSkewMs: number;
  maxBookAgeMs: number;
  maxSourceTimestampSkewMs: number;
  clockJumpThresholdMs: number;
}

// Engineering baselines only. They are not optimal trading thresholds.
export const MAX_RECEIVE_SKEW_MS = 100;
export const MAX_BOOK_AGE_MS = 500;
export const MAX_SOURCE_TIMESTAMP_SKEW_MS = 250;
export const CLOCK_JUMP_THRESHOLD_MS = 50;

export const TIMING_CONFIG: Readonly<TimingConfig> = {
  maxReceiveSkewMs: MAX_RECEIVE_SKEW_MS,
  maxBookAgeMs: MAX_BOOK_AGE_MS,
  maxSourceTimestampSkewMs: MAX_SOURCE_TIMESTAMP_SKEW_MS,
  clockJumpThresholdMs: CLOCK_JUMP_THRESHOLD_MS,
};

export function validateTimingConfig(config: TimingConfig): void {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be finite and non-negative.`);
    }
  }
}
