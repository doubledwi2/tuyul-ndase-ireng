import type { BalanceReadOnlyClient } from './client.js';
import { PRIVATE_BALANCE_POLL_INTERVAL_MS } from './config.js';
import { safeFailure, type Exchange, type PrivateReadError, type RealInventorySnapshot } from './types.js';

interface State { lastSuccessAt: number | null; lastError: PrivateReadError | null; consecutiveFailures: number }
export class PrivateAccountCollector {
  #snapshots: RealInventorySnapshot = {};
  #states: Record<Exchange, State> = {
    bybit: { lastSuccessAt: null, lastError: null, consecutiveFailures: 0 },
    okx: { lastSuccessAt: null, lastError: null, consecutiveFailures: 0 },
  };
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending: Promise<void> | null = null;
  #stopped = false;
  #started = false;
  constructor(readonly enabled: boolean, private readonly clients: readonly BalanceReadOnlyClient[],
    private readonly warn: (exchange: Exchange, error: PrivateReadError) => void = () => {},
    private readonly now: () => number = Date.now) {}
  getInventory(): RealInventorySnapshot { return structuredClone(this.#snapshots); }
  getHealth() {
    const healthy = (exchange: Exchange) => {
      const state = this.#states[exchange];
      return this.enabled && !this.#stopped && state.lastError === null && state.lastSuccessAt !== null &&
        this.now() - state.lastSuccessAt <= 2 * PRIVATE_BALANCE_POLL_INTERVAL_MS;
    };
    return { enabled: this.enabled,
      bybitConfigured: this.clients.some(c => c.exchange === 'bybit'), okxConfigured: this.clients.some(c => c.exchange === 'okx'),
      bybitHealthy: healthy('bybit'), okxHealthy: healthy('okx'),
      lastBybitSuccessAt: this.#states.bybit.lastSuccessAt, lastOkxSuccessAt: this.#states.okx.lastSuccessAt,
      diagnosticReady: healthy('bybit') && healthy('okx'),
      bybitDegraded: this.#states.bybit.consecutiveFailures >= 5, okxDegraded: this.#states.okx.consecutiveFailures >= 5,
    };
  }
  getMetrics() { return Object.fromEntries(this.clients.map(client => [client.exchange, {
    ...client.getMetrics(), consecutiveFailures: this.#states[client.exchange].consecutiveFailures,
    lastErrorCategory: this.#states[client.exchange].lastError?.category ?? null,
  }])); }
  pollOnce(): Promise<void> {
    if (!this.enabled || this.#stopped) return Promise.resolve();
    if (this.#pending) return this.#pending;
    this.#pending = Promise.all(this.clients.map(async client => {
      const state = this.#states[client.exchange];
      try {
        const snapshot = await client.readBalance();
        this.#snapshots = { ...this.#snapshots, [client.exchange]: snapshot };
        state.lastSuccessAt = snapshot.receivedAt; state.lastError = null; state.consecutiveFailures = 0;
      } catch (error) {
        const failure = safeFailure(error);
        if (failure.category === 'POLL_GUARD' || failure.category === 'STOPPED') return;
        state.lastError = failure; state.consecutiveFailures++;
        if (state.consecutiveFailures === 1 || state.consecutiveFailures === 5) {
          try { this.warn(client.exchange, failure); } catch { /* Logging cannot break isolation. */ }
        }
      }
    })).then(() => {}).finally(() => { this.#pending = null; });
    return this.#pending;
  }
  start(): void {
    if (!this.enabled || this.#started || this.#stopped) return;
    this.#started = true;
    const tick = async () => {
      await this.pollOnce();
      if (!this.#stopped) this.#timer = setTimeout(() => { void tick(); }, PRIVATE_BALANCE_POLL_INTERVAL_MS);
    };
    void tick();
  }
  async stop(): Promise<void> {
    this.#stopped = true; clearTimeout(this.#timer);
    for (const client of this.clients) client.stop();
    // In-flight production reads have a bounded timeout; no retry after stop.
    await this.#pending;
  }
}
