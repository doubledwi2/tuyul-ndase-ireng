import type { CrossVenueRuleAssessment } from './types.js';
export class RuleCalibrationMetrics {
  private counts = { ruleAssessments: 0, ruleExecutable: 0, ruleInvalid: 0, ruleUnknown: 0,
    belowMinQuantity: 0, aboveMaxQuantity: 0, belowMinNotional: 0, notTradable: 0, stepMismatch: 0, ruleStale: 0,
    preRulePositivePostRuleNegative: 0, preRuleNegativePostRulePositive: 0 };
  private samples: { targetAdjustmentBtc: number | null; targetAdjustmentPercent: number | null; preRuleNetPnl: number | null; postRuleNetPnl: number | null }[] = [];
  record(a: CrossVenueRuleAssessment, pre: number | null, post: number | null) {
    this.counts.ruleAssessments++;
    if (a.status === 'EXECUTABLE') this.counts.ruleExecutable++;
    else if (a.status === 'UNKNOWN') this.counts.ruleUnknown++;
    else this.counts.ruleInvalid++;
    const reasons = new Set([...a.bybit.reasons, ...a.okx.reasons]);
    const mapping = { belowMinQuantity: 'BELOW_MIN_QUANTITY', aboveMaxQuantity: 'ABOVE_MAX_QUANTITY', belowMinNotional: 'BELOW_MIN_NOTIONAL',
      notTradable: 'NOT_TRADABLE', stepMismatch: 'STEP_MISMATCH', ruleStale: 'RULE_STALE' } as const;
    for (const key of Object.keys(mapping) as (keyof typeof mapping)[]) if (reasons.has(mapping[key])) this.counts[key]++;
    if (pre !== null && post !== null) {
      if (pre > 0 && post < 0) this.counts.preRulePositivePostRuleNegative++;
      if (pre < 0 && post > 0) this.counts.preRuleNegativePostRulePositive++;
    }
    const reduction = a.commonQuantity !== null && a.targetQuantity > 0 ? a.targetQuantity - a.commonQuantity : null;
    this.samples.push({ targetAdjustmentBtc: reduction, targetAdjustmentPercent: reduction === null ? null : reduction / a.targetQuantity * 100,
      preRuleNetPnl: pre !== null && Number.isFinite(pre) ? pre : null, postRuleNetPnl: post !== null && Number.isFinite(post) ? post : null });
    if (this.samples.length > 2048) this.samples.shift();
  }
  summary() {
    const average = (key: keyof RuleCalibrationMetrics['samples'][number]) => {
      const values = this.samples.map(s => s[key]).filter((v): v is number => v !== null && Number.isFinite(v));
      return { count: values.length, average: values.length ? values.reduce((sum, n) => sum + n / values.length, 0) : null };
    };
    return { ...this.counts, windowLimit: 2048, targetAdjustmentBtc: average('targetAdjustmentBtc'),
      targetAdjustmentPercent: average('targetAdjustmentPercent'), preRuleNetPnl: average('preRuleNetPnl'), postRuleNetPnl: average('postRuleNetPnl') };
  }
}
