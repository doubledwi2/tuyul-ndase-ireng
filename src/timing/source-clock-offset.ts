import {
  TIMING_CONFIG,
  validateTimingConfig,
  type TimingConfig,
} from '../config/timing.js';

export type SourceClockOffsetStatus =
  | 'WARMING_UP'
  | 'STABLE'
  | 'DEVIATION_HIGH'
  | 'UNAVAILABLE';

export interface SourceClockOffsetDiagnostic {
  rawObservedIngressMs: number | null;
  baselineObservedIngressMs: number | null;
  observedIngressDeviationMs: number | null;
  offsetSampleCount: number;
  offsetStatus: SourceClockOffsetStatus;
}

export const UNAVAILABLE_SOURCE_CLOCK_OFFSET: Readonly<SourceClockOffsetDiagnostic> =
  {
    rawObservedIngressMs: null,
    baselineObservedIngressMs: null,
    observedIngressDeviationMs: null,
    offsetSampleCount: 0,
    offsetStatus: 'UNAVAILABLE',
  };

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const right = sorted[middle];
  if (right === undefined) {
    return null;
  }
  if (sorted.length % 2 === 1) {
    return right;
  }
  const left = sorted[middle - 1];
  return left === undefined ? null : (left + right) / 2;
}

export class SourceClockOffsetEstimator {
  private readonly recentObservedIngress: number[] = [];
  private sampleCount = 0;

  constructor(private readonly config: TimingConfig = TIMING_CONFIG) {
    validateTimingConfig(config);
  }

  observe(
    exchangeTimestamp: number | null,
    receivedTimestamp: number,
  ): SourceClockOffsetDiagnostic {
    if (
      exchangeTimestamp === null ||
      !Number.isFinite(exchangeTimestamp) ||
      !Number.isFinite(receivedTimestamp)
    ) {
      return {
        rawObservedIngressMs: null,
        baselineObservedIngressMs: median(this.recentObservedIngress),
        observedIngressDeviationMs: null,
        offsetSampleCount: this.sampleCount,
        offsetStatus: 'UNAVAILABLE',
      };
    }

    const rawObservedIngressMs = receivedTimestamp - exchangeTimestamp;
    if (!Number.isFinite(rawObservedIngressMs)) {
      return {
        rawObservedIngressMs: null,
        baselineObservedIngressMs: median(this.recentObservedIngress),
        observedIngressDeviationMs: null,
        offsetSampleCount: this.sampleCount,
        offsetStatus: 'UNAVAILABLE',
      };
    }

    this.recentObservedIngress.push(rawObservedIngressMs);
    if (this.recentObservedIngress.length > this.config.offsetWindowSize) {
      this.recentObservedIngress.shift();
    }
    this.sampleCount += 1;

    const baselineObservedIngressMs = median(this.recentObservedIngress);
    const observedIngressDeviationMs =
      baselineObservedIngressMs === null
        ? null
        : rawObservedIngressMs - baselineObservedIngressMs;
    const offsetStatus: SourceClockOffsetStatus =
      this.sampleCount < this.config.minOffsetSamples
        ? 'WARMING_UP'
        : observedIngressDeviationMs !== null &&
            Math.abs(observedIngressDeviationMs) >
              this.config.maxOffsetDeviationMs
          ? 'DEVIATION_HIGH'
          : 'STABLE';

    return {
      rawObservedIngressMs,
      baselineObservedIngressMs,
      observedIngressDeviationMs,
      offsetSampleCount: this.sampleCount,
      offsetStatus,
    };
  }
}
