import { DEFAULT_ORDERBOOK_RECORD_PATH } from './recording/orderbook-recorder.js';
import type { ReplaySpeed } from './replay/replay-engine.js';
import { printPaperSummary, printPaperTrade } from './paper/console.js';
import { runPaperReplay } from './paper/replay.js';
import {
  createReplayPaperTradePath,
  PaperTradeRecorder,
} from './paper/trade-recorder.js';

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
  const tradePath = createReplayPaperTradePath();
  console.log(`[PAPER REPLAY] File: ${filePath}`);
  console.log(`[PAPER REPLAY] Speed: ${speed}`);
  console.log(`[PAPER REPLAY] Trade output: ${tradePath}`);
  const result = await runPaperReplay({
    filePath,
    speed,
    recorder: new PaperTradeRecorder(tradePath),
    onTrade: printPaperTrade,
  });
  printPaperSummary(result.summary);
  console.log(`\n[PAPER REPLAY] Processed records: ${result.processedRecords}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[PAPER REPLAY] Failed: ${message}`);
  process.exitCode = 1;
});
