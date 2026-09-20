import type { OpportunityEvent } from '../scanner/opportunity.js';
import type { DepthComparison } from '../scanner/depth-comparator.js';

export interface OpportunityMetricsSummary {
  comparisonsTotal: number;
  insufficientDepthCount: number;
  executableNetPositiveCount: number;
  executableNetNonPositiveCount: number;
  averageBuySlippagePercent: number | null;
  averageSellSlippagePercent: number | null;
  totalCompletedEvents: number;
  eventsEverActive: number;
  eventsNeverActive: number;
  invalidSyncEvents: number;
  averageLifetimeMs: number | null;
  minLifetimeMs: number | null;
  maxLifetimeMs: number | null;
  p50LifetimeMs: number | null;
  p95LifetimeMs: number | null;
  p99LifetimeMs: number | null;
  averagePeakSpreadPercent: number | null;
  maxPeakSpreadPercent: number | null;
  averagePeakNetSpreadPercent: number | null;
  maxPeakNetSpreadPercent: number | null;
  averagePeakNetPnlAbsolute: number | null;
  maxPeakNetPnlAbsolute: number | null;
  averagePeakTradableSize: number | null;
  maxPeakTradableSize: number | null;
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function minimum(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.min(...values);
}

function maximum(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

export function nearestRankPercentile(
  values: readonly number[],
  percentile: number,
): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? null;
}

export class OpportunityMetrics {
  private comparisonsTotal = 0;
  private insufficientDepthCount = 0;
  private executableNetPositiveCount = 0;
  private executableNetNonPositiveCount = 0;
  private readonly buySlippages: number[] = [];
  private readonly sellSlippages: number[] = [];
  private totalCompletedEvents = 0;
  private eventsEverActive = 0;
  private invalidSyncEvents = 0;
  private readonly lifetimes: number[] = [];
  private readonly peakSpreads: number[] = [];
  private readonly peakNetSpreads: number[] = [];
  private readonly peakNetPnls: number[] = [];
  private readonly peakSizes: number[] = [];

  recordComparison(comparison: DepthComparison): void {
    this.comparisonsTotal += 1;
    if (comparison.status === 'INSUFFICIENT_DEPTH') {
      this.insufficientDepthCount += 1;
    } else if (comparison.status === 'EXECUTABLE_NET_POSITIVE') {
      this.executableNetPositiveCount += 1;
    } else if (comparison.status === 'EXECUTABLE_NET_ZERO_OR_NEGATIVE') {
      this.executableNetNonPositiveCount += 1;
    }
    if (comparison.buyExecution.slippagePercent !== null) {
      this.buySlippages.push(comparison.buyExecution.slippagePercent);
    }
    if (comparison.sellExecution.slippagePercent !== null) {
      this.sellSlippages.push(comparison.sellExecution.slippagePercent);
    }
  }

  recordCompleted(event: OpportunityEvent): void {
    if (event.state !== 'DISAPPEARED' || event.lifetimeMs === null) {
      return;
    }

    this.totalCompletedEvents += 1;
    if (event.everActive) {
      this.eventsEverActive += 1;
    }
    if (event.everInvalidSync) {
      this.invalidSyncEvents += 1;
    }
    this.lifetimes.push(event.lifetimeMs);
    this.peakSpreads.push(event.peakGrossSpreadPercent);
    this.peakNetSpreads.push(event.peakEstimatedNetSpreadPercent);
    this.peakNetPnls.push(event.peakEstimatedNetPnlAbsolute);
    this.peakSizes.push(event.peakTradableSize);
  }

  getSummary(): OpportunityMetricsSummary {
    return {
      comparisonsTotal: this.comparisonsTotal,
      insufficientDepthCount: this.insufficientDepthCount,
      executableNetPositiveCount: this.executableNetPositiveCount,
      executableNetNonPositiveCount: this.executableNetNonPositiveCount,
      averageBuySlippagePercent: average(this.buySlippages),
      averageSellSlippagePercent: average(this.sellSlippages),
      totalCompletedEvents: this.totalCompletedEvents,
      eventsEverActive: this.eventsEverActive,
      eventsNeverActive: this.totalCompletedEvents - this.eventsEverActive,
      invalidSyncEvents: this.invalidSyncEvents,
      averageLifetimeMs: average(this.lifetimes),
      minLifetimeMs: minimum(this.lifetimes),
      maxLifetimeMs: maximum(this.lifetimes),
      p50LifetimeMs: nearestRankPercentile(this.lifetimes, 50),
      p95LifetimeMs: nearestRankPercentile(this.lifetimes, 95),
      p99LifetimeMs: nearestRankPercentile(this.lifetimes, 99),
      averagePeakSpreadPercent: average(this.peakSpreads),
      maxPeakSpreadPercent: maximum(this.peakSpreads),
      averagePeakNetSpreadPercent: average(this.peakNetSpreads),
      maxPeakNetSpreadPercent: maximum(this.peakNetSpreads),
      averagePeakNetPnlAbsolute: average(this.peakNetPnls),
      maxPeakNetPnlAbsolute: maximum(this.peakNetPnls),
      averagePeakTradableSize: average(this.peakSizes),
      maxPeakTradableSize: maximum(this.peakSizes),
    };
  }
}
