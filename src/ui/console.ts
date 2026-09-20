import type { OpportunityMetricsSummary } from '../metrics/opportunity-metrics.js';
import {
  OPPORTUNITY_QUALITY_CONFIG,
  type OpportunityQualityConfig,
} from '../config/opportunity.js';
import { TIMING_CONFIG, type TimingConfig } from '../config/timing.js';
import type {
  FeeAwareComparison,
  FeeAwareComparisons,
} from '../scanner/fee-model.js';
import type {
  DepthComparison,
  DepthComparisons,
} from '../scanner/depth-comparator.js';
import type { OpportunityEvent } from '../scanner/opportunity.js';
import type { OpportunityQualification } from '../scanner/opportunity-filter.js';
import type { SyncAssessment } from '../timing/sync-model.js';
import type { BestQuote } from '../types/market.js';

function signed(value: number, fractionDigits: number): string {
  const prefix = value >= 0 ? '+' : '';
  return `${prefix}${value.toFixed(fractionDigits)}`;
}

function printQuote(label: string, quote: BestQuote): void {
  console.log(label);
  console.log(`Bid: ${quote.bid} (${quote.bidSize} BTC)`);
  console.log(`Ask: ${quote.ask} (${quote.askSize} BTC)`);
}

function printDirection(comparison: FeeAwareComparison): void {
  const buy = comparison.buyExchange.toUpperCase();
  const sell = comparison.sellExchange.toUpperCase();

  console.log(`${buy} -> ${sell}`);
  console.log(`Buy: ${comparison.buyPrice}`);
  console.log(`Sell: ${comparison.sellPrice}`);
  console.log(`Tradable size: ${comparison.tradableSize} BTC`);
  console.log('');
  console.log(
    `Gross spread: ${signed(comparison.grossSpreadAbsolute, 2)} USDT/BTC ` +
      `(${signed(comparison.grossSpreadPercent, 4)}%)`,
  );
  console.log(`Gross PnL: ${signed(comparison.grossPnlAbsolute, 4)} USDT`);
  console.log('Estimated fees:');
  console.log(`Buy fee: ${comparison.estimatedBuyFee.toFixed(4)} USDT`);
  console.log(`Sell fee: ${comparison.estimatedSellFee.toFixed(4)} USDT`);
  console.log(`Total fee: ${comparison.estimatedTotalFee.toFixed(4)} USDT`);
  console.log(
    `Estimated net: ${signed(comparison.estimatedNetPnlAbsolute, 4)} USDT ` +
      `(${signed(comparison.estimatedNetSpreadPercent, 4)}%)`,
  );
  console.log(`Sync diff: ${comparison.receiveTimeDifferenceMs} ms`);
  console.log(`Fee status: ${comparison.feeStatus}`);
}

export function printComparisonSummary(
  bybitQuote: BestQuote,
  okxQuote: BestQuote,
  comparisons: FeeAwareComparisons,
): void {
  console.log(`\n${bybitQuote.symbol}\n`);
  printQuote('BYBIT', bybitQuote);
  console.log('');
  printQuote('OKX', okxQuote);
  console.log('');
  printDirection(comparisons[0]);
  console.log('');
  printDirection(comparisons[1]);
}

function optionalSigned(
  value: number | null,
  fractionDigits: number,
  suffix: string,
): string {
  return value === null ? 'N/A' : `${signed(value, fractionDigits)}${suffix}`;
}

function printExecutionLeg(
  label: string,
  exchange: string,
  execution: DepthComparison['buyExecution'],
): void {
  console.log(`${label} ${exchange.toUpperCase()}`);
  console.log(`Best price: ${execution.bestPrice ?? 'N/A'}`);
  console.log(`VWAP: ${execution.averageExecutionPrice ?? 'N/A'}`);
  console.log(
    `Slippage: ${optionalSigned(execution.slippagePercent, 4, '%')}`,
  );
  console.log(
    `Filled: ${execution.filledSize.toFixed(6)} / ` +
      `${execution.requestedSize.toFixed(6)} BTC`,
  );
}

function passFail(value: boolean): string {
  return value ? 'PASS' : 'FAIL';
}

function printSourceClock(
  label: string,
  sourceClock: SyncAssessment['bybitSourceClock'],
): void {
  console.log(`${label} SOURCE CLOCK`);
  console.log(
    `Raw observed ingress: ${sourceClock.rawObservedIngressMs ?? 'N/A'} ms`,
  );
  console.log(
    `Baseline: ${sourceClock.baselineObservedIngressMs ?? 'N/A'} ms`,
  );
  console.log(
    `Deviation: ${optionalSigned(
      sourceClock.observedIngressDeviationMs,
      2,
      ' ms',
    )}`,
  );
  console.log(`Samples: ${sourceClock.offsetSampleCount}`);
  console.log(`Status: ${sourceClock.offsetStatus}`);
}

function printQuality(
  comparison: DepthComparison,
  qualification: OpportunityQualification,
  config: OpportunityQualityConfig,
): void {
  console.log('QUALITY');
  console.log(
    `Net spread: actual ${optionalSigned(comparison.estimatedNetSpreadPercent, 4, '%')}; ` +
      `required >= ${config.minNetSpreadPercent.toFixed(4)}% — ` +
      passFail(qualification.netSpreadOk),
  );
  console.log(
    `Net PnL: actual ${optionalSigned(comparison.estimatedNetPnlAbsolute, 4, ' USDT')}; ` +
      `required >= ${config.minNetPnlUsdt.toFixed(4)} USDT — ` +
      passFail(qualification.netPnlOk),
  );
  console.log(
    `Sync assessment: ${qualification.syncOk ? 'SYNC_HEALTHY' : 'UNHEALTHY'} — ` +
      passFail(qualification.syncOk),
  );
  console.log(`Depth: ${passFail(qualification.depthOk)}`);
  if (qualification.qualified) {
    console.log('Quality status: QUALIFIED_CANDIDATE');
  } else {
    console.log(`Rejected: ${qualification.reasons.join(', ')}`);
  }
}

function printDepthDirection(
  comparison: DepthComparison,
  qualification: OpportunityQualification,
  qualityConfig: OpportunityQualityConfig,
): void {
  console.log(
    `${comparison.buyExchange.toUpperCase()} -> ` +
      `${comparison.sellExchange.toUpperCase()}`,
  );
  console.log(`Target: ${comparison.targetBaseSize.toFixed(6)} BTC`);
  console.log('');
  printExecutionLeg('BUY', comparison.buyExchange, comparison.buyExecution);
  console.log('');
  printExecutionLeg('SELL', comparison.sellExchange, comparison.sellExecution);
  console.log('');
  console.log(
    `Gross PnL: ${optionalSigned(comparison.grossPnlAbsolute, 4, ' USDT')}`,
  );
  console.log(
    `Estimated fees: ${optionalSigned(comparison.estimatedTotalFee, 4, ' USDT')}`,
  );
  console.log(
    `Estimated net PnL: ` +
      optionalSigned(comparison.estimatedNetPnlAbsolute, 4, ' USDT'),
  );
  console.log(
    `Estimated net spread: ` +
      optionalSigned(comparison.estimatedNetSpreadPercent, 4, '%'),
  );
  console.log(`Sync diff: ${comparison.receiveTimeDifferenceMs} ms`);
  console.log(`Status: ${comparison.status}`);
  console.log('');
  printQuality(comparison, qualification, qualityConfig);
}

export function printDepthComparisonSummary(
  comparisons: DepthComparisons,
  qualifications: readonly [OpportunityQualification, OpportunityQualification],
  qualityConfig: OpportunityQualityConfig = OPPORTUNITY_QUALITY_CONFIG,
  syncAssessment?: SyncAssessment,
  processingDurationMs: number | null = null,
  timingConfig: TimingConfig = TIMING_CONFIG,
): void {
  console.log('\nBTC/USDT DEPTH SIMULATION\n');
  if (syncAssessment !== undefined) {
    console.log('TIMING');
    console.log(`Receive skew: ${syncAssessment.receiveSkewMs} ms`);
    console.log(
      `Source timestamp skew: ${syncAssessment.sourceTimestampSkewMs ?? 'N/A'} ms`,
    );
    console.log(
      `Book age: Bybit ${syncAssessment.bybitBookAgeMs} ms; ` +
        `OKX ${syncAssessment.okxBookAgeMs} ms; ` +
        `max ${syncAssessment.maxBookAgeMs} ms`,
    );
    printSourceClock('BYBIT', syncAssessment.bybitSourceClock);
    console.log('');
    printSourceClock('OKX', syncAssessment.okxSourceClock);
    console.log('');
    console.log(`Processing duration: ${processingDurationMs ?? 'N/A'} ms`);
    console.log(`Clock: ${syncAssessment.clockHealth.status}`);
    console.log(`Sync: ${syncAssessment.status}`);
    if (syncAssessment.reasons.length > 0) {
      console.log('Reasons:');
      for (const reason of syncAssessment.reasons) {
        if (reason === 'RECEIVE_SKEW_HIGH') {
          console.log(
            `- receive skew ${syncAssessment.receiveSkewMs} ms > ` +
              `${timingConfig.maxReceiveSkewMs} ms`,
          );
        } else if (reason === 'SOURCE_SKEW_HIGH') {
          console.log(
            `- source timestamp skew ${syncAssessment.sourceTimestampSkewMs} ms > ` +
              `${timingConfig.maxSourceTimestampSkewMs} ms`,
          );
        } else if (reason === 'BOOK_TOO_OLD') {
          console.log(
            `- max book age ${syncAssessment.maxBookAgeMs} ms > ` +
              `${timingConfig.maxBookAgeMs} ms`,
          );
        } else if (reason === 'SOURCE_OFFSET_DEVIATION_HIGH') {
          console.log(
            `- source offset deviation exceeds ` +
              `${timingConfig.maxOffsetDeviationMs} ms`,
          );
        } else if (reason === 'SYNC_WARMING_UP') {
          console.log(
            `- source clock estimator warming up; requires ` +
              `${timingConfig.minOffsetSamples} samples per available source`,
          );
        } else {
          console.log(`- ${reason}`);
        }
      }
    }
    console.log('');
  }
  printDepthDirection(comparisons[0], qualifications[0], qualityConfig);
  console.log('');
  printDepthDirection(comparisons[1], qualifications[1], qualityConfig);
}

export function printOpportunityEvent(event: OpportunityEvent): void {
  console.log('\n[EVENT]');
  console.log(`ID: ${event.id}`);
  console.log(
    `Direction: ${event.buyExchange.toUpperCase()} -> ${event.sellExchange.toUpperCase()}`,
  );
  console.log(`State: ${event.state}`);
  if (event.state === 'QUALIFIED') {
    console.log(`Time to qualified: ${event.timeToQualifiedMs ?? 'N/A'} ms`);
  }
  console.log(`Target: ${event.targetBaseSize.toFixed(6)} BTC`);
  console.log(`Buy VWAP: ${event.buyAverageExecutionPrice ?? 'N/A'}`);
  console.log(`Sell VWAP: ${event.sellAverageExecutionPrice ?? 'N/A'}`);
  console.log(
    `Buy slippage: ${optionalSigned(event.buySlippagePercent, 4, '%')}`,
  );
  console.log(
    `Sell slippage: ${optionalSigned(event.sellSlippagePercent, 4, '%')}`,
  );
  console.log(
    `Gross spread: ${signed(event.currentGrossSpreadAbsolute, 2)} USDT/BTC ` +
      `(${signed(event.currentGrossSpreadPercent, 4)}%)`,
  );
  console.log(
    `Estimated net spread: ${signed(event.currentEstimatedNetSpreadPercent, 4)}%`,
  );
  console.log(
    `Estimated net PnL: ${signed(event.currentEstimatedNetPnlAbsolute, 4)} USDT`,
  );
  console.log(
    `Estimated total fee: ${event.currentEstimatedTotalFee.toFixed(4)} USDT`,
  );
  console.log(`Tradable size: ${event.currentTradableSize} BTC`);
  console.log(`Sync diff: ${event.currentReceiveTimeDifferenceMs} ms`);
  console.log(`Receive skew: ${event.currentReceiveSkewMs} ms`);
  console.log(
    `Source timestamp skew: ${event.currentSourceTimestampSkewMs ?? 'N/A'} ms`,
  );
  console.log(`Max book age: ${event.currentMaxBookAgeMs} ms`);
  console.log(`Sync status: ${event.currentSyncStatus}`);
  if (event.currentSyncReasons.length > 0) {
    console.log(`Sync reasons: ${event.currentSyncReasons.join(', ')}`);
  }

  if (event.state === 'DISAPPEARED') {
    console.log(`Lifetime: ${event.lifetimeMs ?? 0} ms`);
    console.log(`Ever qualified: ${event.everQualified}`);
    console.log(`Time to qualified: ${event.timeToQualifiedMs ?? 'N/A'} ms`);
    console.log(
      `Peak gross spread: ${signed(event.peakGrossSpreadAbsolute, 2)} USDT/BTC ` +
        `(${signed(event.peakGrossSpreadPercent, 4)}%)`,
    );
    console.log(
      `Peak estimated net spread: ${signed(event.peakEstimatedNetSpreadPercent, 4)}%`,
    );
    console.log(
      `Peak estimated net PnL: ${signed(event.peakEstimatedNetPnlAbsolute, 4)} USDT`,
    );
    console.log(`Peak tradable size: ${event.peakTradableSize} BTC`);
    console.log(`Peak receive skew: ${event.peakReceiveSkewMs} ms`);
  }
}

function metric(value: number | null, fractionDigits: number): string {
  return value === null ? 'N/A' : value.toFixed(fractionDigits);
}

export function printMetricsSummary(summary: OpportunityMetricsSummary): void {
  console.log('\n[METRICS]');
  console.log(`Depth comparisons: ${summary.comparisonsTotal}`);
  console.log(`Insufficient depth: ${summary.insufficientDepthCount}`);
  console.log(`Executable net positive: ${summary.executableNetPositiveCount}`);
  console.log(
    `Executable net non-positive: ${summary.executableNetNonPositiveCount}`,
  );
  console.log(`Net-positive comparisons: ${summary.totalNetPositiveComparisons}`);
  console.log(`Qualified comparisons: ${summary.qualifiedComparisons}`);
  console.log(`Qualification rejected: ${summary.qualificationRejectedCount}`);
  console.log(`Rejected not net-positive: ${summary.rejectedNotNetPositive}`);
  console.log(`Rejected small net spread: ${summary.rejectedSmallNetSpread}`);
  console.log(`Rejected small net PnL: ${summary.rejectedSmallNetPnl}`);
  console.log(`Rejected wide sync: ${summary.rejectedWideSync}`);
  console.log(
    `Rejected insufficient depth: ${summary.rejectedInsufficientDepth}`,
  );
  console.log(`Rejected stale: ${summary.rejectedStale}`);
  console.log(
    `Average buy slippage: ${metric(summary.averageBuySlippagePercent, 4)}%`,
  );
  console.log(
    `Average sell slippage: ${metric(summary.averageSellSlippagePercent, 4)}%`,
  );
  console.log('\n[TIMING]');
  console.log(
    `Receive skew avg/P50/P95/P99/max: ` +
      `${metric(summary.averageReceiveSkewMs, 2)} / ` +
      `${metric(summary.p50ReceiveSkewMs, 2)} / ` +
      `${metric(summary.p95ReceiveSkewMs, 2)} / ` +
      `${metric(summary.p99ReceiveSkewMs, 2)} / ` +
      `${metric(summary.maxReceiveSkewMs, 2)} ms`,
  );
  console.log(
    `Observed ingress Bybit avg/P50/P95/P99/max: ` +
      `${metric(summary.bybitAverageObservedIngressMs, 2)} / ` +
      `${metric(summary.bybitP50ObservedIngressMs, 2)} / ` +
      `${metric(summary.bybitP95ObservedIngressMs, 2)} / ` +
      `${metric(summary.bybitP99ObservedIngressMs, 2)} / ` +
      `${metric(summary.bybitMaxObservedIngressMs, 2)} ms`,
  );
  console.log(
    `Offset baseline Bybit: ` +
      `${metric(summary.bybitObservedIngressBaselineMs, 2)} ms`,
  );
  console.log(
    `Absolute offset deviation Bybit P50/P95/P99/max: ` +
      `${metric(summary.bybitP50AbsoluteOffsetDeviationMs, 2)} / ` +
      `${metric(summary.bybitP95AbsoluteOffsetDeviationMs, 2)} / ` +
      `${metric(summary.bybitP99AbsoluteOffsetDeviationMs, 2)} / ` +
      `${metric(summary.bybitMaxAbsoluteOffsetDeviationMs, 2)} ms`,
  );
  console.log(
    `Observed ingress OKX avg/P50/P95/P99/max: ` +
      `${metric(summary.okxAverageObservedIngressMs, 2)} / ` +
      `${metric(summary.okxP50ObservedIngressMs, 2)} / ` +
      `${metric(summary.okxP95ObservedIngressMs, 2)} / ` +
      `${metric(summary.okxP99ObservedIngressMs, 2)} / ` +
      `${metric(summary.okxMaxObservedIngressMs, 2)} ms`,
  );
  console.log(
    `Offset baseline OKX: ` +
      `${metric(summary.okxObservedIngressBaselineMs, 2)} ms`,
  );
  console.log(
    `Absolute offset deviation OKX P50/P95/P99/max: ` +
      `${metric(summary.okxP50AbsoluteOffsetDeviationMs, 2)} / ` +
      `${metric(summary.okxP95AbsoluteOffsetDeviationMs, 2)} / ` +
      `${metric(summary.okxP99AbsoluteOffsetDeviationMs, 2)} / ` +
      `${metric(summary.okxMaxAbsoluteOffsetDeviationMs, 2)} ms`,
  );
  console.log(
    `Source timestamp skew avg/P95/P99: ` +
      `${metric(summary.averageSourceTimestampSkewMs, 2)} / ` +
      `${metric(summary.p95SourceTimestampSkewMs, 2)} / ` +
      `${metric(summary.p99SourceTimestampSkewMs, 2)} ms`,
  );
  console.log(
    `Max book age P50/P95/P99: ` +
      `${metric(summary.p50MaxBookAgeMs, 2)} / ` +
      `${metric(summary.p95MaxBookAgeMs, 2)} / ` +
      `${metric(summary.p99MaxBookAgeMs, 2)} ms`,
  );
  console.log(
    `Processing avg/P50/P95/P99/max: ` +
      `${metric(summary.averageProcessingDurationMs, 4)} / ` +
      `${metric(summary.p50ProcessingDurationMs, 4)} / ` +
      `${metric(summary.p95ProcessingDurationMs, 4)} / ` +
      `${metric(summary.p99ProcessingDurationMs, 4)} / ` +
      `${metric(summary.maxProcessingDurationMs, 4)} ms`,
  );
  console.log(
    `Sync healthy: ${summary.syncHealthyCount} / ${summary.timingAssessmentsTotal}`,
  );
  console.log(
    `Sync failures receive/source/age/clock/anomaly: ` +
      `${summary.receiveSkewHighCount} / ${summary.sourceSkewHighCount} / ` +
      `${summary.bookTooOldCount} / ${summary.clockUnhealthyCount} / ` +
      `${summary.timestampAnomalyCount}`,
  );
  console.log(
    `Source clock warming-up/deviation-high: ` +
      `${summary.sourceClockWarmingUpCount} / ` +
      `${summary.sourceOffsetDeviationHighCount}`,
  );
  console.log('');
  console.log(`Completed events: ${summary.totalCompletedEvents}`);
  console.log(`Ever ACTIVE: ${summary.eventsEverActive}`);
  console.log(`Never ACTIVE: ${summary.eventsNeverActive}`);
  console.log(`Ever INVALID_SYNC: ${summary.invalidSyncEvents}`);
  console.log(`Ever QUALIFIED: ${summary.eventsEverQualified}`);
  console.log(`Never QUALIFIED: ${summary.eventsNeverQualified}`);
  console.log(
    `Time to qualified avg/P50/P95: ` +
      `${metric(summary.averageTimeToQualifiedMs, 2)} / ` +
      `${metric(summary.p50TimeToQualifiedMs, 0)} / ` +
      `${metric(summary.p95TimeToQualifiedMs, 0)} ms`,
  );
  console.log('');
  console.log('Lifetime:');
  console.log(`Avg: ${metric(summary.averageLifetimeMs, 2)} ms`);
  console.log(`Min: ${metric(summary.minLifetimeMs, 0)} ms`);
  console.log(`P50: ${metric(summary.p50LifetimeMs, 0)} ms`);
  console.log(`P95: ${metric(summary.p95LifetimeMs, 0)} ms`);
  console.log(`P99: ${metric(summary.p99LifetimeMs, 0)} ms`);
  console.log(`Max: ${metric(summary.maxLifetimeMs, 0)} ms`);
  console.log('');
  console.log('Peak gross spread:');
  console.log(`Avg: ${metric(summary.averagePeakSpreadPercent, 4)}%`);
  console.log(`Max: ${metric(summary.maxPeakSpreadPercent, 4)}%`);
  console.log('');
  console.log('Peak estimated net spread:');
  console.log(`Avg: ${metric(summary.averagePeakNetSpreadPercent, 4)}%`);
  console.log(`Max: ${metric(summary.maxPeakNetSpreadPercent, 4)}%`);
  console.log('');
  console.log('Peak estimated net PnL:');
  console.log(`Avg: ${metric(summary.averagePeakNetPnlAbsolute, 4)} USDT`);
  console.log(`Max: ${metric(summary.maxPeakNetPnlAbsolute, 4)} USDT`);
  console.log('');
  console.log('Peak size:');
  console.log(`Avg: ${metric(summary.averagePeakTradableSize, 8)} BTC`);
  console.log(`Max: ${metric(summary.maxPeakTradableSize, 8)} BTC`);
}
