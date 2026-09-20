import { FEES, type FeeConfig } from '../config/fees.js';
import {
  OPPORTUNITY_QUALITY_CONFIG,
  type OpportunityQualityConfig,
} from '../config/opportunity.js';
import { TARGET_BTC_SIZE } from '../config/simulation.js';
import { TIMING_CONFIG, type TimingConfig } from '../config/timing.js';
import {
  OpportunityMetrics,
  type OpportunityMetricsSummary,
} from '../metrics/opportunity-metrics.js';
import type { EventRecorder } from '../recording/event-recorder.js';
import {
  compareQuotes,
  type CrossExchangeComparisons,
} from '../scanner/comparator.js';
import {
  calculateFeeAwareComparison,
  type FeeAwareComparisons,
} from '../scanner/fee-model.js';
import {
  compareOrderBooks,
  legacyFeeComparisonToDepth,
  type DepthComparison,
  type DepthComparisons,
} from '../scanner/depth-comparator.js';
import {
  OpportunityTracker,
  type OpportunityEvent,
} from '../scanner/opportunity.js';
import {
  qualifyOpportunity,
  type OpportunityQualification,
} from '../scanner/opportunity-filter.js';
import { isValidBestQuote, type BestQuote } from '../types/market.js';
import {
  isValidNormalizedOrderBook,
  type NormalizedOrderBook,
} from '../types/orderbook.js';
import {
  DETERMINISTIC_HEALTHY_CLOCK,
  type ClockHealth,
} from '../timing/clock-health.js';
import {
  assessSynchronization,
  type SyncAssessment,
} from '../timing/sync-model.js';
import {
  SourceClockOffsetEstimator,
  type SourceClockOffsetDiagnostic,
} from '../timing/source-clock-offset.js';

export interface PipelineSnapshot {
  bybitQuote: BestQuote;
  okxQuote: BestQuote;
  comparisons: CrossExchangeComparisons;
  feeAwareComparisons: FeeAwareComparisons;
}

export interface DepthPipelineSnapshot {
  bybitBook: NormalizedOrderBook;
  okxBook: NormalizedOrderBook;
  comparisons: DepthComparisons;
  qualifications: OpportunityQualifications;
  syncAssessment: SyncAssessment;
  processingDurationMs: number | null;
}

export type OpportunityQualifications = [
  OpportunityQualification,
  OpportunityQualification,
];

export interface MarketPipelineOptions {
  eventRecorder?: Pick<EventRecorder, 'record' | 'flush'>;
  onEvent?: (event: OpportunityEvent) => void;
  fees?: FeeConfig;
  targetBaseSize?: number;
  qualityConfig?: OpportunityQualityConfig;
  timingConfig?: TimingConfig;
  monotonicNow?: () => number;
}

export class MarketPipeline {
  private readonly latestQuotes = new Map<BestQuote['exchange'], BestQuote>();
  private readonly latestBooks = new Map<
    NormalizedOrderBook['exchange'],
    NormalizedOrderBook
  >();
  private readonly opportunityTracker: OpportunityTracker;
  private readonly opportunityMetrics = new OpportunityMetrics();
  private readonly sourceClockOffsetEstimators: Record<
    NormalizedOrderBook['exchange'],
    SourceClockOffsetEstimator
  >;
  private readonly latestSourceClockDiagnostics = new Map<
    NormalizedOrderBook['exchange'],
    SourceClockOffsetDiagnostic
  >();
  private latestSnapshot: PipelineSnapshot | null = null;
  private latestDepthSnapshot: DepthPipelineSnapshot | null = null;

  constructor(private readonly options: MarketPipelineOptions = {}) {
    const timingConfig = options.timingConfig ?? TIMING_CONFIG;
    this.opportunityTracker = new OpportunityTracker(
      options.qualityConfig ?? OPPORTUNITY_QUALITY_CONFIG,
    );
    this.sourceClockOffsetEstimators = {
      bybit: new SourceClockOffsetEstimator(timingConfig),
      okx: new SourceClockOffsetEstimator(timingConfig),
    };
  }

  processQuote(
    quote: BestQuote,
    processingTimestamp = Date.now(),
  ): PipelineSnapshot | null {
    if (!isValidBestQuote(quote)) {
      return null;
    }

    this.latestQuotes.set(quote.exchange, quote);

    const bybitQuote = this.latestQuotes.get('bybit');
    const okxQuote = this.latestQuotes.get('okx');
    const comparisons = compareQuotes(
      bybitQuote,
      okxQuote,
      processingTimestamp,
    );

    if (
      bybitQuote === undefined ||
      okxQuote === undefined ||
      comparisons === null
    ) {
      return null;
    }

    const pipelineSnapshot: PipelineSnapshot = {
      bybitQuote,
      okxQuote,
      comparisons,
      feeAwareComparisons: [
        calculateFeeAwareComparison(comparisons[0], this.options.fees ?? FEES),
        calculateFeeAwareComparison(comparisons[1], this.options.fees ?? FEES),
      ],
    };
    this.latestSnapshot = pipelineSnapshot;
    const legacyComparisons = pipelineSnapshot.feeAwareComparisons.map(
      legacyFeeComparisonToDepth,
    );
    const legacyQualityConfig: OpportunityQualityConfig = {
      minNetSpreadPercent: 0,
      minNetPnlUsdt: 0,
      minActiveDurationMs: 0,
      maxSyncDiffMsForQualified: Number.MAX_SAFE_INTEGER,
    };
    this.processOpportunityComparisons(
      legacyComparisons,
      legacyComparisons.map((comparison) =>
        qualifyOpportunity(comparison, legacyQualityConfig),
      ),
      processingTimestamp,
      false,
      undefined,
    );

    return pipelineSnapshot;
  }

  processOrderBook(
    orderBook: NormalizedOrderBook,
    processingTimestamp = Date.now(),
    clockHealth: ClockHealth = DETERMINISTIC_HEALTHY_CLOCK,
  ): DepthPipelineSnapshot | null {
    if (!isValidNormalizedOrderBook(orderBook)) {
      return null;
    }
    const sourceClockDiagnostic = this.sourceClockOffsetEstimators[
      orderBook.exchange
    ].observe(orderBook.exchangeTimestamp, orderBook.receivedTimestamp);
    this.latestSourceClockDiagnostics.set(
      orderBook.exchange,
      sourceClockDiagnostic,
    );
    this.latestBooks.set(orderBook.exchange, orderBook);
    const bybitBook = this.latestBooks.get('bybit');
    const okxBook = this.latestBooks.get('okx');
    const bybitSourceClock = this.latestSourceClockDiagnostics.get('bybit');
    const okxSourceClock = this.latestSourceClockDiagnostics.get('okx');
    const comparisons = compareOrderBooks(
      bybitBook,
      okxBook,
      this.options.targetBaseSize ?? TARGET_BTC_SIZE,
      this.options.fees ?? FEES,
      processingTimestamp,
    );
    if (
      bybitBook === undefined ||
      okxBook === undefined ||
      bybitSourceClock === undefined ||
      okxSourceClock === undefined ||
      comparisons === null
    ) {
      return null;
    }
    const syncAssessment = assessSynchronization(
      bybitBook,
      okxBook,
      processingTimestamp,
      clockHealth,
      this.options.timingConfig ?? TIMING_CONFIG,
      { bybit: bybitSourceClock, okx: okxSourceClock },
    );
    const qualifications = comparisons.map((comparison) =>
      qualifyOpportunity(
        comparison,
        this.options.qualityConfig ?? OPPORTUNITY_QUALITY_CONFIG,
        syncAssessment,
      ),
    ) as OpportunityQualifications;
    const processingCompletedMonotonicMs = this.options.monotonicNow?.();
    const receivedMonotonicMs = orderBook.receivedMonotonicMs ?? null;
    const measuredDuration =
      processingCompletedMonotonicMs !== undefined &&
      receivedMonotonicMs !== null
        ? processingCompletedMonotonicMs - receivedMonotonicMs
        : null;
    const processingDurationMs =
      measuredDuration !== null &&
      Number.isFinite(measuredDuration) &&
      measuredDuration >= 0
        ? measuredDuration
        : null;
    const snapshot: DepthPipelineSnapshot = {
      bybitBook,
      okxBook,
      comparisons,
      qualifications,
      syncAssessment,
      processingDurationMs,
    };
    this.latestDepthSnapshot = snapshot;
    this.opportunityMetrics.recordTiming(
      syncAssessment,
      processingDurationMs,
      orderBook.exchange,
    );
    this.processOpportunityComparisons(
      comparisons,
      snapshot.qualifications,
      processingTimestamp,
      true,
      syncAssessment,
    );
    return snapshot;
  }

  private processOpportunityComparisons(
    comparisons: readonly DepthComparison[],
    qualifications: readonly OpportunityQualification[],
    processingTimestamp: number,
    recordComparisonMetrics: boolean,
    syncAssessment: SyncAssessment | undefined,
  ): void {
    for (const [index, comparison] of comparisons.entries()) {
      const qualification = qualifications[index];
      if (qualification === undefined) {
        throw new Error('Missing opportunity qualification.');
      }
      if (recordComparisonMetrics) {
        this.opportunityMetrics.recordComparison(comparison, qualification);
      }
      const event = this.opportunityTracker.process(
        comparison,
        processingTimestamp,
        qualification,
        syncAssessment,
      );
      if (event === null) {
        continue;
      }

      if (event.state === 'DISAPPEARED') {
        this.opportunityMetrics.recordCompleted(event);
      }
      void this.options.eventRecorder?.record(event, processingTimestamp);
      this.options.onEvent?.(event);
    }
  }

  getLatestSnapshot(): PipelineSnapshot | null {
    return this.latestSnapshot;
  }

  getLatestDepthSnapshot(): DepthPipelineSnapshot | null {
    return this.latestDepthSnapshot;
  }

  getMetricsSummary(): OpportunityMetricsSummary {
    return this.opportunityMetrics.getSummary();
  }

  getOpenEventCount(): number {
    return this.opportunityTracker.getOpenEventCount();
  }

  async flush(): Promise<void> {
    await this.options.eventRecorder?.flush();
  }
}
