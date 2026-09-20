import { randomUUID } from 'node:crypto';

import type { SpreadComparison } from './comparator.js';

export const MIN_GROSS_SPREAD_PERCENT = 0;

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
  currentTradableSize: number;
  peakTradableSize: number;
  currentReceiveTimeDifferenceMs: number;
}

interface TrackedOpportunity {
  event: OpportunityEvent;
  consecutiveValidObservations: number;
}

function eventKey(comparison: SpreadComparison): string {
  return `${comparison.symbol}:${comparison.buyExchange}->${comparison.sellExchange}`;
}

function snapshot(event: OpportunityEvent): OpportunityEvent {
  return { ...event };
}

function updateMetrics(
  event: OpportunityEvent,
  comparison: SpreadComparison,
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
  event.peakTradableSize = Math.max(
    event.peakTradableSize,
    comparison.tradableSize,
  );
}

function initialState(comparison: SpreadComparison): OpportunityEvent['state'] {
  return comparison.status === 'SYNC_OK' ? 'DETECTED' : 'INVALID_SYNC';
}

function createTrackedOpportunity(
  comparison: SpreadComparison,
  timestamp: number,
): TrackedOpportunity {
  const state = initialState(comparison);

  return {
    event: {
      id: randomUUID(),
      symbol: comparison.symbol,
      buyExchange: comparison.buyExchange,
      sellExchange: comparison.sellExchange,
      state,
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
      currentTradableSize: comparison.tradableSize,
      peakTradableSize: comparison.tradableSize,
      currentReceiveTimeDifferenceMs: comparison.receiveTimeDifferenceMs,
    },
    consecutiveValidObservations: state === 'DETECTED' ? 1 : 0,
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

  process(
    comparison: SpreadComparison,
    timestamp: number,
  ): OpportunityEvent | null {
    const key = eventKey(comparison);
    const tracked = this.activeEvents.get(key);

    if (comparison.grossSpreadPercent <= MIN_GROSS_SPREAD_PERCENT) {
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

    if (tracked === undefined) {
      const created = createTrackedOpportunity(comparison, timestamp);
      this.activeEvents.set(key, created);
      return snapshot(created.event);
    }

    updateMetrics(tracked.event, comparison, timestamp);

    if (comparison.status === 'STALE') {
      tracked.consecutiveValidObservations = 0;
      if (tracked.event.state === 'INVALID_SYNC') {
        return null;
      }

      tracked.event.state = 'INVALID_SYNC';
      return snapshot(tracked.event);
    }

    tracked.consecutiveValidObservations += 1;
    const nextState = stateForValidObservation(
      tracked.consecutiveValidObservations,
    );
    if (tracked.event.state === nextState) {
      return null;
    }

    tracked.event.state = nextState;
    return snapshot(tracked.event);
  }
}
