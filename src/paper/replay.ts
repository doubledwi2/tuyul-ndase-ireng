import { MarketPipeline } from '../app/pipeline.js';
import type { FeeConfig } from '../config/fees.js';
import type { OpportunityQualityConfig } from '../config/opportunity.js';
import type { TimingConfig } from '../config/timing.js';
import { replayOrderBooks } from '../replay/orderbook-replay-engine.js';
import type { ReplaySpeed } from '../replay/replay-engine.js';
import { PaperTradingCoordinator } from './coordinator.js';
import {
  PaperTradingEngine,
  type PaperTradingEngineOptions,
} from './engine.js';
import type { PaperTradeRecorder } from './trade-recorder.js';
import type { PaperSessionSummary, PaperTrade } from './types.js';

export interface PaperReplayOptions {
  filePath: string;
  speed: ReplaySpeed;
  engineOptions?: PaperTradingEngineOptions;
  fees?: FeeConfig;
  qualityConfig?: OpportunityQualityConfig;
  timingConfig?: TimingConfig;
  recorder?: Pick<PaperTradeRecorder, 'record' | 'flush'>;
  onTrade?: (trade: PaperTrade) => void;
}

export interface PaperReplayResult {
  processedRecords: number;
  trades: PaperTrade[];
  summary: PaperSessionSummary;
}

export async function runPaperReplay(
  options: PaperReplayOptions,
): Promise<PaperReplayResult> {
  const engine = new PaperTradingEngine({
    ...options.engineOptions,
    ...(options.fees === undefined ? {} : { fees: options.fees }),
  });
  const coordinator = new PaperTradingCoordinator({
    engine,
    ...(options.recorder === undefined ? {} : { recorder: options.recorder }),
    ...(options.onTrade === undefined ? {} : { onTrade: options.onTrade }),
  });
  let pipeline: MarketPipeline;
  pipeline = new MarketPipeline({
    ...(options.fees === undefined ? {} : { fees: options.fees }),
    ...(options.qualityConfig === undefined
      ? {}
      : { qualityConfig: options.qualityConfig }),
    ...(options.timingConfig === undefined
      ? {}
      : { timingConfig: options.timingConfig }),
    onEvent: (event) => {
      const snapshot = pipeline.getLatestDepthSnapshot();
      if (snapshot !== null) {
        coordinator.processOpportunity(event, snapshot, event.updatedAt);
      }
    },
  });

  const replay = await replayOrderBooks({
    filePath: options.filePath,
    speed: options.speed,
    onOrderBook: (orderBook, recordedAt) => {
      const snapshot = pipeline.processOrderBook(orderBook, recordedAt);
      if (snapshot !== null) {
        coordinator.observeSnapshot(snapshot);
      }
    },
  });
  await coordinator.flush();
  return {
    processedRecords: replay.processedRecords,
    trades: engine.getTrades(),
    summary: engine.getSummary(),
  };
}
