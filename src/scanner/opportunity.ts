import { randomUUID } from 'node:crypto';

import type { FeeAwareComparison } from './fee-model.js';

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

function eventKey(comparison: FeeAwareComparison): string {
  return `${comparison.symbol}:${comparison.buyExchange}->${comparison.sellExchange}`;
}

function snapshot(event: OpportunityEvent): OpportunityEvent {
  return { ...event };
}

function updateMetrics(
  event: OpportunityEvent,
  comparison: FeeAwareComparison,
  timestamp: number,
): void {
  event.updatedAt = timestamp;
  event.currentGrossSpreadPercent = comparison.grossSpreadPercent;
  event.currentGrossSpreadAbsolute = comparison.grossSpreadAbsolute;
  event.currentTradableSize = comparison.tradableSize;
  event.currentReceiveTimeDifferenceMs = comparison.receiveTimeDifferenceMs;
  event.peakGrossSpreadPercent = Math.max(
    event.peakGrossSpreadPercent,
    comparison.grossSpreadPercent,
  );
  event.peakGrossSpreadAbsolute = Math.max(
    event.peakGrossSpreadAbsolute,
    comparison.grossSpreadAbsolute,
  );
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
  event.peakTradableSize = Math.max(
    event.peakTradableSize,
    comparison.tradableSize,
  );
}

function createTrackedOpportunity(
  comparison: FeeAwareComparison,
  timestamp: number,
): TrackedOpportunity {
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
      initialGrossSpreadPercent: comparison.grossSpreadPercent,
      currentGrossSpreadPercent: comparison.grossSpreadPercent,
      peakGrossSpreadPercent: comparison.grossSpreadPercent,
      initialGrossSpreadAbsolute: comparison.grossSpreadAbsolute,
      currentGrossSpreadAbsolute: comparison.grossSpreadAbsolute,
      peakGrossSpreadAbsolute: comparison.grossSpreadAbsolute,
      initialEstimatedNetSpreadPercent: comparison.estimatedNetSpreadPercent,
      currentEstimatedNetSpreadPercent: comparison.estimatedNetSpreadPercent,
      peakEstimatedNetSpreadPercent: comparison.estimatedNetSpreadPercent,
      initialEstimatedNetPnlAbsolute: comparison.estimatedNetPnlAbsolute,
      currentEstimatedNetPnlAbsolute: comparison.estimatedNetPnlAbsolute,
      peakEstimatedNetPnlAbsolute: comparison.estimatedNetPnlAbsolute,
      currentEstimatedTotalFee: comparison.estimatedTotalFee,
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
    comparison: FeeAwareComparison,
    timestamp: number,
  ): OpportunityEvent | null {
    const key = eventKey(comparison);
    const tracked = this.activeEvents.get(key);

    if (comparison.estimatedNetPnlAbsolute <= 0) {
      if (tracked === undefined) {
        return null;
      }

      updateMetrics(tracked.event, comparison, timestamp);
      tracked.event.state = 'DISAPPEARED';
      tracked.event.endedAt = timestamp;
      tracked.event.lifetimeMs = timestamp - tracked.event.detectedAt;
      this.activeEvents.delete(key);
      return snapshot(tracked.event);
    }

    if (comparison.status === 'STALE') {
      if (tracked === undefined) {
        return null;
      }

      updateMetrics(tracked.event, comparison, timestamp);
      tracked.consecutiveValidObservations = 0;
      if (tracked.event.state === 'INVALID_SYNC') {
        return null;
      }

      tracked.event.state = 'INVALID_SYNC';
      tracked.event.everInvalidSync = true;
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
