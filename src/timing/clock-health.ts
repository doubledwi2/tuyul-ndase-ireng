import { performance } from 'node:perf_hooks';

import { CLOCK_JUMP_THRESHOLD_MS } from '../config/timing.js';

export type ClockHealthStatus =
  | 'HEALTHY'
  | 'CLOCK_JUMP_DETECTED'
  | 'WARMING_UP';

export interface ClockHealth {
  status: ClockHealthStatus;
  wallTimestamp: number;
  monotonicTimestamp: number;
  clockDriftDeltaMs: number | null;
}

export const DETERMINISTIC_HEALTHY_CLOCK: Readonly<ClockHealth> = {
  status: 'HEALTHY',
  wallTimestamp: 0,
  monotonicTimestamp: 0,
  clockDriftDeltaMs: 0,
};

export class ClockHealthMonitor {
  private previousWallTimestamp: number | null = null;
  private previousMonotonicTimestamp: number | null = null;

  constructor(private readonly jumpThresholdMs = CLOCK_JUMP_THRESHOLD_MS) {
    if (!Number.isFinite(jumpThresholdMs) || jumpThresholdMs < 0) {
      throw new RangeError('Clock jump threshold must be finite and non-negative.');
    }
  }

  sample(
    wallTimestamp = Date.now(),
    monotonicTimestamp = performance.now(),
  ): ClockHealth {
    if (!Number.isFinite(wallTimestamp) || !Number.isFinite(monotonicTimestamp)) {
      throw new RangeError('Clock samples must be finite.');
    }

    const previousWall = this.previousWallTimestamp;
    const previousMonotonic = this.previousMonotonicTimestamp;
    this.previousWallTimestamp = wallTimestamp;
    this.previousMonotonicTimestamp = monotonicTimestamp;

    if (previousWall === null || previousMonotonic === null) {
      return {
        status: 'WARMING_UP',
        wallTimestamp,
        monotonicTimestamp,
        clockDriftDeltaMs: null,
      };
    }

    const wallDelta = wallTimestamp - previousWall;
    const monotonicDelta = monotonicTimestamp - previousMonotonic;
    const clockDriftDeltaMs = wallDelta - monotonicDelta;
    return {
      status:
        Math.abs(clockDriftDeltaMs) > this.jumpThresholdMs
          ? 'CLOCK_JUMP_DETECTED'
          : 'HEALTHY',
      wallTimestamp,
      monotonicTimestamp,
      clockDriftDeltaMs,
    };
  }
}
