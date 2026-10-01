import type { BalanceReadOnlyClient } from './client.js';
import { balanceKind, MAX_BALANCE_AGE_MS, MAX_DIAGNOSTIC_AGE_MS, type RequestKind } from './config.js';
import { safeFailure, type Exchange, type PrivateReadError, type RealInventorySnapshot } from './types.js';
import type { AccountCompatibilityAssessment, AccountFeeSnapshot, CredentialSafetyAssessment } from './account-types.js';
import { assessBybitCompatibility, assessOkxCompatibility, feeDiagnostic, unknownCredential } from './assessment.js';
import type { AccountReconciliation } from './inventory.js';

export interface PrivateAccountSafetySummary {
  bybitCredentialSafety: CredentialSafetyAssessment; okxCredentialSafety: CredentialSafetyAssessment;
  bybitAccountCompatibility: AccountCompatibilityAssessment; okxAccountCompatibility: AccountCompatibilityAssessment;
  bybitFeeSnapshot: AccountFeeSnapshot | null; okxFeeSnapshot: AccountFeeSnapshot | null;
  reconciliation: AccountReconciliation[];
  overall: 'SAFE_FOR_READ_ONLY_OBSERVATION' | 'REVIEW_REQUIRED' | 'UNKNOWN';
  readOnlyObservationSafe: boolean;
}
export class PrivateAccountCollector {
  #timer: ReturnType<typeof setInterval> | undefined;
  #pending = new Set<Promise<void>>();
  #stopped = false;
  #started = false;
  #warned = new Map<string, string>();
  constructor(readonly enabled: boolean, private readonly clients: readonly BalanceReadOnlyClient[],
    private readonly warn: (exchange: Exchange, error: PrivateReadError, kind?: RequestKind) => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly warnDiagnostic: (exchange: Exchange, category: string) => void = () => {}) {}
  private client(exchange: Exchange) { return this.clients.find(c => c.exchange === exchange); }
  getInventory(): RealInventorySnapshot {
    const bybit = this.client('bybit')?.cache('BYBIT_BALANCE').snapshot;
    const okx = this.client('okx')?.cache('OKX_BALANCE').snapshot;
    return { ...(bybit ? { bybit } : {}), ...(okx ? { okx } : {}) };
  }
  private freshness(exchange: Exchange, kind: RequestKind) {
    const cache = this.client(exchange)?.cache(kind);
    const ageMs = cache?.lastSuccessAt == null ? null : this.now() - cache.lastSuccessAt;
    const fresh = this.enabled && !this.#stopped && ageMs !== null && ageMs >= 0 &&
      ageMs <= (kind.endsWith('BALANCE') ? MAX_BALANCE_AGE_MS : MAX_DIAGNOSTIC_AGE_MS);
    return { fresh, healthy: fresh && cache?.lastError === null,
      lastSuccessAt: cache?.lastSuccessAt ?? null, ageMs,
      degraded: (cache?.consecutiveFailures ?? 0) > 0,
      consecutiveFailures: cache?.consecutiveFailures ?? 0,
      lastErrorCategory: cache?.lastError?.category ?? null };
  }
  getDiagnosticHealth(exchange: Exchange) {
    const balance = this.freshness(exchange, balanceKind(exchange));
    const fee = this.freshness(exchange, exchange === 'bybit' ? 'BYBIT_FEE_RATE' : 'OKX_TRADE_FEE');
    const config = this.freshness(exchange, exchange === 'bybit' ? 'BYBIT_ACCOUNT_INFO' : 'OKX_ACCOUNT_CONFIG');
    const permissions = this.freshness(exchange, exchange === 'bybit' ? 'BYBIT_API_KEY_INFO' : 'OKX_ACCOUNT_CONFIG');
    return { balance, fee, config, permissions, lastBalanceSuccessAt: balance.lastSuccessAt,
      lastFeeSuccessAt: fee.lastSuccessAt, lastConfigSuccessAt: config.lastSuccessAt,
      lastPermissionSuccessAt: permissions.lastSuccessAt,
      balanceFresh: balance.fresh, feeFresh: fee.fresh, configFresh: config.fresh, permissionFresh: permissions.fresh };
  }
  getSafetySummary(reconciliation: AccountReconciliation[] = []): PrivateAccountSafetySummary {
    const bybit = this.client('bybit'), okx = this.client('okx');
    const b = this.getDiagnosticHealth('bybit'), o = this.getDiagnosticHealth('okx');
    const bybitCredentialSafety = b.permissions.healthy ? bybit?.cache('BYBIT_API_KEY_INFO').snapshot?.assessment ?? unknownCredential('bybit') : unknownCredential('bybit');
    const okxCredentialSafety = o.permissions.healthy ? okx?.cache('OKX_ACCOUNT_CONFIG').snapshot?.safety.assessment ?? unknownCredential('okx') : unknownCredential('okx');
    const bybitAccountCompatibility = assessBybitCompatibility(b.config.healthy ? bybit?.cache('BYBIT_ACCOUNT_INFO').snapshot ?? null : null);
    const okxAccountCompatibility = assessOkxCompatibility(o.config.healthy ? okx?.cache('OKX_ACCOUNT_CONFIG').snapshot?.config ?? null : null);
    const bybitFeeSnapshot = bybit?.cache('BYBIT_FEE_RATE').snapshot ?? null;
    const okxFeeSnapshot = okx?.cache('OKX_TRADE_FEE').snapshot ?? null;
    const fees = feeDiagnostic(b.fee.healthy ? bybitFeeSnapshot : null, o.fee.healthy ? okxFeeSnapshot : null);
    const unsafe = [bybitCredentialSafety, okxCredentialSafety].some(a => a.status === 'UNSAFE_WRITE_ENABLED') ||
      [bybitAccountCompatibility, okxAccountCompatibility].some(a => a.status === 'INCOMPATIBLE') || !!fees.bybitWarning || !!fees.okxWarning;
    const unknown = [bybitCredentialSafety, okxCredentialSafety].some(a => a.status === 'UNKNOWN') ||
      [bybitAccountCompatibility, okxAccountCompatibility].some(a => a.status === 'UNKNOWN') ||
      [b, o].some(h => !h.balance.healthy || !h.fee.healthy || !h.config.healthy || !h.permissions.healthy);
    const overall = unsafe ? 'REVIEW_REQUIRED' : unknown ? 'UNKNOWN' : 'SAFE_FOR_READ_ONLY_OBSERVATION';
    return { bybitCredentialSafety, okxCredentialSafety, bybitAccountCompatibility, okxAccountCompatibility,
      bybitFeeSnapshot, okxFeeSnapshot, reconciliation, overall, readOnlyObservationSafe: overall === 'SAFE_FOR_READ_ONLY_OBSERVATION' };
  }
  getFeeDiagnostic() {
    const summary = this.getSafetySummary();
    return feeDiagnostic(this.getDiagnosticHealth('bybit').fee.healthy ? summary.bybitFeeSnapshot : null,
      this.getDiagnosticHealth('okx').fee.healthy ? summary.okxFeeSnapshot : null);
  }
  getHealth() {
    const b = this.getDiagnosticHealth('bybit'), o = this.getDiagnosticHealth('okx'), safety = this.getSafetySummary();
    return { enabled: this.enabled, bybitConfigured: !!this.client('bybit'), okxConfigured: !!this.client('okx'),
      bybitHealthy: b.balance.healthy, okxHealthy: o.balance.healthy,
      lastBybitSuccessAt: b.lastBalanceSuccessAt, lastOkxSuccessAt: o.lastBalanceSuccessAt,
      bybitDegraded: b.balance.consecutiveFailures >= 5, okxDegraded: o.balance.consecutiveFailures >= 5,
      diagnosticReady: safety.readOnlyObservationSafe, readOnlyObservationSafe: safety.readOnlyObservationSafe,
      overall: safety.overall,
      bybit: { ...b, credentialSafety: safety.bybitCredentialSafety, accountCompatibility: safety.bybitAccountCompatibility },
      okx: { ...o, credentialSafety: safety.okxCredentialSafety, accountCompatibility: safety.okxAccountCompatibility } };
  }
  getMetrics() { return Object.fromEntries(this.clients.map(client => [client.exchange, {
    ...client.getMetrics(), freshness: this.getDiagnosticHealth(client.exchange),
  }])); }
  private diagnosticsChanged(): void {
    const s = this.getSafetySummary(), f = this.getFeeDiagnostic();
    for (const exchange of ['bybit', 'okx'] as const) {
      const credential = exchange === 'bybit' ? s.bybitCredentialSafety : s.okxCredentialSafety;
      const warning = exchange === 'bybit' ? f.bybitWarning : f.okxWarning;
      for (const [kind, value] of [['credential', credential.status], ['fee', warning ?? 'NONE']] as const) {
        const key = exchange + kind;
        if (this.#warned.get(key) === value) continue;
        this.#warned.set(key, value);
        if (value === 'UNSAFE_WRITE_ENABLED' || value === 'FEE_MODEL_MISMATCH') {
          try { this.warnDiagnostic(exchange, value); } catch { /* Isolate diagnostic logging. */ }
        }
      }
    }
  }
  pollOnce(): Promise<void> {
    if (!this.enabled || this.#stopped) return Promise.resolve();
    for (const client of this.clients) {
      // Queue balance first; all kinds share the client's serial scheduler.
      const kinds = [balanceKind(client.exchange), ...client.kinds().filter(k => k !== balanceKind(client.exchange))];
      for (const kind of kinds) {
        if (!client.due(kind)) continue;
        const pending = client.read(kind).then(() => {}, error => {
          const failure = safeFailure(error);
          const count = client.cache(kind).consecutiveFailures;
          if (count === 1 || count === 5) {
            try { this.warn(client.exchange, failure, kind); } catch { /* Isolate logger. */ }
          }
        }).finally(() => { this.#pending.delete(pending); this.diagnosticsChanged(); });
        this.#pending.add(pending);
      }
    }
    return Promise.all([...this.#pending]).then(() => {});
  }
  start(): void {
    if (!this.enabled || this.#started || this.#stopped) return;
    this.#started = true; void this.pollOnce();
    // This tick only enqueues due work; it never bypasses per-kind cadence.
    this.#timer = setInterval(() => { void this.pollOnce(); }, 1000);
  }
  async stop(): Promise<void> {
    this.#stopped = true; clearInterval(this.#timer);
    for (const client of this.clients) client.stop();
    await Promise.all([...this.#pending]);
  }
}
