import type { OpportunityEvent } from '../scanner/opportunity.js';
import { sanitizeError } from '../security/secrets.js';
import {
  JsonlWriter,
  type RecorderErrorHandler,
} from './jsonl-writer.js';

export const DEFAULT_EVENT_RECORD_PATH = 'data/opportunity-events.jsonl';

export interface OpportunityEventRecord {
  recordedAt: number;
  event: OpportunityEvent;
}

function defaultErrorHandler(error: unknown): void {
  const message = sanitizeError(error);
  console.error(`[RECORDER] Write failed: ${message}`);
}

export class EventRecorder {
  private readonly writer: JsonlWriter;

  constructor(
    filePath = DEFAULT_EVENT_RECORD_PATH,
    onError: RecorderErrorHandler = defaultErrorHandler,
  ) {
    this.writer = new JsonlWriter(filePath, onError);
  }

  record(event: OpportunityEvent, recordedAt: number): Promise<void> {
    const record: OpportunityEventRecord = { recordedAt, event };
    return this.writer.append(record);
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }
}
