import { performance } from 'node:perf_hooks';
import { PRIVATE_BALANCE_POLL_INTERVAL_MS, PRIVATE_READ_RETRY_DELAY_MS, validateBalanceUrl } from './config.js';
import type { BalanceAuthHeaders } from './signing.js';
import { FetchReadOnlyHttpTransport, type ReadOnlyHttpTransport } from './transport.js';
import { PrivateReadError, safeFailure, type Exchange, type PrivateAccountSnapshot } from './types.js';

export interface PrivateReadMetrics {
  privateReadRequests: number; privateReadSuccess: number; privateReadFailures: number;
  privateReadTimeouts: number; privateReadRateLimited: number; lastPrivateReadLatencyMs: number | null;
}
export interface ClientOptions {
  enabled: boolean; url: string; transport?: ReadOnlyHttpTransport;
  now?: () => number; monotonicNow?: () => number; sleep?: (ms: number) => Promise<void>;
}
export class BalanceReadOnlyClient {
  readonly exchange: Exchange;
  #lastPoll = -Infinity;
  #busy = false;
  #stopped = false;
  #metrics: PrivateReadMetrics = { privateReadRequests: 0, privateReadSuccess: 0, privateReadFailures: 0,
    privateReadTimeouts: 0, privateReadRateLimited: 0, lastPrivateReadLatencyMs: null };
  #transport: ReadOnlyHttpTransport;
  #now: () => number;
  #mono: () => number;
  #sleep: (ms: number) => Promise<void>;
  constructor(exchange: Exchange, private readonly options: ClientOptions,
    private readonly sign: (now: number) => BalanceAuthHeaders,
    private readonly parse: (payload: unknown, receivedAt: number) => PrivateAccountSnapshot) {
    validateBalanceUrl(exchange, options.url);
    this.exchange = exchange;
    this.#transport = options.transport ?? new FetchReadOnlyHttpTransport();
    this.#now = options.now ?? Date.now;
    this.#mono = options.monotonicNow ?? (() => performance.now());
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    // Freeze public configuration so later caller mutation cannot enable IO.
    this.options = Object.freeze({ ...options });
  }
  getMetrics(): PrivateReadMetrics { return { ...this.#metrics }; }
  stop(): void { this.#stopped = true; }
  async readBalance(): Promise<PrivateAccountSnapshot> {
    if (!this.options.enabled) throw new PrivateReadError('CONFIG');
    if (this.#stopped) throw new PrivateReadError('STOPPED');
    const start = this.#mono();
    if (this.#busy || start - this.#lastPoll < PRIVATE_BALANCE_POLL_INTERVAL_MS) throw new PrivateReadError('POLL_GUARD');
    this.#lastPoll = start; this.#busy = true;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.#stopped) throw new PrivateReadError('STOPPED');
        const began = this.#mono();
        this.#metrics.privateReadRequests++;
        try {
          const result = await this.#transport.get({ exchange: this.exchange, url: this.options.url, headers: this.sign(this.#now()) });
          const snapshot = this.parse(result.payload, result.receivedAt);
          this.#metrics.privateReadSuccess++;
          return snapshot;
        } catch (error) {
          const failure = safeFailure(error);
          this.#metrics.privateReadFailures++;
          if (failure.category === 'TIMEOUT') this.#metrics.privateReadTimeouts++;
          if (failure.category === 'RATE_LIMIT') this.#metrics.privateReadRateLimited++;
          const transient = ['NETWORK', 'TIMEOUT', 'RATE_LIMIT'].includes(failure.category) ||
            (failure.category === 'HTTP' && failure.status !== null && failure.status >= 500 && failure.status <= 599);
          if (attempt !== 0 || !transient || this.#stopped) throw failure;
        } finally {
          this.#metrics.lastPrivateReadLatencyMs = Math.max(0, this.#mono() - began);
        }
        await this.#sleep(PRIVATE_READ_RETRY_DELAY_MS);
      }
      throw new PrivateReadError('NETWORK');
    } finally { this.#busy = false; }
  }
}
