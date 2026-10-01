import type { ShadowAssessment } from './shadow-types.js';

export const SHADOW_METRICS_WINDOW = 2048;
function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return { count: values.length, avg: values.length ? values.reduce((sum, n) => sum + n / values.length, 0) : null,
    P50: percentile(0.5), P95: percentile(0.95), P99: percentile(0.99), max: sorted.at(-1) ?? null };
}
export class ShadowMetrics {
  private readonly counts = { shadowEvaluations: 0, shadowEconomicPositive: 0, shadowEconomicNegative: 0, shadowUncertain: 0,
    fundedBothDirections: 0, fundingInsufficient: 0, fundingUnknown: 0, feeObservedBoth: 0, feeFallbackCount: 0,
    credentialReviewCount: 0, compatibilityUnknownCount: 0, baselinePositiveShadowNegative: 0, baselineNegativeShadowPositive: 0 };
  private readonly pnl: number[] = [];
  private readonly impact: number[] = [];
  record(a: ShadowAssessment): void {
    this.counts.shadowEvaluations++;
    if (a.directions.every(d => d.fundingStatus === 'FUNDED')) this.counts.fundedBothDirections++;
    if (a.directions.some(d => d.fundingReasons.includes('INSUFFICIENT_FUNDS'))) this.counts.fundingInsufficient++;
    if (a.directions.some(d => d.fundingReasons.some(r => r !== 'INSUFFICIENT_FUNDS'))) this.counts.fundingUnknown++;
    if (Object.values(a.feeSourceByExchange).every(s => s === 'ACCOUNT_OBSERVED')) this.counts.feeObservedBoth++;
    else this.counts.feeFallbackCount++;
    if (a.reasons.includes('CREDENTIAL_PERMISSION_REVIEW_REQUIRED')) this.counts.credentialReviewCount++;
    if (a.reasons.includes('ACCOUNT_COMPATIBILITY_UNKNOWN')) this.counts.compatibilityUnknownCount++;
    for (const d of a.directions) {
      if (d.economicsStatus === 'SHADOW_POSITIVE') this.counts.shadowEconomicPositive++;
      else if (d.economicsStatus === 'SHADOW_ZERO_OR_NEGATIVE') this.counts.shadowEconomicNegative++;
      else this.counts.shadowUncertain++;
      if (d.shadowNetPnl !== null && Number.isFinite(d.shadowNetPnl)) this.pnl.push(d.shadowNetPnl);
      if (d.feeImpactUsdt !== null && Number.isFinite(d.feeImpactUsdt)) this.impact.push(d.feeImpactUsdt);
      if (d.economicsStatus !== 'SHADOW_UNCERTAIN' && d.baselineNetPnl !== null && d.shadowNetPnl !== null) {
        if (d.baselineNetPnl > 0 && d.shadowNetPnl < 0) this.counts.baselinePositiveShadowNegative++;
        if (d.baselineNetPnl < 0 && d.shadowNetPnl > 0) this.counts.baselineNegativeShadowPositive++;
      }
    }
    if (this.pnl.length > SHADOW_METRICS_WINDOW) this.pnl.splice(0, this.pnl.length - SHADOW_METRICS_WINDOW);
    if (this.impact.length > SHADOW_METRICS_WINDOW) this.impact.splice(0, this.impact.length - SHADOW_METRICS_WINDOW);
  }
  summary() { return { ...this.counts, windowLimit: SHADOW_METRICS_WINDOW, shadowNetPnl: distribution(this.pnl), feeImpactUsdt: distribution(this.impact) }; }
}
