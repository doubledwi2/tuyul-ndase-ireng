import { FEES, type FeeConfig } from '../config/fees.js';
import { TARGET_BTC_SIZE } from '../config/simulation.js';
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
import { isValidBestQuote, type BestQuote } from '../types/market.js';
import {
  isValidNormalizedOrderBook,
  type NormalizedOrderBook,
} from '../types/orderbook.js';

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
}

export interface MarketPipelineOptions {
  eventRecorder?: Pick<EventRecorder, 'record' | 'flush'>;
  onEvent?: (event: OpportunityEvent) => void;
  fees?: FeeConfig;
  targetBaseSize?: number;
}

export class MarketPipeline {
  private readonly latestQuotes = new Map<BestQuote['exchange'], BestQuote>();
  private readonly latestBooks = new Map<
    NormalizedOrderBook['exchange'],
    NormalizedOrderBook
  >();
  private readonly opportunityTracker = new OpportunityTracker();
  private readonly opportunityMetrics = new OpportunityMetrics();
  private latestSnapshot: PipelineSnapshot | null = null;
  private latestDepthSnapshot: DepthPipelineSnapshot | null = null;

  constructor(private readonly options: MarketPipelineOptions = {}) {}

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
    this.processOpportunityComparisons(
      pipelineSnapshot.feeAwareComparisons.map(legacyFeeComparisonToDepth),
      processingTimestamp,
      false,
    );

    return pipelineSnapshot;
  }

  processOrderBook(
    orderBook: NormalizedOrderBook,
    processingTimestamp = Date.now(),
  ): DepthPipelineSnapshot | null {
    if (!isValidNormalizedOrderBook(orderBook)) {
      return null;
    }
    this.latestBooks.set(orderBook.exchange, orderBook);
    const bybitBook = this.latestBooks.get('bybit');
    const okxBook = this.latestBooks.get('okx');
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
      comparisons === null
    ) {
      return null;
    }
    const snapshot: DepthPipelineSnapshot = {
      bybitBook,
      okxBook,
      comparisons,
    };
    this.latestDepthSnapshot = snapshot;
    this.processOpportunityComparisons(comparisons, processingTimestamp, true);
    return snapshot;
  }

  private processOpportunityComparisons(
    comparisons: readonly DepthComparison[],
    processingTimestamp: number,
    recordComparisonMetrics: boolean,
  ): void {
    for (const comparison of comparisons) {
      if (recordComparisonMetrics) {
        this.opportunityMetrics.recordComparison(comparison);
      }
      const event = this.opportunityTracker.process(
        comparison,
        processingTimestamp,
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
