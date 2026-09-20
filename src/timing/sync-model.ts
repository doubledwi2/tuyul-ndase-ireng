import {
  TIMING_CONFIG,
  validateTimingConfig,
  type TimingConfig,
} from '../config/timing.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import type { ClockHealth } from './clock-health.js';
import {
  UNAVAILABLE_SOURCE_CLOCK_OFFSET,
  type SourceClockOffsetDiagnostic,
} from './source-clock-offset.js';

export type SyncStatus =
  | 'SYNC_HEALTHY'
  | 'RECEIVE_SKEW_HIGH'
  | 'SOURCE_SKEW_HIGH'
  | 'BOOK_TOO_OLD'
  | 'CLOCK_UNHEALTHY'
  | 'TIMESTAMP_ANOMALY'
  | 'SYNC_WARMING_UP'
  | 'SOURCE_OFFSET_DEVIATION_HIGH';

export type SyncReason = Exclude<SyncStatus, 'SYNC_HEALTHY'>;

export interface BookTimingDiagnostic {
  exchangeTimestamp: number | null;
  matchingEngineTimestamp: number | null;
  receivedTimestamp: number;
  receivedMonotonicMs: number | null;
  observedExchangeToReceiveMs: number | null;
  observedMatchingEngineToReceiveMs: number | null;
  bookAgeMs: number;
}

export interface SyncAssessment {
  status: SyncStatus;
  receiveSkewMs: number;
  sourceTimestampSkewMs: number | null;
  matchingEngineSkewMs: number | null;
  bybitBookAgeMs: number;
  okxBookAgeMs: number;
  maxBookAgeMs: number;
  bybitObservedIngressMs: number | null;
  okxObservedIngressMs: number | null;
  bybitObservedMatchingEngineIngressMs: number | null;
  okxObservedMatchingEngineIngressMs: number | null;
  bybitSourceClock: SourceClockOffsetDiagnostic;
  okxSourceClock: SourceClockOffsetDiagnostic;
  clockHealth: ClockHealth;
  reasons: SyncReason[];
}

export interface SourceClockAssessments {
  bybit: SourceClockOffsetDiagnostic;
  okx: SourceClockOffsetDiagnostic;
}

function optionalDifference(left: number | null, right: number): number | null {
  return left === null || !Number.isFinite(left) || !Number.isFinite(right)
    ? null
    : right - left;
}

export function diagnoseBookTiming(
  book: NormalizedOrderBook,
  comparisonTimestamp: number,
): BookTimingDiagnostic {
  return {
    exchangeTimestamp: book.exchangeTimestamp,
    matchingEngineTimestamp: book.matchingEngineTimestamp,
    receivedTimestamp: book.receivedTimestamp,
    receivedMonotonicMs: book.receivedMonotonicMs ?? null,
    observedExchangeToReceiveMs: optionalDifference(
      book.exchangeTimestamp,
      book.receivedTimestamp,
    ),
    observedMatchingEngineToReceiveMs: optionalDifference(
      book.matchingEngineTimestamp,
      book.receivedTimestamp,
    ),
    bookAgeMs: comparisonTimestamp - book.receivedTimestamp,
  };
}

function hasSelfConsistencyAnomaly(
  book: NormalizedOrderBook,
  diagnostic: BookTimingDiagnostic,
): boolean {
  return (
    !Number.isFinite(diagnostic.bookAgeMs) ||
    diagnostic.bookAgeMs < 0 ||
    !Number.isFinite(book.receivedTimestamp) ||
    (book.exchangeTimestamp !== null &&
      !Number.isFinite(book.exchangeTimestamp)) ||
    (book.matchingEngineTimestamp !== null &&
      !Number.isFinite(book.matchingEngineTimestamp)) ||
    (book.receivedMonotonicMs !== undefined &&
      book.receivedMonotonicMs !== null &&
      (!Number.isFinite(book.receivedMonotonicMs) ||
        book.receivedMonotonicMs < 0))
  );
}

export function assessSynchronization(
  bybitBook: NormalizedOrderBook,
  okxBook: NormalizedOrderBook,
  comparisonTimestamp: number,
  clockHealth: ClockHealth,
  config: TimingConfig = TIMING_CONFIG,
  sourceClocks: SourceClockAssessments = {
    bybit: UNAVAILABLE_SOURCE_CLOCK_OFFSET,
    okx: UNAVAILABLE_SOURCE_CLOCK_OFFSET,
  },
): SyncAssessment {
  validateTimingConfig(config);
  const bybit = diagnoseBookTiming(bybitBook, comparisonTimestamp);
  const okx = diagnoseBookTiming(okxBook, comparisonTimestamp);
  const receiveSkewMs = Math.abs(
    bybitBook.receivedTimestamp - okxBook.receivedTimestamp,
  );
  const sourceTimestampSkewMs =
    bybitBook.exchangeTimestamp !== null &&
    okxBook.exchangeTimestamp !== null &&
    Number.isFinite(bybitBook.exchangeTimestamp) &&
    Number.isFinite(okxBook.exchangeTimestamp)
      ? Math.abs(bybitBook.exchangeTimestamp - okxBook.exchangeTimestamp)
      : null;
  const matchingEngineSkewMs =
    bybitBook.matchingEngineTimestamp !== null &&
    okxBook.matchingEngineTimestamp !== null &&
    Number.isFinite(bybitBook.matchingEngineTimestamp) &&
    Number.isFinite(okxBook.matchingEngineTimestamp)
      ? Math.abs(
          bybitBook.matchingEngineTimestamp - okxBook.matchingEngineTimestamp,
        )
      : null;
  const maxBookAgeMs = Math.max(bybit.bookAgeMs, okx.bookAgeMs);
  const reasons: SyncReason[] = [];

  if (
    hasSelfConsistencyAnomaly(bybitBook, bybit) ||
    hasSelfConsistencyAnomaly(okxBook, okx)
  ) {
    reasons.push('TIMESTAMP_ANOMALY');
  }
  if (clockHealth.status === 'CLOCK_JUMP_DETECTED') {
    reasons.push('CLOCK_UNHEALTHY');
  }
  if (receiveSkewMs > config.maxReceiveSkewMs) {
    reasons.push('RECEIVE_SKEW_HIGH');
  }
  if (
    sourceTimestampSkewMs !== null &&
    sourceTimestampSkewMs > config.maxSourceTimestampSkewMs
  ) {
    reasons.push('SOURCE_SKEW_HIGH');
  }
  if (
    bybit.bookAgeMs > config.maxBookAgeMs ||
    okx.bookAgeMs > config.maxBookAgeMs
  ) {
    reasons.push('BOOK_TOO_OLD');
  }
  if (
    sourceClocks.bybit.offsetStatus === 'DEVIATION_HIGH' ||
    sourceClocks.okx.offsetStatus === 'DEVIATION_HIGH'
  ) {
    reasons.push('SOURCE_OFFSET_DEVIATION_HIGH');
  }
  if (
    sourceClocks.bybit.offsetStatus === 'WARMING_UP' ||
    sourceClocks.okx.offsetStatus === 'WARMING_UP'
  ) {
    reasons.push('SYNC_WARMING_UP');
  }

  return {
    status: reasons[0] ?? 'SYNC_HEALTHY',
    receiveSkewMs,
    sourceTimestampSkewMs,
    matchingEngineSkewMs,
    bybitBookAgeMs: bybit.bookAgeMs,
    okxBookAgeMs: okx.bookAgeMs,
    maxBookAgeMs,
    bybitObservedIngressMs: bybit.observedExchangeToReceiveMs,
    okxObservedIngressMs: okx.observedExchangeToReceiveMs,
    bybitObservedMatchingEngineIngressMs:
      bybit.observedMatchingEngineToReceiveMs,
    okxObservedMatchingEngineIngressMs: okx.observedMatchingEngineToReceiveMs,
    bybitSourceClock: sourceClocks.bybit,
    okxSourceClock: sourceClocks.okx,
    clockHealth,
    reasons,
  };
}
