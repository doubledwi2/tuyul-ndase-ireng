import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { OpportunityEvent } from '../scanner/opportunity.js';

export const DEFAULT_EVENT_RECORD_PATH = 'data/opportunity-events.jsonl';

export interface OpportunityEventRecord {
  recordedAt: number;
  event: OpportunityEvent;
}

type ErrorHandler = (error: unknown) => void;

function defaultErrorHandler(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[RECORDER] Write failed: ${message}`);
}

export class EventRecorder {
  private pendingWrites: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath = DEFAULT_EVENT_RECORD_PATH,
    private readonly onError: ErrorHandler = defaultErrorHandler,
  ) {}

  record(event: OpportunityEvent, recordedAt: number): Promise<void> {
    let line: string;
    try {
      const record: OpportunityEventRecord = { recordedAt, event };
      line = `${JSON.stringify(record)}\n`;
    } catch (error) {
      this.onError(error);
      return Promise.resolve();
    }

    const write = this.pendingWrites.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, 'utf8');
    });

    this.pendingWrites = write.catch((error: unknown) => {
      this.onError(error);
    });

    return this.pendingWrites;
  }

  flush(): Promise<void> {
    return this.pendingWrites;
  }
}
