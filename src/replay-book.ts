import { MarketPipeline } from './app/pipeline.js';
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
}

function parseArguments(args: readonly string[]): ReplayArguments {
  let filePath = DEFAULT_ORDERBOOK_RECORD_PATH;
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
  const eventPath = createReplayEventRecordPath('book');
  const pipeline = new MarketPipeline({
    eventRecorder: new EventRecorder(eventPath),
    onEvent: printOpportunityEvent,
  });
  console.log(`[BOOK REPLAY] File: ${filePath}`);
  console.log(`[BOOK REPLAY] Speed: ${speed}`);
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
    printDepthComparisonSummary(snapshot.comparisons);
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
