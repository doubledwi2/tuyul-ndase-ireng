import type { DepthPipelineSnapshot } from '../app/pipeline.js';
import type { OpportunityEvent } from '../scanner/opportunity.js';
import { PaperTradingEngine } from './engine.js';
import type { PaperTradeRecorder } from './trade-recorder.js';
import type { PaperTrade } from './types.js';

export interface PaperTradingCoordinatorOptions {
  engine: PaperTradingEngine;
  recorder?: Pick<PaperTradeRecorder, 'record' | 'flush'>;
  onTrade?: (trade: PaperTrade) => void;
}

export class PaperTradingCoordinator {
  constructor(private readonly options: PaperTradingCoordinatorOptions) {}

  processOpportunity(
    event: OpportunityEvent,
    snapshot: DepthPipelineSnapshot,
    timestamp: number,
  ): PaperTrade | null {
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
    const trade = this.options.engine.executeQualifiedOpportunity({
      event,
      bybitBook: snapshot.bybitBook,
      okxBook: snapshot.okxBook,
      syncAssessment: snapshot.syncAssessment,
      timestamp,
      latestQualification: qualification,
    });
    void this.options.recorder?.record(trade, timestamp);
    this.options.onTrade?.(trade);
    return trade;
  }

  observeSnapshot(snapshot: DepthPipelineSnapshot): void {
    this.options.engine.observeBooks(snapshot.bybitBook, snapshot.okxBook);
  }

  flush(): Promise<void> {
    return this.options.recorder?.flush() ?? Promise.resolve();
  }
}
