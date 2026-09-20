import type { OpportunityEvent } from '../scanner/opportunity.js';
import type { DepthComparison } from '../scanner/depth-comparator.js';
import type { OpportunityQualification } from '../scanner/opportunity-filter.js';

export interface OpportunityMetricsSummary {
  comparisonsTotal: number;
  insufficientDepthCount: number;
  executableNetPositiveCount: number;
  executableNetNonPositiveCount: number;
  totalNetPositiveComparisons: number;
  qualifiedComparisons: number;
  qualificationRejectedCount: number;
  rejectedNotNetPositive: number;
  rejectedSmallNetSpread: number;
  rejectedSmallNetPnl: number;
  rejectedWideSync: number;
  rejectedInsufficientDepth: number;
  rejectedStale: number;
  averageBuySlippagePercent: number | null;
  averageSellSlippagePercent: number | null;
  totalCompletedEvents: number;
  eventsEverActive: number;
  eventsNeverActive: number;
  invalidSyncEvents: number;
  eventsEverQualified: number;
  eventsNeverQualified: number;
  averageTimeToQualifiedMs: number | null;
  p50TimeToQualifiedMs: number | null;
  p95TimeToQualifiedMs: number | null;
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
  private totalNetPositiveComparisons = 0;
  private qualifiedComparisons = 0;
  private qualificationRejectedCount = 0;
  private rejectedNotNetPositive = 0;
  private rejectedSmallNetSpread = 0;
  private rejectedSmallNetPnl = 0;
  private rejectedWideSync = 0;
  private rejectedInsufficientDepth = 0;
  private rejectedStale = 0;
  private readonly buySlippages: number[] = [];
  private readonly sellSlippages: number[] = [];
  private totalCompletedEvents = 0;
  private eventsEverActive = 0;
  private invalidSyncEvents = 0;
  private eventsEverQualified = 0;
  private readonly timesToQualified: number[] = [];
  private readonly lifetimes: number[] = [];
  private readonly peakSpreads: number[] = [];
  private readonly peakNetSpreads: number[] = [];
  private readonly peakNetPnls: number[] = [];
  private readonly peakSizes: number[] = [];

  recordComparison(
    comparison: DepthComparison,
    qualification?: OpportunityQualification,
  ): void {
    this.comparisonsTotal += 1;
    if (comparison.status === 'INSUFFICIENT_DEPTH') {
      this.insufficientDepthCount += 1;
    } else if (comparison.status === 'EXECUTABLE_NET_POSITIVE') {
      this.executableNetPositiveCount += 1;
      this.totalNetPositiveComparisons += 1;
    } else if (comparison.status === 'EXECUTABLE_NET_ZERO_OR_NEGATIVE') {
      this.executableNetNonPositiveCount += 1;
    }
    if (comparison.buyExecution.slippagePercent !== null) {
      this.buySlippages.push(comparison.buyExecution.slippagePercent);
    }
    if (comparison.sellExecution.slippagePercent !== null) {
      this.sellSlippages.push(comparison.sellExecution.slippagePercent);
    }
    if (qualification === undefined) {
      return;
    }
    if (qualification.qualified) {
      this.qualifiedComparisons += 1;
      return;
    }
    this.qualificationRejectedCount += 1;
    if (qualification.reasons.includes('NOT_NET_POSITIVE')) {
      this.rejectedNotNetPositive += 1;
    }
    if (qualification.reasons.includes('NET_SPREAD_TOO_SMALL')) {
      this.rejectedSmallNetSpread += 1;
    }
    if (qualification.reasons.includes('NET_PNL_TOO_SMALL')) {
      this.rejectedSmallNetPnl += 1;
    }
    if (qualification.reasons.includes('SYNC_TOO_WIDE')) {
      this.rejectedWideSync += 1;
    }
    if (qualification.reasons.includes('INSUFFICIENT_DEPTH')) {
      this.rejectedInsufficientDepth += 1;
    }
    if (qualification.reasons.includes('STALE')) {
      this.rejectedStale += 1;
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
    if (event.everQualified) {
      this.eventsEverQualified += 1;
      if (event.timeToQualifiedMs !== null) {
        this.timesToQualified.push(event.timeToQualifiedMs);
      }
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
      totalNetPositiveComparisons: this.totalNetPositiveComparisons,
      qualifiedComparisons: this.qualifiedComparisons,
      qualificationRejectedCount: this.qualificationRejectedCount,
      rejectedNotNetPositive: this.rejectedNotNetPositive,
      rejectedSmallNetSpread: this.rejectedSmallNetSpread,
      rejectedSmallNetPnl: this.rejectedSmallNetPnl,
      rejectedWideSync: this.rejectedWideSync,
      rejectedInsufficientDepth: this.rejectedInsufficientDepth,
      rejectedStale: this.rejectedStale,
      averageBuySlippagePercent: average(this.buySlippages),
      averageSellSlippagePercent: average(this.sellSlippages),
      totalCompletedEvents: this.totalCompletedEvents,
      eventsEverActive: this.eventsEverActive,
      eventsNeverActive: this.totalCompletedEvents - this.eventsEverActive,
      invalidSyncEvents: this.invalidSyncEvents,
      eventsEverQualified: this.eventsEverQualified,
      eventsNeverQualified: this.totalCompletedEvents - this.eventsEverQualified,
      averageTimeToQualifiedMs: average(this.timesToQualified),
      p50TimeToQualifiedMs: nearestRankPercentile(this.timesToQualified, 50),
      p95TimeToQualifiedMs: nearestRankPercentile(this.timesToQualified, 95),
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
