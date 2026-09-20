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
  OpportunityTracker,
  type OpportunityEvent,
} from '../scanner/opportunity.js';
import { isValidBestQuote, type BestQuote } from '../types/market.js';

export interface PipelineSnapshot {
  bybitQuote: BestQuote;
  okxQuote: BestQuote;
  comparisons: CrossExchangeComparisons;
}

export interface MarketPipelineOptions {
  eventRecorder?: Pick<EventRecorder, 'record' | 'flush'>;
  onEvent?: (event: OpportunityEvent) => void;
}

export class MarketPipeline {
  private readonly latestQuotes = new Map<BestQuote['exchange'], BestQuote>();
  private readonly opportunityTracker = new OpportunityTracker();
  private readonly opportunityMetrics = new OpportunityMetrics();
  private latestSnapshot: PipelineSnapshot | null = null;

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
    };
    this.latestSnapshot = pipelineSnapshot;

    for (const comparison of comparisons) {
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

    return pipelineSnapshot;
  }

  getLatestSnapshot(): PipelineSnapshot | null {
    return this.latestSnapshot;
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
