import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export function createReplayEventRecordPath(
  kind: 'quote' | 'book',
  timestamp = Date.now(),
  id = randomUUID(),
): string {
  return join(
    'data',
    'replays',
    `${kind}-${timestamp}-${id.slice(0, 8)}`,
    'opportunity-events.jsonl',
  );
}
