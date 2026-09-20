import { randomUUID } from 'node:crypto';

import type { DepthComparison } from './depth-comparator.js';

export interface OpportunityEvent {
  id: string;
  symbol: 'BTC/USDT';
  buyExchange: 'bybit' | 'okx';
  sellExchange: 'bybit' | 'okx';
  state:
    | 'DETECTED'
    | 'VALIDATING'
    | 'ACTIVE'
    | 'INVALID_SYNC'
    | 'DISAPPEARED';
  detectedAt: number;
  updatedAt: number;
  endedAt: number | null;
  lifetimeMs: number | null;
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
  consecutiveValidObservations: number;
}

function eventKey(comparison: DepthComparison): string {
  return `${comparison.symbol}:${comparison.buyExchange}->${comparison.sellExchange}`;
}

function snapshot(event: OpportunityEvent): OpportunityEvent {
  return { ...event };
}

function updateMetrics(
  event: OpportunityEvent,
  comparison: DepthComparison,
  timestamp: number,
): void {
  event.updatedAt = timestamp;
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
    event.currentEstimatedNetSpreadPercent =
      comparison.estimatedNetSpreadPercent;
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
  timestamp: number,
): TrackedOpportunity {
  if (
    comparison.estimatedNetSpreadPercent === null ||
    comparison.estimatedNetPnlAbsolute === null ||
    comparison.estimatedTotalFee === null
  ) {
    throw new Error('Net-positive comparison is missing economic values.');
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
    consecutiveValidObservations: 1,
  };
}

function stateForValidObservation(count: number): OpportunityEvent['state'] {
  if (count === 1) {
    return 'DETECTED';
  }
  if (count === 2) {
    return 'VALIDATING';
  }
  return 'ACTIVE';
}

export class OpportunityTracker {
  private readonly activeEvents = new Map<string, TrackedOpportunity>();

  getOpenEventCount(): number {
    return this.activeEvents.size;
  }

  process(
    comparison: DepthComparison,
    timestamp: number,
  ): OpportunityEvent | null {
    const key = eventKey(comparison);
    const tracked = this.activeEvents.get(key);

    if (comparison.status !== 'EXECUTABLE_NET_POSITIVE') {
      if (tracked === undefined) {
        return null;
      }

      updateMetrics(tracked.event, comparison, timestamp);
      if (comparison.status === 'STALE') {
        tracked.consecutiveValidObservations = 0;
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
      const created = createTrackedOpportunity(comparison, timestamp);
      this.activeEvents.set(key, created);
      return snapshot(created.event);
    }

    updateMetrics(tracked.event, comparison, timestamp);

    tracked.consecutiveValidObservations += 1;
    const nextState = stateForValidObservation(
      tracked.consecutiveValidObservations,
    );
    if (tracked.event.state === nextState) {
      return null;
    }

    tracked.event.state = nextState;
    if (nextState === 'ACTIVE') {
      tracked.event.everActive = true;
    }
    return snapshot(tracked.event);
  }
}
