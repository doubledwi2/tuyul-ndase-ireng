export const CHECKPOINT_SCHEMA_VERSION = 1;
export const JOURNAL_SCHEMA_VERSION = 1;
export const CHECKPOINT_EVERY_EVENTS = positiveEnv('CHECKPOINT_EVERY_EVENTS', 100);
export const MAX_METRIC_SAMPLES = 10_000;
export const MAX_PAPER_HISTORY = 10_000;

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type LogFormat = 'text' | 'json';

function parsePort(value: string | undefined): number {
  if (value?.trim() === '') throw new RangeError('HEALTH_PORT cannot be empty.');
  const parsed = value === undefined ? 8080 : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new RangeError('HEALTH_PORT must be an integer from 0 to 65535.');
  }
  return parsed;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.toUpperCase() ?? 'INFO';
  if (!['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(normalized)) {
    throw new RangeError('LOG_LEVEL must be DEBUG, INFO, WARN, or ERROR.');
  }
  return normalized as LogLevel;
}

function parseLogFormat(value: string | undefined): LogFormat {
  const normalized = value?.toLowerCase() ?? 'text';
  if (normalized !== 'text' && normalized !== 'json') {
    throw new RangeError('LOG_FORMAT must be text or json.');
  }
  return normalized;
}

export function positiveEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}
function nonempty(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;
  if (!value.trim()) throw new RangeError(`${name} cannot be empty.`);
  return value;
}
export const DATA_DIR = nonempty('DATA_DIR', './data');
export const HEALTH_HOST = nonempty('HEALTH_HOST', '127.0.0.1');
export const HEALTH_PORT = parsePort(process.env.HEALTH_PORT);
export const LOG_LEVEL = parseLogLevel(process.env.LOG_LEVEL);
export const LOG_FORMAT = parseLogFormat(process.env.LOG_FORMAT);
export const JOURNAL_COMPACT_AFTER_RECORDS = positiveEnv('JOURNAL_COMPACT_AFTER_RECORDS', 10_000);
export const JOURNAL_MAX_BYTES = positiveEnv('JOURNAL_MAX_BYTES', 50 * 1024 * 1024);
export const MAX_JOURNAL_ARCHIVES = positiveEnv('MAX_JOURNAL_ARCHIVES', 3);
export const MAX_FEED_SILENCE_MS = positiveEnv('MAX_FEED_SILENCE_MS', 5_000);
export const MIN_FREE_DISK_MB = positiveEnv('MIN_FREE_DISK_MB', 500);
export const MAX_CHECKPOINT_AGE_MS = positiveEnv('MAX_CHECKPOINT_AGE_MS', 300_000);
export const MAX_PERSISTENCE_QUEUE_DEPTH = positiveEnv('MAX_PERSISTENCE_QUEUE_DEPTH', 1000);
export function operationalConfigSnapshot(): Record<string, string | number> {
  return { DATA_DIR, HEALTH_HOST, HEALTH_PORT, LOG_LEVEL, LOG_FORMAT,
    CHECKPOINT_EVERY_EVENTS, JOURNAL_COMPACT_AFTER_RECORDS, JOURNAL_MAX_BYTES,
    MAX_JOURNAL_ARCHIVES, MAX_FEED_SILENCE_MS, MIN_FREE_DISK_MB,
    MAX_CHECKPOINT_AGE_MS, MAX_PERSISTENCE_QUEUE_DEPTH };
}
