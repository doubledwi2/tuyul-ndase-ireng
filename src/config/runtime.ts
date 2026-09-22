export const CHECKPOINT_SCHEMA_VERSION = 1;
export const JOURNAL_SCHEMA_VERSION = 1;
export const CHECKPOINT_EVERY_EVENTS = 100;
export const MAX_METRIC_SAMPLES = 10_000;
export const MAX_PAPER_HISTORY = 10_000;

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type LogFormat = 'text' | 'json';

function parsePort(value: string | undefined): number {
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

export const DATA_DIR = process.env.DATA_DIR ?? './data';
export const HEALTH_HOST = process.env.HEALTH_HOST ?? '127.0.0.1';
export const HEALTH_PORT = parsePort(process.env.HEALTH_PORT);
export const LOG_LEVEL = parseLogLevel(process.env.LOG_LEVEL);
export const LOG_FORMAT = parseLogFormat(process.env.LOG_FORMAT);
