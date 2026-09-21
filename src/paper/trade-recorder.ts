import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  JsonlWriter,
  type RecorderErrorHandler,
} from '../recording/jsonl-writer.js';
import type { PaperTrade } from './types.js';

export interface PaperTradeRecord {
  recordedAt: number;
  trade: PaperTrade;
}

function defaultErrorHandler(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[PAPER RECORDER] Write failed: ${message}`);
}

export function createLivePaperTradePath(
  timestamp = Date.now(),
  id: string = randomUUID(),
): string {
  return join(
    'data',
    'paper',
    `live-${timestamp}-${id.slice(0, 8)}`,
    'trades.jsonl',
  );
}

export function createReplayPaperTradePath(
  timestamp = Date.now(),
  id: string = randomUUID(),
): string {
  return join(
    'data',
    'replays',
    `paper-${timestamp}-${id.slice(0, 8)}`,
    'paper-trades.jsonl',
  );
}

export class PaperTradeRecorder {
  private readonly writer: JsonlWriter;

  constructor(
    filePath: string,
    onError: RecorderErrorHandler = defaultErrorHandler,
  ) {
    this.writer = new JsonlWriter(filePath, onError);
  }

  record(trade: PaperTrade, recordedAt: number): Promise<void> {
    const record: PaperTradeRecord = { recordedAt, trade };
    return this.writer.append(record);
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }
}
