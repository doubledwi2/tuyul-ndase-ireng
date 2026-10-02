import { TIMING_CONFIG } from '../config/timing.js';
import { RuleCalibrationMetrics } from '../instrument-rules/metrics.js';
import { freshAt, evaluateShadow } from './shadow-evaluator.js';
import { ShadowMetrics } from './shadow-metrics.js';
import type { ShadowAssessment, ShadowInput } from './shadow-types.js';

export class ShadowRuntime {
  private readonly metrics = new ShadowMetrics();
  private readonly ruleMetrics = new RuleCalibrationMetrics();
  private latest: ShadowAssessment | null = null;
  constructor(readonly enabled: boolean) {}
  evaluate(input: ShadowInput): ShadowAssessment | null {
    if (!this.enabled) return null;
    const assessment = evaluateShadow(input);
    this.metrics.record(assessment);
    for (const d of assessment.directions) this.ruleMetrics.record(d.ruleAssessment, d.shadowNetPnl, d.ruleCalibratedNetPnl);
    // Only derived values retained, never private snapshots.
    this.latest = structuredClone(assessment);
    return assessment;
  }
  getMetrics() { return { ...this.metrics.summary(), ruleCalibration: this.ruleMetrics.summary() }; }
  getHealth(now: number) {
    const a = this.latest;
    const recent = !!a && freshAt(a.evaluatedAt, now, TIMING_CONFIG.maxBookAgeMs);
    return { enabled: this.enabled,
      status: !this.enabled ? 'DISABLED' : !a ? 'WARMING_UP' : a.degraded || !recent ? 'DEGRADED' : 'ACTIVE',
      ruleCalibrationStatus: a?.directions.map(d => d.ruleAssessment.status) ?? [],
      lastEvaluationAt: a?.evaluatedAt ?? null,
      lastFeeFresh: a ? a.freshness.bybit.fee && a.freshness.okx.fee : false,
      lastBalanceFresh: a ? a.freshness.bybit.balance && a.freshness.okx.balance : false };
  }
}
