import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { MarketPipeline } from './app/pipeline.js';
import { EventRecorder } from './recording/event-recorder.js';
import { DEFAULT_MARKET_RECORD_PATH } from './recording/market-recorder.js';
import {
  replayMarketData,
  type ReplaySpeed,
} from './replay/replay-engine.js';
import {
  printComparisonSummary,
  printMetricsSummary,
  printOpportunityEvent,
} from './ui/console.js';

interface ReplayArguments {
  filePath: string;
  speed: ReplaySpeed;
}

export function createReplayEventRecordPath(
  timestamp = Date.now(),
  id = randomUUID(),
): string {
  return join(
    'data',
    'replays',
    `${timestamp}-${id.slice(0, 8)}`,
    'opportunity-events.jsonl',
  );
}

function parseArguments(args: readonly string[]): ReplayArguments {
  let filePath = DEFAULT_MARKET_RECORD_PATH;
  let speed: ReplaySpeed = 'max';

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

    throw new Error(
      `Invalid argument: ${argument ?? '(missing)'}. ` +
        'Use --file <path> and --speed realtime|fast|max.',
    );
  }

  return { filePath, speed };
}

async function main(): Promise<void> {
  const { filePath, speed } = parseArguments(process.argv.slice(2));
  const replayEventRecordPath = createReplayEventRecordPath();
  const replayEventRecorder = new EventRecorder(replayEventRecordPath);
  const pipeline = new MarketPipeline({
    eventRecorder: replayEventRecorder,
    onEvent: printOpportunityEvent,
  });

  console.log(`[REPLAY] File: ${filePath}`);
  console.log(`[REPLAY] Speed: ${speed}`);
  const result = await replayMarketData({
    filePath,
    speed,
    onQuote: (quote, recordedAt) => {
      pipeline.processQuote(quote, recordedAt);
    },
  });

  await pipeline.flush();
  const finalSnapshot = pipeline.getLatestSnapshot();
  if (finalSnapshot !== null) {
    printComparisonSummary(
      finalSnapshot.bybitQuote,
      finalSnapshot.okxQuote,
      finalSnapshot.feeAwareComparisons,
    );
  }
  printMetricsSummary(pipeline.getMetricsSummary());
  console.log(`\n[REPLAY] Processed records: ${result.processedRecords}`);
  console.log(`[REPLAY] Open events: ${pipeline.getOpenEventCount()}`);
  console.log(`[REPLAY] Event output: ${replayEventRecordPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[REPLAY] Failed: ${message}`);
  process.exitCode = 1;
});
