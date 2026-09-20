import { MarketPipeline } from './app/pipeline.js';
import {
  OPPORTUNITY_QUALITY_CONFIG,
  type OpportunityQualityConfig,
} from './config/opportunity.js';
import { TIMING_CONFIG, type TimingConfig } from './config/timing.js';
import { EventRecorder } from './recording/event-recorder.js';
import { DEFAULT_ORDERBOOK_RECORD_PATH } from './recording/orderbook-recorder.js';
import { replayOrderBooks } from './replay/orderbook-replay-engine.js';
import type { ReplaySpeed } from './replay/replay-engine.js';
import { createReplayEventRecordPath } from './replay/replay-run.js';
import {
  printDepthComparisonSummary,
  printMetricsSummary,
  printOpportunityEvent,
} from './ui/console.js';

interface ReplayArguments {
  filePath: string;
  speed: ReplaySpeed;
  qualityConfig: OpportunityQualityConfig;
  timingConfig: TimingConfig;
}

function nonNegativeNumber(option: string, value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${option} requires a finite non-negative number.`);
  }
  return parsed;
}

function positiveInteger(option: string, value: string | undefined): number {
  const parsed = nonNegativeNumber(option, value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${option} requires a positive integer.`);
  }
  return parsed;
}

function parseArguments(args: readonly string[]): ReplayArguments {
  let filePath = DEFAULT_ORDERBOOK_RECORD_PATH;
  let speed: ReplaySpeed = 'max';
  const qualityConfig: OpportunityQualityConfig = {
    ...OPPORTUNITY_QUALITY_CONFIG,
  };
  const timingConfig: TimingConfig = { ...TIMING_CONFIG };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === '--file' && value !== undefined) {
      filePath = value;
      index += 1;
      continue;
    }
    if (
      argument === '--speed' &&
      (value === 'realtime' || value === 'fast' || value === 'max')
    ) {
      speed = value;
      index += 1;
      continue;
    }
    if (argument === '--min-net-spread') {
      qualityConfig.minNetSpreadPercent = nonNegativeNumber(argument, value);
      index += 1;
      continue;
    }
    if (argument === '--min-net-pnl') {
      qualityConfig.minNetPnlUsdt = nonNegativeNumber(argument, value);
      index += 1;
      continue;
    }
    if (argument === '--min-duration') {
      qualityConfig.minActiveDurationMs = nonNegativeNumber(argument, value);
      index += 1;
      continue;
    }
    if (argument === '--max-sync-diff') {
      timingConfig.maxReceiveSkewMs = nonNegativeNumber(
        argument,
        value,
      );
      index += 1;
      continue;
    }
    if (argument === '--max-receive-skew') {
      timingConfig.maxReceiveSkewMs = nonNegativeNumber(argument, value);
      index += 1;
      continue;
    }
    if (argument === '--max-book-age') {
      timingConfig.maxBookAgeMs = nonNegativeNumber(argument, value);
      index += 1;
      continue;
    }
    if (argument === '--max-source-skew') {
      timingConfig.maxSourceTimestampSkewMs = nonNegativeNumber(
        argument,
        value,
      );
      index += 1;
      continue;
    }
    if (argument === '--min-offset-samples') {
      timingConfig.minOffsetSamples = positiveInteger(argument, value);
      index += 1;
      continue;
    }
    if (argument === '--offset-window-size') {
      timingConfig.offsetWindowSize = positiveInteger(argument, value);
      index += 1;
      continue;
    }
    if (argument === '--max-offset-deviation') {
      timingConfig.maxOffsetDeviationMs = nonNegativeNumber(argument, value);
      index += 1;
      continue;
    }
    throw new Error(
      `Invalid argument: ${argument ?? '(missing)'}. ` +
        'Use --file <path>, --speed realtime|fast|max, and optional quality overrides.',
    );
  }
  return { filePath, speed, qualityConfig, timingConfig };
}

async function main(): Promise<void> {
  const { filePath, speed, qualityConfig, timingConfig } = parseArguments(
    process.argv.slice(2),
  );
  const eventPath = createReplayEventRecordPath('book');
  const pipeline = new MarketPipeline({
    eventRecorder: new EventRecorder(eventPath),
    onEvent: printOpportunityEvent,
    qualityConfig,
    timingConfig,
  });
  console.log(`[BOOK REPLAY] File: ${filePath}`);
  console.log(`[BOOK REPLAY] Speed: ${speed}`);
  console.log(
    `[BOOK REPLAY] Quality: spread>=${qualityConfig.minNetSpreadPercent}%, ` +
      `PnL>=${qualityConfig.minNetPnlUsdt} USDT, ` +
      `duration>=${qualityConfig.minActiveDurationMs} ms, ` +
      `sync<=${qualityConfig.maxSyncDiffMsForQualified} ms`,
  );
  console.log(
    `[BOOK REPLAY] Timing: receive skew<=${timingConfig.maxReceiveSkewMs} ms, ` +
      `book age<=${timingConfig.maxBookAgeMs} ms, ` +
      `source skew<=${timingConfig.maxSourceTimestampSkewMs} ms, ` +
      `offset warm-up=${timingConfig.minOffsetSamples}, ` +
      `offset window=${timingConfig.offsetWindowSize}, ` +
      `offset deviation<=${timingConfig.maxOffsetDeviationMs} ms`,
  );
  const result = await replayOrderBooks({
    filePath,
    speed,
    onOrderBook: (orderBook, recordedAt) => {
      pipeline.processOrderBook(orderBook, recordedAt);
    },
  });
  await pipeline.flush();
  const snapshot = pipeline.getLatestDepthSnapshot();
  if (snapshot !== null) {
    printDepthComparisonSummary(
      snapshot.comparisons,
      snapshot.qualifications,
      qualityConfig,
      snapshot.syncAssessment,
      snapshot.processingDurationMs,
      timingConfig,
    );
  }
  printMetricsSummary(pipeline.getMetricsSummary());
  console.log(`\n[BOOK REPLAY] Processed records: ${result.processedRecords}`);
  console.log(`[BOOK REPLAY] Open events: ${pipeline.getOpenEventCount()}`);
  console.log(`[BOOK REPLAY] Event output: ${eventPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[BOOK REPLAY] Failed: ${message}`);
  process.exitCode = 1;
});
