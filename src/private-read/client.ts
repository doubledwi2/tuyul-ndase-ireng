import { performance } from 'node:perf_hooks';
import { balanceKind, pollInterval, PRIVATE_READ_RETRY_DELAY_MS, PRIVATE_REQUEST_GAP_MS, READ_PATHS,
  requestExchange, requestUrl, validateBalanceUrl, type RequestKind } from './config.js';
import type { BalanceAuthHeaders } from './signing.js';
import { FetchReadOnlyHttpTransport, type ReadOnlyHttpTransport } from './transport.js';
import { PrivateReadError, safeFailure, type Exchange, type PrivateAccountSnapshot } from './types.js';
import type { AccountReadResult, ReadResults } from './account-types.js';
import { parseReadResponse } from './account-parsers.js';

export interface PrivateReadMetrics {
  privateReadRequests: number; privateReadSuccess: number; privateReadFailures: number;
  privateReadTimeouts: number; privateReadRateLimited: number; lastPrivateReadLatencyMs: number | null;
}
export interface ReadCache<T = AccountReadResult> {
  snapshot: T | null; lastSuccessAt: number | null; lastError: PrivateReadError | null;
  consecutiveFailures: number; pending: boolean; lastAttemptMonotonic: number;
}
const metrics = (): PrivateReadMetrics => ({ privateReadRequests: 0, privateReadSuccess: 0, privateReadFailures: 0,
  privateReadTimeouts: 0, privateReadRateLimited: 0, lastPrivateReadLatencyMs: null });
export interface ClientOptions {
  enabled: boolean; url: string; transport?: ReadOnlyHttpTransport;
  now?: () => number; monotonicNow?: () => number; sleep?: (ms: number) => Promise<void>;
}
interface Job { kind: RequestKind; resolve: (value: AccountReadResult) => void; reject: (error: PrivateReadError) => void }
export class BalanceReadOnlyClient {
  readonly exchange: Exchange;
  #stopped = false;
  #running = false;
  #queue: Job[] = [];
  #lastRequestEnd = -Infinity;
  #metrics = metrics();
  #byKind = new Map<RequestKind, PrivateReadMetrics>();
  #cache = new Map<RequestKind, ReadCache>();
  #transport: ReadOnlyHttpTransport;
  #now: () => number;
  #mono: () => number;
  #sleep: (ms: number) => Promise<void>;
  constructor(exchange: Exchange, private readonly options: ClientOptions,
    private readonly sign: (kind: RequestKind, now: number) => BalanceAuthHeaders) {
    validateBalanceUrl(exchange, options.url);
    this.exchange = exchange;
    this.#transport = options.transport ?? new FetchReadOnlyHttpTransport();
    this.#now = options.now ?? Date.now;
    this.#mono = options.monotonicNow ?? (() => performance.now());
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.options = Object.freeze({ ...options });
    for (const kind of this.kinds()) {
      this.#byKind.set(kind, metrics());
      this.#cache.set(kind, { snapshot: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0, pending: false, lastAttemptMonotonic: -Infinity });
    }
  }
  kinds(): RequestKind[] { return (Object.keys(READ_PATHS) as RequestKind[]).filter(k => requestExchange(k) === this.exchange); }
  getMetrics() { return { ...this.#metrics, byKind: Object.fromEntries([...this.#byKind].map(([k, v]) => [k, { ...v }])) }; }
  cache<K extends RequestKind>(kind: K): ReadCache<ReadResults[K]> {
    const state = this.#cache.get(kind); if (!state) throw new PrivateReadError('CONFIG');
    return { ...state, snapshot: structuredClone(state.snapshot), lastError: state.lastError ? safeFailure(state.lastError) : null } as ReadCache<ReadResults[K]>;
  }
  due(kind: RequestKind): boolean {
    const state = this.#cache.get(kind);
    return !!state && !state.pending && this.#mono() - state.lastAttemptMonotonic >= pollInterval(kind);
  }
  stop(): void {
    this.#stopped = true;
    for (const job of this.#queue.splice(0)) {
      this.#cache.get(job.kind)!.pending = false; job.reject(new PrivateReadError('STOPPED'));
    }
  }
  async readBalance(): Promise<PrivateAccountSnapshot> {
    return this.exchange === 'bybit' ? this.read('BYBIT_BALANCE') : this.read('OKX_BALANCE');
  }
  read<K extends RequestKind>(kind: K): Promise<ReadResults[K]> {
    if (!this.options.enabled) return Promise.reject(new PrivateReadError('CONFIG'));
    if (this.#stopped) return Promise.reject(new PrivateReadError('STOPPED'));
    if (requestExchange(kind) !== this.exchange) return Promise.reject(new PrivateReadError('CONFIG'));
    if (!this.due(kind)) return Promise.reject(new PrivateReadError('POLL_GUARD'));
    this.#cache.get(kind)!.pending = true;
    return new Promise<AccountReadResult>((resolve, reject) => {
      this.#queue.push({ kind, resolve, reject });
      void this.pump();
    }) as Promise<ReadResults[K]>;
  }
  private async pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length && !this.#stopped) {
        // Balance outranks queued diagnostics; FIFO within diagnostic priority.
        const priority = this.#queue.findIndex(j => j.kind === balanceKind(this.exchange));
        const job = this.#queue.splice(priority < 0 ? 0 : priority, 1)[0]!;
        const state = this.#cache.get(job.kind)!;
        try {
          const wait = PRIVATE_REQUEST_GAP_MS - (this.#mono() - this.#lastRequestEnd);
          if (wait > 0) await this.#sleep(wait);
          if (this.#stopped) throw new PrivateReadError('STOPPED');
          state.lastAttemptMonotonic = this.#mono();
          const result = await this.perform(job.kind);
          state.snapshot = result.snapshot; state.lastSuccessAt = result.receivedAt;
          state.lastError = null; state.consecutiveFailures = 0;
          job.resolve(structuredClone(result.snapshot));
        } catch (error) {
          const failure = safeFailure(error);
          if (failure.category !== 'STOPPED') { state.lastError = failure; state.consecutiveFailures++; }
          job.reject(failure);
        } finally { state.pending = false; this.#lastRequestEnd = this.#mono(); }
      }
    } finally { this.#running = false; }
  }
  private async perform(kind: RequestKind) {
    const counters = [this.#metrics, this.#byKind.get(kind)!];
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.#stopped) throw new PrivateReadError('STOPPED');
      const began = this.#mono();
      counters.forEach(m => m.privateReadRequests++);
      try {
        const result = await this.#transport.get({ exchange: this.exchange, kind,
          url: requestUrl(kind, this.options.url), headers: this.sign(kind, this.#now()) });
        const snapshot = parseReadResponse(kind, result.payload, result.receivedAt);
        counters.forEach(m => m.privateReadSuccess++);
        return { snapshot, receivedAt: result.receivedAt };
      } catch (error) {
        const failure = safeFailure(error);
        counters.forEach(m => {
          m.privateReadFailures++;
          if (failure.category === 'TIMEOUT') m.privateReadTimeouts++;
          if (failure.category === 'RATE_LIMIT') m.privateReadRateLimited++;
        });
        const transient = ['NETWORK', 'TIMEOUT', 'RATE_LIMIT'].includes(failure.category) ||
          (failure.category === 'HTTP' && failure.status !== null && failure.status >= 500 && failure.status <= 599);
        if (attempt !== 0 || !transient || this.#stopped) throw failure;
      } finally { counters.forEach(m => { m.lastPrivateReadLatencyMs = Math.max(0, this.#mono() - began); }); }
      await this.#sleep(PRIVATE_READ_RETRY_DELAY_MS);
    }
    throw new PrivateReadError('NETWORK');
  }
}
