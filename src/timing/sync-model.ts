import {
  TIMING_CONFIG,
  validateTimingConfig,
  type TimingConfig,
} from '../config/timing.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import type { ClockHealth } from './clock-health.js';

export type SyncStatus =
  | 'SYNC_HEALTHY'
  | 'RECEIVE_SKEW_HIGH'
  | 'SOURCE_SKEW_HIGH'
  | 'BOOK_TOO_OLD'
  | 'CLOCK_UNHEALTHY'
  | 'TIMESTAMP_ANOMALY';

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
  clockHealth: ClockHealth;
  reasons: SyncReason[];
}

function optionalDifference(left: number | null, right: number): number | null {
  return left === null ? null : right - left;
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

function hasNegativeTiming(diagnostic: BookTimingDiagnostic): boolean {
  return (
    diagnostic.bookAgeMs < 0 ||
    (diagnostic.observedExchangeToReceiveMs !== null &&
      diagnostic.observedExchangeToReceiveMs < 0) ||
    (diagnostic.observedMatchingEngineToReceiveMs !== null &&
      diagnostic.observedMatchingEngineToReceiveMs < 0)
  );
}

export function assessSynchronization(
  bybitBook: NormalizedOrderBook,
  okxBook: NormalizedOrderBook,
  comparisonTimestamp: number,
  clockHealth: ClockHealth,
  config: TimingConfig = TIMING_CONFIG,
): SyncAssessment {
  validateTimingConfig(config);
  const bybit = diagnoseBookTiming(bybitBook, comparisonTimestamp);
  const okx = diagnoseBookTiming(okxBook, comparisonTimestamp);
  const receiveSkewMs = Math.abs(
    bybitBook.receivedTimestamp - okxBook.receivedTimestamp,
  );
  const sourceTimestampSkewMs =
    bybitBook.exchangeTimestamp !== null && okxBook.exchangeTimestamp !== null
      ? Math.abs(bybitBook.exchangeTimestamp - okxBook.exchangeTimestamp)
      : null;
  const matchingEngineSkewMs =
    bybitBook.matchingEngineTimestamp !== null &&
    okxBook.matchingEngineTimestamp !== null
      ? Math.abs(
          bybitBook.matchingEngineTimestamp - okxBook.matchingEngineTimestamp,
        )
      : null;
  const maxBookAgeMs = Math.max(bybit.bookAgeMs, okx.bookAgeMs);
  const reasons: SyncReason[] = [];

  if (hasNegativeTiming(bybit) || hasNegativeTiming(okx)) {
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
    clockHealth,
    reasons,
  };
}
