import { randomUUID } from 'node:crypto';

import {
  OPPORTUNITY_QUALITY_CONFIG,
  type OpportunityQualityConfig,
} from '../config/opportunity.js';
import type { DepthComparison } from './depth-comparator.js';
import {
  qualifyOpportunity,
  type OpportunityQualification,
  type QualificationReason,
} from './opportunity-filter.js';

export interface OpportunityEvent {
  id: string;
  symbol: 'BTC/USDT';
  buyExchange: 'bybit' | 'okx';
  sellExchange: 'bybit' | 'okx';
  state:
    | 'DETECTED'
    | 'VALIDATING'
    | 'ACTIVE'
    | 'QUALIFIED'
    | 'INVALID_SYNC'
    | 'DISAPPEARED';
  detectedAt: number;
  updatedAt: number;
  endedAt: number | null;
  lifetimeMs: number | null;
  qualifiedAt: number | null;
  timeToQualifiedMs: number | null;
  everQualified: boolean;
  currentQualificationReasons: QualificationReason[];
  initialGrossSpreadPercent: number;
  currentGrossSpreadPercent: number;
  peakGrossSpreadPercent: number;
  initialGrossSpreadAbsolute: number;
  currentGrossSpreadAbsolute: number;
  peakGrossSpreadAbsolute: number;
  initialEstimatedNetSpreadPercent: number;
  currentEstimatedNetSpreadPercent: number;
  peakEstimatedNetSpreadPercent: number;
  initialEstimatedNetPnlAbsolute: number;
  currentEstimatedNetPnlAbsolute: number;
  peakEstimatedNetPnlAbsolute: number;
  currentEstimatedTotalFee: number;
  targetBaseSize: number;
  buyAverageExecutionPrice: number | null;
  sellAverageExecutionPrice: number | null;
  buySlippagePercent: number | null;
  sellSlippagePercent: number | null;
  simulatedBuyNotional: number | null;
  simulatedSellNotional: number | null;
  currentTradableSize: number;
  peakTradableSize: number;
  currentReceiveTimeDifferenceMs: number;
  everActive: boolean;
  everInvalidSync: boolean;
}

interface TrackedOpportunity {
  event: OpportunityEvent;
  validObservations: number;
  validationStartedAt: number | null;
}

function eventKey(comparison: DepthComparison): string {
  return `${comparison.symbol}:${comparison.buyExchange}->${comparison.sellExchange}`;
}

function snapshot(event: OpportunityEvent): OpportunityEvent {
  return {
    ...event,
    currentQualificationReasons: [...event.currentQualificationReasons],
  };
}

function updateMetrics(
  event: OpportunityEvent,
  comparison: DepthComparison,
  qualification: OpportunityQualification,
  timestamp: number,
): void {
  event.updatedAt = timestamp;
  event.currentQualificationReasons = [...qualification.reasons];
  event.currentGrossSpreadPercent = comparison.bestGrossSpreadPercent;
  event.currentGrossSpreadAbsolute = comparison.bestGrossSpreadAbsolute;
  event.currentTradableSize = comparison.tradableSize;
  event.currentReceiveTimeDifferenceMs = comparison.receiveTimeDifferenceMs;
  event.peakGrossSpreadPercent = Math.max(
    event.peakGrossSpreadPercent,
    comparison.bestGrossSpreadPercent,
  );
  event.peakGrossSpreadAbsolute = Math.max(
    event.peakGrossSpreadAbsolute,
    comparison.bestGrossSpreadAbsolute,
  );
  if (
    comparison.estimatedNetSpreadPercent !== null &&
    comparison.estimatedNetPnlAbsolute !== null &&
    comparison.estimatedTotalFee !== null
  ) {
    event.currentEstimatedNetSpreadPercent = comparison.estimatedNetSpreadPercent;
    event.peakEstimatedNetSpreadPercent = Math.max(
      event.peakEstimatedNetSpreadPercent,
      comparison.estimatedNetSpreadPercent,
    );
    event.currentEstimatedNetPnlAbsolute = comparison.estimatedNetPnlAbsolute;
    event.peakEstimatedNetPnlAbsolute = Math.max(
      event.peakEstimatedNetPnlAbsolute,
      comparison.estimatedNetPnlAbsolute,
    );
    event.currentEstimatedTotalFee = comparison.estimatedTotalFee;
  }
  event.targetBaseSize = comparison.targetBaseSize;
  event.buyAverageExecutionPrice = comparison.buyExecution.averageExecutionPrice;
  event.sellAverageExecutionPrice = comparison.sellExecution.averageExecutionPrice;
  event.buySlippagePercent = comparison.buyExecution.slippagePercent;
  event.sellSlippagePercent = comparison.sellExecution.slippagePercent;
  event.simulatedBuyNotional = comparison.simulatedBuyNotional;
  event.simulatedSellNotional = comparison.simulatedSellNotional;
  event.peakTradableSize = Math.max(
    event.peakTradableSize,
    comparison.tradableSize,
  );
}

function createTrackedOpportunity(
  comparison: DepthComparison,
  qualification: OpportunityQualification,
  timestamp: number,
): TrackedOpportunity {
  if (
    !qualification.qualified ||
    comparison.estimatedNetSpreadPercent === null ||
    comparison.estimatedNetPnlAbsolute === null ||
    comparison.estimatedTotalFee === null
  ) {
    throw new Error('Qualified comparison is missing economic values.');
  }
  return {
    event: {
      id: randomUUID(),
      symbol: comparison.symbol,
      buyExchange: comparison.buyExchange,
      sellExchange: comparison.sellExchange,
      state: 'DETECTED',
      detectedAt: timestamp,
      updatedAt: timestamp,
      endedAt: null,
      lifetimeMs: null,
      qualifiedAt: null,
      timeToQualifiedMs: null,
      everQualified: false,
      currentQualificationReasons: [],
      initialGrossSpreadPercent: comparison.bestGrossSpreadPercent,
      currentGrossSpreadPercent: comparison.bestGrossSpreadPercent,
      peakGrossSpreadPercent: comparison.bestGrossSpreadPercent,
      initialGrossSpreadAbsolute: comparison.bestGrossSpreadAbsolute,
      currentGrossSpreadAbsolute: comparison.bestGrossSpreadAbsolute,
      peakGrossSpreadAbsolute: comparison.bestGrossSpreadAbsolute,
      initialEstimatedNetSpreadPercent: comparison.estimatedNetSpreadPercent,
      currentEstimatedNetSpreadPercent: comparison.estimatedNetSpreadPercent,
      peakEstimatedNetSpreadPercent: comparison.estimatedNetSpreadPercent,
      initialEstimatedNetPnlAbsolute: comparison.estimatedNetPnlAbsolute,
      currentEstimatedNetPnlAbsolute: comparison.estimatedNetPnlAbsolute,
      peakEstimatedNetPnlAbsolute: comparison.estimatedNetPnlAbsolute,
      currentEstimatedTotalFee: comparison.estimatedTotalFee,
      targetBaseSize: comparison.targetBaseSize,
      buyAverageExecutionPrice: comparison.buyExecution.averageExecutionPrice,
      sellAverageExecutionPrice: comparison.sellExecution.averageExecutionPrice,
      buySlippagePercent: comparison.buyExecution.slippagePercent,
      sellSlippagePercent: comparison.sellExecution.slippagePercent,
      simulatedBuyNotional: comparison.simulatedBuyNotional,
      simulatedSellNotional: comparison.simulatedSellNotional,
      currentTradableSize: comparison.tradableSize,
      peakTradableSize: comparison.tradableSize,
      currentReceiveTimeDifferenceMs: comparison.receiveTimeDifferenceMs,
      everActive: false,
      everInvalidSync: false,
    },
    validObservations: 1,
    validationStartedAt: timestamp,
  };
}

function resetValidationWindow(
  tracked: TrackedOpportunity,
  comparison: DepthComparison,
  timestamp: number,
): void {
  tracked.validationStartedAt = timestamp;
  tracked.validObservations = 1;
  if (!tracked.event.everQualified) {
    tracked.event.detectedAt = timestamp;
    tracked.event.initialGrossSpreadPercent = comparison.bestGrossSpreadPercent;
    tracked.event.initialGrossSpreadAbsolute = comparison.bestGrossSpreadAbsolute;
    tracked.event.initialEstimatedNetSpreadPercent =
      comparison.estimatedNetSpreadPercent ?? 0;
    tracked.event.initialEstimatedNetPnlAbsolute =
      comparison.estimatedNetPnlAbsolute ?? 0;
  }
}

export class OpportunityTracker {
  private readonly activeEvents = new Map<string, TrackedOpportunity>();

  constructor(
    private readonly qualityConfig: OpportunityQualityConfig =
      OPPORTUNITY_QUALITY_CONFIG,
  ) {}

  getOpenEventCount(): number {
    return this.activeEvents.size;
  }

  process(
    comparison: DepthComparison,
    timestamp: number,
    qualification = qualifyOpportunity(comparison, this.qualityConfig),
  ): OpportunityEvent | null {
    const key = eventKey(comparison);
    const tracked = this.activeEvents.get(key);

    if (!qualification.qualified) {
      if (tracked === undefined) {
        return null;
      }

      updateMetrics(tracked.event, comparison, qualification, timestamp);
      if (qualification.reasons.includes('STALE')) {
        tracked.validObservations = 0;
        tracked.validationStartedAt = null;
        if (tracked.event.state === 'INVALID_SYNC') {
          return null;
        }
        tracked.event.state = 'INVALID_SYNC';
        tracked.event.everInvalidSync = true;
        return snapshot(tracked.event);
      }

      tracked.event.state = 'DISAPPEARED';
      tracked.event.endedAt = timestamp;
      tracked.event.lifetimeMs = timestamp - tracked.event.detectedAt;
      this.activeEvents.delete(key);
      return snapshot(tracked.event);
    }

    if (tracked === undefined) {
      const created = createTrackedOpportunity(
        comparison,
        qualification,
        timestamp,
      );
      this.activeEvents.set(key, created);
      return snapshot(created.event);
    }

    updateMetrics(tracked.event, comparison, qualification, timestamp);
    if (tracked.validationStartedAt === null) {
      resetValidationWindow(tracked, comparison, timestamp);
      tracked.event.state = 'DETECTED';
      return snapshot(tracked.event);
    }

    tracked.validObservations += 1;
    const elapsedMs = timestamp - tracked.validationStartedAt;
    const nextState: OpportunityEvent['state'] =
      tracked.validObservations >= 2 &&
      elapsedMs >= qualification.requiredActiveDurationMs
        ? 'QUALIFIED'
        : 'VALIDATING';

    if (nextState === 'QUALIFIED' && !tracked.event.everQualified) {
      tracked.event.qualifiedAt = timestamp;
      tracked.event.timeToQualifiedMs = timestamp - tracked.event.detectedAt;
      tracked.event.everQualified = true;
      // Retained for compatibility with Phase 1/2 event metrics.
      tracked.event.everActive = true;
    }
    if (tracked.event.state === nextState) {
      return null;
    }
    tracked.event.state = nextState;
    return snapshot(tracked.event);
  }
}
