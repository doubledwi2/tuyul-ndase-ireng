import type { EvidenceRecord, EvidenceManifest } from './types.js';
export const WARNINGS = ['Hypothetical fills; no queue position; no real order acknowledgements.',
  'Modeled latency, not measured latency. Concurrent attempts independently see liquidity.',
  'Private funding may be unknown. Past observed books do not guarantee future fills.',
  'Observed shadow survival rate is not a probability of real fill. Quantiles use the latest 2048 samples per bucket.'];
class Bucket {
  attempts = 0; clean = 0; partial = 0; oneLeg = 0; noFill = 0; unwindSuccess = 0; unwindFailure = 0; timeouts = 0;
  positive = 0; negative = 0; detailLimitAborted = 0; aborted = 0;
  private pnl: number[] = []; private fill: number[] = []; private timing: number[] = [];
  add(r: EvidenceRecord) {
    this.attempts++; this.clean += +(r.outcome === 'CLEAN_FILL'); this.partial += +(r.entryOutcome === 'PARTIAL_BOTH');
    this.oneLeg += +['BUY_ONLY', 'SELL_ONLY'].includes(r.entryOutcome ?? ''); this.noFill += +(r.entryOutcome === 'NO_FILL');
    this.unwindSuccess += +(r.outcome === 'UNWOUND'); this.unwindFailure += +(r.outcome === 'UNWIND_FAILED');
    this.timeouts += +(r.outcome === 'TIMED_OUT'); this.detailLimitAborted += +(r.outcome === 'ABORTED_DETAIL_LIMIT');
    this.aborted += +r.outcome.startsWith('ABORTED_');
    if (closedEconomics(r)) { this.positive += +(r.finalNetPnl! > 0); this.negative += +(r.finalNetPnl! < 0); this.sample(this.pnl, r.finalNetPnl!); }
    this.sample(this.fill, Math.min(r.buyFillRatio, r.sellFillRatio)); this.sample(this.timing, r.timeToCompleteMs);
  }
  private sample(values: number[], n: number) { values.push(n); if (values.length > 2048) values.shift(); }
  summary() {
    const dist = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return { samples: a.length,
      median: a[Math.max(0, Math.ceil(a.length * .5) - 1)] ?? null, P95: a[Math.max(0, Math.ceil(a.length * .95) - 1)] ?? null }; };
    return { attempts: this.attempts, cleanFills: this.clean, partial: this.partial, oneLeg: this.oneLeg, noFill: this.noFill,
      unwindSuccess: this.unwindSuccess, unwindFailure: this.unwindFailure, timeouts: this.timeouts, positiveFinal: this.positive, negativeFinal: this.negative,
      detailLimitAborted: this.detailLimitAborted, aborted: this.aborted,
      cleanFillRate: this.clean / (this.attempts || 1), positiveFinalRate: this.positive / (this.attempts || 1),
      noFillRate: this.noFill / (this.attempts || 1), oneLegRate: this.oneLeg / (this.attempts || 1),
      medianNetPnl: dist(this.pnl).median, P95NetPnl: dist(this.pnl).P95, pnl: dist(this.pnl), fillRatio: dist(this.fill), timing: dist(this.timing) };
  }
}
const closedEconomics = (r: EvidenceRecord) => r.finalNetPnl !== null && r.residualBtc === 0 && !r.outcome.startsWith('ABORTED_');
export class EvidenceStatistics {
  private buckets = new Map<string, Bucket>();
  private groups = new Map<string, Map<string, EvidenceRecord>>();
  private completeGroups = 0; private incompleteGroupEvictions = 0;
  private survival: Record<string, { positive: number; clean: number }> = {};
  private decay: Record<string, { paired: number; positiveToNegative: number; cleanToNoFill: number; cleanToOneLegOrUnwind: number }> = {};
  constructor(private readonly profiles: EvidenceManifest['profiles']) {}
  add(r: EvidenceRecord) {
    const fee = Object.values(r.feeSources).every(v => v === 'ACCOUNT_OBSERVED') ? 'ACCOUNT_OBSERVED' :
      Object.values(r.feeSources).every(v => v === 'SIMULATION_FALLBACK') ? 'SIMULATION_FALLBACK' : 'MIXED';
    const dimensions = [`direction:${r.direction}`, `cohort:${r.cohort}`, `rules:${r.ruleStatus}`, `fee:${fee}`, `funding:${r.fundingStatus}`];
    for (const key of ['aggregate', `profile:${r.scenarioId}`, ...dimensions, ...dimensions.map(d => `${d}:profile:${r.scenarioId}`)]) {
      const b = this.buckets.get(key) ?? new Bucket(); b.add(r); this.buckets.set(key, b);
    }
    let group = this.groups.get(r.evidenceGroupId);
    if (!group) { group = new Map(); this.groups.set(r.evidenceGroupId, group); }
    group.set(r.scenarioId, r);
    if (group.size === this.profiles.length) {
      this.completeGroups++;
      for (let i = 0; i < this.profiles.length; i++) {
        const p = this.profiles[i]!, a = group.get(p.id)!;
        for (const key of [p.id, `${a.direction}:${p.id}`]) {
          const s = this.survival[key] ??= { positive: 0, clean: 0 };
          s.positive += +(closedEconomics(a) && a.finalNetPnl! > 0); s.clean += +(a.outcome === 'CLEAN_FILL');
        }
        const next = this.profiles[i + 1]; if (!next) continue;
        const b = group.get(next.id)!;
        for (const key of [`${p.id}->${next.id}`, `${a.direction}:${p.id}->${next.id}`]) {
          const d = this.decay[key] ??= { paired: 0, positiveToNegative: 0, cleanToNoFill: 0, cleanToOneLegOrUnwind: 0 };
          d.paired++; d.positiveToNegative += +(closedEconomics(a) && closedEconomics(b) && a.finalNetPnl! > 0 && b.finalNetPnl! < 0);
          d.cleanToNoFill += +(a.outcome === 'CLEAN_FILL' && b.entryOutcome === 'NO_FILL');
          d.cleanToOneLegOrUnwind += +(a.outcome === 'CLEAN_FILL' && (['BUY_ONLY', 'SELL_ONLY'].includes(b.entryOutcome ?? '') || ['UNWOUND', 'UNWIND_FAILED'].includes(b.outcome)));
        }
      }
      this.groups.delete(r.evidenceGroupId);
    }
    if (this.groups.size > 1000) { this.groups.delete(this.groups.keys().next().value!); this.incompleteGroupEvictions++; }
  }
  summary() {
    return { completeGroups: this.completeGroups, incompleteGroups: this.groups.size, incompleteGroupEvictions: this.incompleteGroupEvictions,
      scenarioTable: this.profiles.map(p => ({ ...p, ...(this.buckets.get(`profile:${p.id}`) ?? new Bucket()).summary() })),
      splits: Object.fromEntries([...this.buckets].map(([k, b]) => [k, b.summary()])),
      crossProfileSurvival: structuredClone(this.survival), latencyDecay: structuredClone(this.decay), caveats: WARNINGS };
  }
}
