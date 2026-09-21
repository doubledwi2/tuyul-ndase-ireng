import type { DepthPipelineSnapshot } from '../app/pipeline.js';
import type { OpportunityEvent } from '../scanner/opportunity.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import type { PaperExecutionRecorder } from './execution-recorder.js';
import {
  LatencyPaperTradingEngine,
} from './latency-engine.js';
import type { LatencyPaperTrade } from './types.js';

export interface LatencyPaperCoordinatorOptions {
  engine: LatencyPaperTradingEngine;
  recorder?: Pick<PaperExecutionRecorder, 'flush'>;
  onTradeTriggered?: (trade: LatencyPaperTrade) => void;
}

export class LatencyPaperCoordinator {
  constructor(private readonly options: LatencyPaperCoordinatorOptions) {}

  processOpportunity(
    event: OpportunityEvent,
    snapshot: DepthPipelineSnapshot,
    timestamp: number,
  ): LatencyPaperTrade | null {
    if (event.state !== 'QUALIFIED') {
      return null;
    }
    const comparisonIndex = snapshot.comparisons.findIndex(
      (comparison) =>
        comparison.buyExchange === event.buyExchange &&
        comparison.sellExchange === event.sellExchange,
    );
    const qualification = snapshot.qualifications[comparisonIndex];
    if (qualification === undefined) {
      return null;
    }
    const trade = this.options.engine.triggerOpportunity({
      event,
      bybitBook: snapshot.bybitBook,
      okxBook: snapshot.okxBook,
      syncAssessment: snapshot.syncAssessment,
      timestamp,
      latestQualification: qualification,
    });
    this.options.onTradeTriggered?.(trade);
    return trade;
  }

  processOrderBook(
    orderBook: NormalizedOrderBook,
    logicalTimestamp: number,
  ): void {
    this.options.engine.processOrderBook(orderBook, logicalTimestamp);
  }

  finish(): void {
    this.options.engine.finish();
  }

  flush(): Promise<void> {
    return this.options.recorder?.flush() ?? Promise.resolve();
  }
}
