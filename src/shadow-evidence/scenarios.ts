import { PAPER_EXECUTION_CONFIG } from '../config/paper.js';
import { ShadowExecutionEngine } from '../shadow-execution/shadow-execution-engine.js';
import { prepareShadowTrigger } from '../shadow-execution/prepared-trigger.js';
import type { ShadowExecutionAttempt } from '../shadow-execution/shadow-execution-types.js';
import type { ShadowInput } from '../shadow/shadow-types.js';
import type { OpportunityEvent } from '../scanner/opportunity.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import type { EvidenceManifest, EvidenceRecord } from './types.js';
import { fingerprint } from './manifest.js';
import { EvidenceStatistics } from './statistics.js';

interface Group { id: string; fingerprint: string; cohort: EvidenceRecord['cohort']; remaining: number }
export class EvidenceScenarios {
  private engines: Map<string, ShadowExecutionEngine>;
  private groups = new Map<string, Group>();
  private seen = new Set<string>();
  private readonly stats: EvidenceStatistics;
  private counters = { groups: 0, capacityRejected: 0, detailLimitAborted: 0, diagnosticFailure: 0 };
  private drops: Record<string, Record<string, number>> = {};
  private triggers: Record<string, number> = {};
  private complete = true;
  private stopped = false;
  constructor(readonly manifest: EvidenceManifest, private readonly onRecord: (r: EvidenceRecord) => void,
    options: { maxActive?: number; onBookObserved?: (profile: string, book: NormalizedOrderBook) => void } = {}) {
    this.stats = new EvidenceStatistics(manifest.profiles);
    this.observe = options.onBookObserved;
    this.engines = new Map(manifest.profiles.map(p => [p.id, new ShadowExecutionEngine({ enabled: true,
      maxActive: options.maxActive ?? 100, maxRecent: 1,
      idGenerator: () => p.id,
      config: { ...PAPER_EXECUTION_CONFIG, buyOrderLatencyMs: p.latencyMs, sellOrderLatencyMs: p.latencyMs, unwindOrderLatencyMs: p.latencyMs },
      onTerminal: a => this.terminal(p.id, a) })]));
  }
  private observe: ((profile: string, book: NormalizedOrderBook) => void) | undefined;
  diagnosticFailure() { this.counters.diagnosticFailure++; this.complete = false; }
  trigger(event: OpportunityEvent, inputFactory: () => ShadowInput) {
    if (this.stopped || event.state !== 'QUALIFIED' || this.seen.has(event.id)) return;
    try {
      const input = inputFactory(), prepared = prepareShadowTrigger(event, input);
      // One evaluated immutable context for every profile. No per-profile cache reads.
      const group: Group = { id: fingerprint([this.manifest.runId, event.id]),
        fingerprint: fingerprint(input.instrumentRules ? (['bybit', 'okx'] as const).map(ex => {
          const r = input.instrumentRules?.[ex];
          return r ? [ex, r.priceTick.raw, r.quantityStep.raw, r.minQuantity, r.maxQuantity, r.minNotional, r.maxNotional,
            r.maxNotionalUsd?.raw ?? null, r.instrumentStatus] : null;
        }) : null), remaining: 0,
        cohort: this.manifest.context === 'LIVE_ACCOUNT_CONTEXT' && !prepared.assessment.degraded && prepared.rules.status === 'EXECUTABLE' &&
          prepared.d.fundingStatus === 'FUNDED' && Object.values(prepared.assessment.feeSourceByExchange).every(s => s === 'ACCOUNT_OBSERVED')
          ? 'ACCOUNT_CALIBRATED' : 'MARKET_ONLY' };
      for (const [id, engine] of this.engines) {
        try {
          const result = engine.triggerPrepared(event, prepared);
          if (result.accepted) { group.remaining++; this.triggers[id] = (this.triggers[id] ?? 0) + 1; }
          else {
            const d = this.drops[id] ??= {}; const reason = result.reason ?? 'UNKNOWN'; d[reason] = (d[reason] ?? 0) + 1;
            if (reason === 'SHADOW_CAPACITY_LIMIT') { this.counters.capacityRejected++; this.complete = false; }
            if (reason === 'DUPLICATE_OR_RETIRED_OPPORTUNITY') this.complete = false;
          }
        } catch { this.profileFailure(id); }
      }
      if (group.remaining) {
        this.groups.set(event.id, group); this.counters.groups++; this.seen.add(event.id);
        if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value!);
      }
    } catch { this.diagnosticFailure(); }
  }
  private terminal(id: string, a: ShadowExecutionAttempt) {
    const g = this.groups.get(a.opportunityEventId);
    if (!g || a.closedAt === null || a.outcome === null) { this.diagnosticFailure(); return; }
    const times = [a.buy.firstFillAt, a.sell.firstFillAt].filter((t): t is number => t !== null);
    // Explicit allowlist: never serialize an attempt/account object by spreading it.
    const r: EvidenceRecord = { schemaVersion: 1, runId: this.manifest.runId, evidenceGroupId: g.id, scenarioId: id,
      triggeredAt: a.triggeredAt, closedAt: a.closedAt, direction: a.buyExchange === 'bybit' ? 'BUY_BYBIT_SELL_OKX' : 'BUY_OKX_SELL_BYBIT',
      configuredTarget: a.configuredTargetBtc, ruleAdjustedTarget: a.ruleAdjustedTargetBtc, ruleStatus: a.ruleAssessment.status,
      ruleReasons: [...new Set([...a.ruleAssessment.bybit.reasons, ...a.ruleAssessment.okx.reasons])], ruleFingerprint: g.fingerprint,
      feeSources: { bybit: a.feeSources.bybit, okx: a.feeSources.okx }, feeRates: { bybit: a.feeRates.bybit, okx: a.feeRates.okx },
      fundingStatus: a.fundingAssessment.status, cohort: g.cohort, triggerNetPnl: a.triggerShadowNetPnl,
      finalNetPnl: a.netPnlAfterFees, outcome: a.outcome, entryOutcome: a.entryOutcome, feasibility: a.feasibility,
      buyFillRatio: a.buy.filledBtc / a.targetBtcSize, sellFillRatio: a.sell.filledBtc / a.targetBtcSize,
      firstFillMs: times.length ? Math.min(...times) - a.triggeredAt : null, timeToCompleteMs: a.closedAt - a.triggeredAt,
      unhedgedDurationMs: a.unhedgedDurationMs, buyPriceDriftBps: a.buyPriceDriftBps, sellPriceDriftBps: a.sellPriceDriftBps, residualBtc: a.residualBtc };
    if (a.outcome === 'ABORTED_DETAIL_LIMIT') this.counters.detailLimitAborted++;
    this.stats.add(r); g.remaining--; if (!g.remaining) this.groups.delete(a.opportunityEventId);
    try { this.onRecord(r); } catch { this.diagnosticFailure(); }
  }
  private profileFailure(id: string) {
    this.diagnosticFailure(); const d = this.drops[id] ??= {}; d.DIAGNOSTIC_FAILURE = (d.DIAGNOSTIC_FAILURE ?? 0) + 1;
  }
  onBook(book: NormalizedOrderBook, at: number) {
    if (this.stopped) return;
    for (const [id, e] of this.engines) try { this.observe?.(id, book); e.processOrderBook(book, at); } catch { this.profileFailure(id); }
  }
  tick(at: number) { if (!this.stopped) for (const [id, e] of this.engines) try { e.tick(at); } catch { this.profileFailure(id); } }
  shutdown(at: number) {
    if (this.stopped) return;
    for (const [id, e] of this.engines) try { e.shutdown(at); } catch { this.profileFailure(id); }
    this.stopped = true;
  }
  getHealth() { return { evidenceComplete: this.complete, activeGroups: this.groups.size }; }
  summary() { return { ...this.counters, evidenceComplete: this.complete, triggers: { ...this.triggers }, drops: structuredClone(this.drops),
    activeGroups: this.groups.size, profiles: Object.fromEntries([...this.engines].map(([id, e]) => [id, e.getHealth()])), ...this.stats.summary() }; }
}
