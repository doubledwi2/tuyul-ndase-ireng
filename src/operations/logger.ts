import {
  LOG_FORMAT,
  LOG_LEVEL,
  type LogFormat,
  type LogLevel,
} from '../config/runtime.js';

export interface LogContext {
  tradeId?: string;
  orderId?: string;
  exchange?: 'bybit' | 'okx';
  [key: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

export class Logger {
  constructor(
    private readonly component: string,
    private readonly level: LogLevel = LOG_LEVEL,
    private readonly format: LogFormat = LOG_FORMAT,
  ) {}

  debug(event: string, message: string, context: LogContext = {}): void {
    this.write('DEBUG', event, message, context);
  }

  info(event: string, message: string, context: LogContext = {}): void {
    this.write('INFO', event, message, context);
  }

  warn(event: string, message: string, context: LogContext = {}): void {
    this.write('WARN', event, message, context);
  }

  error(event: string, message: string, context: LogContext = {}): void {
    this.write('ERROR', event, message, context);
  }

  private write(
    level: LogLevel,
    event: string,
    message: string,
    context: LogContext,
  ): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.level]) {
      return;
    }
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      event,
      message,
      ...context,
    };
    const output =
      this.format === 'json'
        ? JSON.stringify(entry)
        : `[${level}] [${this.component}] ${event}: ${message}${Object.keys(context).length ? ` ${JSON.stringify(context)}` : ''}`;
    if (level === 'ERROR') {
      console.error(output);
    } else if (level === 'WARN') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }
}
