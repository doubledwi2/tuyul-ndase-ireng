import type { OpportunityEvent } from '../scanner/opportunity.js';
import type { DepthComparison } from '../scanner/depth-comparator.js';
import type { OpportunityQualification } from '../scanner/opportunity-filter.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import type { SyncAssessment } from '../timing/sync-model.js';

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
  bybitAverageObservedIngressMs: number | null;
  bybitP50ObservedIngressMs: number | null;
  bybitP95ObservedIngressMs: number | null;
  bybitP99ObservedIngressMs: number | null;
  bybitMaxObservedIngressMs: number | null;
  okxAverageObservedIngressMs: number | null;
  okxP50ObservedIngressMs: number | null;
  okxP95ObservedIngressMs: number | null;
  okxP99ObservedIngressMs: number | null;
  okxMaxObservedIngressMs: number | null;
  averageReceiveSkewMs: number | null;
  p50ReceiveSkewMs: number | null;
  p95ReceiveSkewMs: number | null;
  p99ReceiveSkewMs: number | null;
  maxReceiveSkewMs: number | null;
  averageSourceTimestampSkewMs: number | null;
  p95SourceTimestampSkewMs: number | null;
  p99SourceTimestampSkewMs: number | null;
  p50MaxBookAgeMs: number | null;
  p95MaxBookAgeMs: number | null;
  p99MaxBookAgeMs: number | null;
  averageProcessingDurationMs: number | null;
  p50ProcessingDurationMs: number | null;
  p95ProcessingDurationMs: number | null;
  p99ProcessingDurationMs: number | null;
  maxProcessingDurationMs: number | null;
  timingAssessmentsTotal: number;
  syncHealthyCount: number;
  receiveSkewHighCount: number;
  sourceSkewHighCount: number;
  bookTooOldCount: number;
  clockUnhealthyCount: number;
  timestampAnomalyCount: number;
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
  private readonly bybitObservedIngress: number[] = [];
  private readonly okxObservedIngress: number[] = [];
  private readonly receiveSkews: number[] = [];
  private readonly sourceTimestampSkews: number[] = [];
  private readonly maxBookAges: number[] = [];
  private readonly processingDurations: number[] = [];
  private timingAssessmentsTotal = 0;
  private syncHealthyCount = 0;
  private receiveSkewHighCount = 0;
  private sourceSkewHighCount = 0;
  private bookTooOldCount = 0;
  private clockUnhealthyCount = 0;
  private timestampAnomalyCount = 0;
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

  recordTiming(
    assessment: SyncAssessment,
    processingDurationMs: number | null,
    updatedExchange: NormalizedOrderBook['exchange'],
  ): void {
    this.timingAssessmentsTotal += 1;
    this.receiveSkews.push(assessment.receiveSkewMs);
    this.maxBookAges.push(assessment.maxBookAgeMs);
    if (assessment.sourceTimestampSkewMs !== null) {
      this.sourceTimestampSkews.push(assessment.sourceTimestampSkewMs);
    }
    if (
      updatedExchange === 'bybit' &&
      assessment.bybitObservedIngressMs !== null
    ) {
      this.bybitObservedIngress.push(assessment.bybitObservedIngressMs);
    }
    if (
      updatedExchange === 'okx' &&
      assessment.okxObservedIngressMs !== null
    ) {
      this.okxObservedIngress.push(assessment.okxObservedIngressMs);
    }
    if (processingDurationMs !== null) {
      this.processingDurations.push(processingDurationMs);
    }
    if (assessment.status === 'SYNC_HEALTHY') {
      this.syncHealthyCount += 1;
    }
    if (assessment.reasons.includes('RECEIVE_SKEW_HIGH')) {
      this.receiveSkewHighCount += 1;
    }
    if (assessment.reasons.includes('SOURCE_SKEW_HIGH')) {
      this.sourceSkewHighCount += 1;
    }
    if (assessment.reasons.includes('BOOK_TOO_OLD')) {
      this.bookTooOldCount += 1;
    }
    if (assessment.reasons.includes('CLOCK_UNHEALTHY')) {
      this.clockUnhealthyCount += 1;
    }
    if (assessment.reasons.includes('TIMESTAMP_ANOMALY')) {
      this.timestampAnomalyCount += 1;
    }
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
      bybitAverageObservedIngressMs: average(this.bybitObservedIngress),
      bybitP50ObservedIngressMs: nearestRankPercentile(
        this.bybitObservedIngress,
        50,
      ),
      bybitP95ObservedIngressMs: nearestRankPercentile(
        this.bybitObservedIngress,
        95,
      ),
      bybitP99ObservedIngressMs: nearestRankPercentile(
        this.bybitObservedIngress,
        99,
      ),
      bybitMaxObservedIngressMs: maximum(this.bybitObservedIngress),
      okxAverageObservedIngressMs: average(this.okxObservedIngress),
      okxP50ObservedIngressMs: nearestRankPercentile(
        this.okxObservedIngress,
        50,
      ),
      okxP95ObservedIngressMs: nearestRankPercentile(
        this.okxObservedIngress,
        95,
      ),
      okxP99ObservedIngressMs: nearestRankPercentile(
        this.okxObservedIngress,
        99,
      ),
      okxMaxObservedIngressMs: maximum(this.okxObservedIngress),
      averageReceiveSkewMs: average(this.receiveSkews),
      p50ReceiveSkewMs: nearestRankPercentile(this.receiveSkews, 50),
      p95ReceiveSkewMs: nearestRankPercentile(this.receiveSkews, 95),
      p99ReceiveSkewMs: nearestRankPercentile(this.receiveSkews, 99),
      maxReceiveSkewMs: maximum(this.receiveSkews),
      averageSourceTimestampSkewMs: average(this.sourceTimestampSkews),
      p95SourceTimestampSkewMs: nearestRankPercentile(
        this.sourceTimestampSkews,
        95,
      ),
      p99SourceTimestampSkewMs: nearestRankPercentile(
        this.sourceTimestampSkews,
        99,
      ),
      p50MaxBookAgeMs: nearestRankPercentile(this.maxBookAges, 50),
      p95MaxBookAgeMs: nearestRankPercentile(this.maxBookAges, 95),
      p99MaxBookAgeMs: nearestRankPercentile(this.maxBookAges, 99),
      averageProcessingDurationMs: average(this.processingDurations),
      p50ProcessingDurationMs: nearestRankPercentile(
        this.processingDurations,
        50,
      ),
      p95ProcessingDurationMs: nearestRankPercentile(
        this.processingDurations,
        95,
      ),
      p99ProcessingDurationMs: nearestRankPercentile(
        this.processingDurations,
        99,
      ),
      maxProcessingDurationMs: maximum(this.processingDurations),
      timingAssessmentsTotal: this.timingAssessmentsTotal,
      syncHealthyCount: this.syncHealthyCount,
      receiveSkewHighCount: this.receiveSkewHighCount,
      sourceSkewHighCount: this.sourceSkewHighCount,
      bookTooOldCount: this.bookTooOldCount,
      clockUnhealthyCount: this.clockUnhealthyCount,
      timestampAnomalyCount: this.timestampAnomalyCount,
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
