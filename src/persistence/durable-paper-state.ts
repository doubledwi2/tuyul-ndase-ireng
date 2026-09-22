import { open, mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  CHECKPOINT_EVERY_EVENTS,
  CHECKPOINT_SCHEMA_VERSION,
  JOURNAL_SCHEMA_VERSION,
} from '../config/runtime.js';
import {
  validatePaperEngineState,
  type PaperEngineState,
} from '../paper/state.js';
import type { PaperExecutionEvent } from '../paper/types.js';

export interface PaperEngineCheckpoint {
  schemaVersion: 1;
  savedAt: number;
  lastAppliedJournalSeq: number;
  engineState: PaperEngineState;
}

export interface PaperJournalRecord {
  schemaVersion: 1;
  seq: number;
  recordedAt: number;
  event: PaperExecutionEvent;
  engineState: PaperEngineState;
}

export interface PersistenceHealth {
  checkpointHealthy: boolean;
  journalHealthy: boolean;
  lastCheckpointAt: number | null;
  lastJournalSeq: number;
  lastError: string | null;
}

export interface DurablePaperStateStoreOptions {
  dataDir: string;
  checkpointEveryEvents?: number;
  now?: () => number;
  onHealthChange?: (health: PersistenceHealth) => void;
}

export interface DurablePaperStateOpenResult {
  store: DurablePaperStateStore;
  recoveredState: PaperEngineState | null;
  replayedJournalRecords: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (
      isRecord(error) &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

function parseCheckpoint(raw: string): PaperEngineCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Checkpoint JSON is malformed: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    throw new Error('Unsupported or missing checkpoint schemaVersion.');
  }
  if (
    typeof parsed.savedAt !== 'number' ||
    !Number.isFinite(parsed.savedAt) ||
    !Number.isInteger(parsed.lastAppliedJournalSeq) ||
    (parsed.lastAppliedJournalSeq as number) < 0
  ) {
    throw new Error('Checkpoint metadata is invalid.');
  }
  validatePaperEngineState(parsed.engineState);
  return parsed as unknown as PaperEngineCheckpoint;
}

function parseJournal(raw: string): PaperJournalRecord[] {
  if (raw.length === 0) {
    return [];
  }
  const records: PaperJournalRecord[] = [];
  let previousSeq = 0;
  for (const [index, line] of raw.split('\n').entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(
        `Journal line ${index + 1} is malformed: ${errorMessage(error)}`,
      );
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
      throw new Error(`Journal line ${index + 1} has an unsupported schema.`);
    }
    if (
      !Number.isInteger(parsed.seq) ||
      (parsed.seq as number) <= previousSeq ||
      typeof parsed.recordedAt !== 'number' ||
      !Number.isFinite(parsed.recordedAt) ||
      !isRecord(parsed.event)
    ) {
      throw new Error(
        `Journal line ${index + 1} violates sequence or event integrity.`,
      );
    }
    validatePaperEngineState(parsed.engineState);
    const record = parsed as unknown as PaperJournalRecord;
    previousSeq = record.seq;
    records.push(record);
  }
  return records;
}

export async function writeAtomicCheckpoint(
  path: string,
  checkpoint: PaperEngineCheckpoint,
): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(temporaryPath, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
}

async function appendDurable(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'a');
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class DurablePaperStateStore {
  readonly checkpointPath: string;
  readonly journalPath: string;
  private readonly checkpointEveryEvents: number;
  private readonly now: () => number;
  private readonly onHealthChange:
    | ((health: PersistenceHealth) => void)
    | undefined;
  private stateProvider: (() => PaperEngineState) | null = null;
  private pending: Promise<void> = Promise.resolve();
  private lastJournalSeq = 0;
  private eventsSinceCheckpoint = 0;
  private checkpointHealthy = true;
  private journalHealthy = true;
  private lastCheckpointAt: number | null = null;
  private lastError: string | null = null;

  private constructor(options: DurablePaperStateStoreOptions) {
    this.checkpointPath = join(options.dataDir, 'state', 'checkpoint.json');
    this.journalPath = join(options.dataDir, 'state', 'journal.jsonl');
    this.checkpointEveryEvents =
      options.checkpointEveryEvents ?? CHECKPOINT_EVERY_EVENTS;
    if (
      !Number.isInteger(this.checkpointEveryEvents) ||
      this.checkpointEveryEvents <= 0
    ) {
      throw new RangeError('Checkpoint event cadence must be positive.');
    }
    this.now = options.now ?? Date.now;
    this.onHealthChange = options.onHealthChange;
  }

  static async open(
    options: DurablePaperStateStoreOptions,
  ): Promise<DurablePaperStateOpenResult> {
    const store = new DurablePaperStateStore(options);
    const checkpointRaw = await readOptional(store.checkpointPath);
    const journalRaw = await readOptional(store.journalPath);
    const checkpoint =
      checkpointRaw === null ? null : parseCheckpoint(checkpointRaw);
    const journal = journalRaw === null ? [] : parseJournal(journalRaw);
    const checkpointSeq = checkpoint?.lastAppliedJournalSeq ?? 0;
    const lastJournalSeq = journal.at(-1)?.seq ?? 0;
    if (checkpointSeq > lastJournalSeq) {
      throw new Error('Checkpoint sequence is ahead of the durable journal.');
    }
    store.lastJournalSeq = Math.max(checkpointSeq, lastJournalSeq);
    store.lastCheckpointAt = checkpoint?.savedAt ?? null;
    let recoveredState = checkpoint?.engineState ?? null;
    let replayedJournalRecords = 0;
    for (const record of journal) {
      if (record.seq <= checkpointSeq) {
        continue;
      }
      recoveredState = record.engineState;
      replayedJournalRecords += 1;
    }
    store.emitHealth();
    return { store, recoveredState, replayedJournalRecords };
  }

  attachStateProvider(provider: () => PaperEngineState): void {
    this.stateProvider = provider;
  }

  record(event: PaperExecutionEvent): Promise<void> {
    const seq = this.lastJournalSeq + 1;
    this.lastJournalSeq = seq;
    this.pending = this.pending.then(async () => {
      let engineState: PaperEngineState;
      try {
        engineState = this.requireStateProvider()();
        validatePaperEngineState(engineState);
        const record: PaperJournalRecord = {
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          seq,
          recordedAt: this.now(),
          event,
          engineState,
        };
        await appendDurable(this.journalPath, record);
        this.eventsSinceCheckpoint += 1;
        this.journalHealthy = true;
        this.lastError = null;
      } catch (error) {
        this.journalHealthy = false;
        this.lastError = errorMessage(error);
        this.emitHealth();
        return;
      }
      const terminalTrade =
        event.type === 'TRADE' && event.trade.closedAt !== null;
      const halted = engineState.riskState.sessionRiskState === 'RISK_HALTED';
      if (
        terminalTrade ||
        halted ||
        this.eventsSinceCheckpoint >= this.checkpointEveryEvents
      ) {
        try {
          await this.writeCheckpoint(engineState, seq);
        } catch (error) {
          this.checkpointHealthy = false;
          this.lastError = errorMessage(error);
        }
      }
      this.emitHealth();
    });
    return this.pending;
  }

  checkpoint(): Promise<void> {
    this.pending = this.pending.then(async () => {
      try {
        const state = this.requireStateProvider()();
        validatePaperEngineState(state);
        await this.writeCheckpoint(state, this.lastJournalSeq);
        this.lastError = null;
        this.emitHealth();
      } catch (error) {
        this.checkpointHealthy = false;
        this.lastError = errorMessage(error);
        this.emitHealth();
      }
    });
    return this.pending;
  }

  async flushAndCheckpoint(): Promise<void> {
    await this.pending;
    await this.checkpoint();
  }

  flush(): Promise<void> {
    return this.pending;
  }

  getHealth(): PersistenceHealth {
    return {
      checkpointHealthy: this.checkpointHealthy,
      journalHealthy: this.journalHealthy,
      lastCheckpointAt: this.lastCheckpointAt,
      lastJournalSeq: this.lastJournalSeq,
      lastError: this.lastError,
    };
  }

  private requireStateProvider(): () => PaperEngineState {
    if (this.stateProvider === null) {
      throw new Error('Durable state provider is not attached.');
    }
    return this.stateProvider;
  }

  private async writeCheckpoint(
    engineState: PaperEngineState,
    lastAppliedJournalSeq: number,
  ): Promise<void> {
    const savedAt = this.now();
    const checkpoint: PaperEngineCheckpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      savedAt,
      lastAppliedJournalSeq,
      engineState,
    };
    await writeAtomicCheckpoint(this.checkpointPath, checkpoint);
    this.checkpointHealthy = true;
    this.lastCheckpointAt = savedAt;
    this.eventsSinceCheckpoint = 0;
  }

  private emitHealth(): void {
    this.onHealthChange?.(this.getHealth());
  }
}
