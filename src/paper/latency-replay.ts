import { MarketPipeline } from '../app/pipeline.js';
import type { FeeConfig } from '../config/fees.js';
import type { OpportunityQualityConfig } from '../config/opportunity.js';
import type { TimingConfig } from '../config/timing.js';
import { replayOrderBooks } from '../replay/orderbook-replay-engine.js';
import type { ReplaySpeed } from '../replay/replay-engine.js';
import type { PaperExecutionRecorder } from './execution-recorder.js';
import { LatencyPaperCoordinator } from './latency-coordinator.js';
import {
  LatencyPaperTradingEngine,
  type LatencyPaperTradingEngineOptions,
} from './latency-engine.js';
import type {
  LatencyPaperTrade,
  PaperExecutionMetrics,
  PaperFill,
  PaperOrder,
  PaperSessionSummary,
} from './types.js';

export interface LatencyPaperReplayOptions {
  filePath: string;
  speed: ReplaySpeed;
  engineOptions?: LatencyPaperTradingEngineOptions;
  fees?: FeeConfig;
  qualityConfig?: OpportunityQualityConfig;
  timingConfig?: TimingConfig;
  recorder?: Pick<PaperExecutionRecorder, 'record' | 'flush'>;
  onTradeTriggered?: (trade: LatencyPaperTrade) => void;
}

export interface LatencyPaperReplayResult {
  processedRecords: number;
  trades: LatencyPaperTrade[];
  orders: PaperOrder[];
  fills: PaperFill[];
  summary: PaperSessionSummary;
  metrics: PaperExecutionMetrics;
}

export async function runLatencyPaperReplay(
  options: LatencyPaperReplayOptions,
): Promise<LatencyPaperReplayResult> {
  const engine = new LatencyPaperTradingEngine({
    ...options.engineOptions,
    ...(options.fees === undefined ? {} : { fees: options.fees }),
    ...(options.recorder === undefined
      ? {}
      : {
          onExecutionEvent: (event) => {
            void options.recorder?.record(event);
          },
        }),
  });
  const coordinator = new LatencyPaperCoordinator({
    engine,
    ...(options.recorder === undefined ? {} : { recorder: options.recorder }),
    ...(options.onTradeTriggered === undefined
      ? {}
      : { onTradeTriggered: options.onTradeTriggered }),
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
      pipeline.processOrderBook(orderBook, recordedAt);
      coordinator.processOrderBook(orderBook, recordedAt);
    },
  });
  coordinator.finish();
  await coordinator.flush();
  return {
    processedRecords: replay.processedRecords,
    trades: engine.getTrades(),
    orders: engine.getOrders(),
    fills: engine.getFills(),
    summary: engine.getSummary(),
    metrics: engine.getMetrics(),
  };
}
