import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  JsonlWriter,
  type RecorderErrorHandler,
} from '../recording/jsonl-writer.js';
import type { PaperExecutionEvent } from './types.js';

function defaultErrorHandler(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[PAPER EVENT RECORDER] Write failed: ${message}`);
}

export function createLivePaperEventPath(
  timestamp = Date.now(),
  id: string = randomUUID(),
): string {
  return join(
    'data',
    'paper',
    `live-${timestamp}-${id.slice(0, 8)}`,
    'paper-events.jsonl',
  );
}

export function createReplayPaperEventPath(
  timestamp = Date.now(),
  id: string = randomUUID(),
): string {
  return join(
    'data',
    'replays',
    `paper-${timestamp}-${id.slice(0, 8)}`,
    'paper-events.jsonl',
  );
}

export class PaperExecutionRecorder {
  private readonly writer: JsonlWriter;

  constructor(
    filePath: string,
    onError: RecorderErrorHandler = defaultErrorHandler,
  ) {
    this.writer = new JsonlWriter(filePath, onError);
  }

  record(event: PaperExecutionEvent): Promise<void> {
    return this.writer.append(event);
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }
}
