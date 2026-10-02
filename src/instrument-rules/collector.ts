import { instrumentRulesConfig } from './config.js';
import { fetchInstrumentRules, publicTransport, type PublicTransport } from './client.js';
import { RuleError } from './parsers.js';
import { rulesFresh } from './validator.js';
import type { Exchange, InstrumentRules, RuleSnapshots } from './types.js';
interface Cache { snapshot: InstrumentRules | null; lastSuccessAt: number | null; lastError: { category: string; status: number | null } | null; consecutiveFailures: number }
export class InstrumentRulesCollector {
  private readonly cache: Record<Exchange, Cache> = {
    bybit: { snapshot: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0 },
    okx: { snapshot: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0 },
  };
  private readonly counts = { requests: 0, successes: 0, failures: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;
  private stopped = false;
  constructor(readonly config = instrumentRulesConfig(), private readonly transport: PublicTransport = publicTransport,
    private readonly now = Date.now, private readonly warn: (exchange: Exchange, error: { category: string; status: number | null }) => void = () => {}) {}
  start() {
    if (!this.config.enabled || this.timer || this.stopped) return;
    void this.pollOnce(); this.timer = setInterval(() => { void this.pollOnce(); }, this.config.pollIntervalMs);
  }
  pollOnce(): Promise<void> {
    if (!this.config.enabled || this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = Promise.all((['bybit', 'okx'] as const).map(ex => this.refresh(ex))).then(() => {}).finally(() => { this.pending = null; });
    return this.pending;
  }
  private async refresh(ex: Exchange) {
    for (let attempt = 0; attempt < 2 && !this.stopped; attempt++) {
      this.counts.requests++;
      try {
        const snapshot = await fetchInstrumentRules(ex, this.transport, this.now);
        this.counts.successes++;
        this.cache[ex] = { snapshot, lastSuccessAt: snapshot.receivedAt, lastError: null, consecutiveFailures: 0 }; return;
      } catch (error) {
        const safe = error instanceof RuleError ? error : new RuleError('NETWORK');
        this.counts.failures++;
        const c = this.cache[ex]; c.lastError = { category: safe.category, status: safe.status }; c.consecutiveFailures++;
        try { this.warn(ex, c.lastError); } catch { /* Diagnostics must not stop feeds. */ }
        if (!safe.transient || attempt === 1 || this.stopped) return;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }
  getSnapshots(): RuleSnapshots { return structuredClone({ bybit: this.cache.bybit.snapshot, okx: this.cache.okx.snapshot }); }
  getHealth(at = this.now()) {
    const venue = (ex: Exchange) => ({ fresh: rulesFresh(this.cache[ex].snapshot, at),
      status: rulesFresh(this.cache[ex].snapshot, at) ? this.cache[ex].snapshot!.instrumentStatus : 'UNKNOWN',
      lastSuccessAt: this.cache[ex].lastSuccessAt, lastError: this.cache[ex].lastError,
      consecutiveFailures: this.cache[ex].consecutiveFailures });
    const bybit = venue('bybit'), okx = venue('okx');
    return { enabled: this.config.enabled, bybitFresh: bybit.fresh, okxFresh: okx.fresh, bybitStatus: bybit.status, okxStatus: okx.status,
      lastSuccessAt: { bybit: bybit.lastSuccessAt, okx: okx.lastSuccessAt }, bybit, okx };
  }
  getMetrics(at = this.now()) { return { ...this.counts, staleVenues: Object.values(this.cache).filter(c => !rulesFresh(c.snapshot, at)).length }; }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; await this.pending; }
}
