import { assessSynchronization } from '../timing/sync-model.js';
import { DETERMINISTIC_HEALTHY_CLOCK } from '../timing/clock-health.js';
import { SourceClockOffsetEstimator } from '../timing/source-clock-offset.js';
import { TIMING_CONFIG } from '../config/timing.js';
import type { Exchange } from '../private-read/types.js';
import type { ShadowInput, ShadowVenueInput } from './shadow-types.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import { ShadowRuntime } from './shadow-runtime.js';

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;

// Synthetic normalized inputs only. No host clock or real account dependency.
export function shadowFixture(observedRate = 0.0001, sellPrice = 100.15, at = 1_700_000_000_000): Mutable<ShadowInput> {
  function account(exchange: Exchange): Mutable<ShadowVenueInput> {
    return { balance: { exchange, receivedAt: at, sourceUpdatedAt: null,
      btc: { total: 2, available: 2 }, usdt: { total: 2000, available: 2000 } }, balanceHealthy: true,
      fee: { exchange, symbol: 'BTC/USDT', source: 'ACCOUNT_PRIVATE_READ', receivedAt: at, sourceUpdatedAt: null,
        makerFeeRate: { rawRate: String(exchange === 'okx' ? -observedRate : observedRate), normalizedCostRate: observedRate },
        takerFeeRate: { rawRate: String(exchange === 'okx' ? -observedRate : observedRate), normalizedCostRate: observedRate } }, feeHealthy: true,
      compatibility: { value: { exchange, status: 'COMPATIBLE', reasons: [] }, healthy: true, receivedAt: at },
      permission: { value: { exchange, status: 'SAFE_READ_ONLY', reasons: [], checkedAt: at }, healthy: true, receivedAt: at } };
  }
  function book(exchange: Exchange, bid: number, ask: number): NormalizedOrderBook {
    return { exchange, symbol: 'BTC/USDT', receivedTimestamp: at, exchangeTimestamp: at - 10, matchingEngineTimestamp: null,
      bids: [{ price: bid, size: 1 }], asks: [{ price: ask, size: 1 }] };
  }
  const books = { bybit: book('bybit', 99.99, 100), okx: book('okx', sellPrice, sellPrice + 0.01) };
  const estimator = new SourceClockOffsetEstimator();
  for (let i = 0; i < TIMING_CONFIG.minOffsetSamples; i++) estimator.observe(at - 10, at);
  const stable = estimator.observe(at - 10, at);
  return { evaluatedAt: at, books, accounts: { bybit: account('bybit'), okx: account('okx') },
    sync: assessSynchronization(books.bybit, books.okx, at, DETERMINISTIC_HEALTHY_CLOCK, TIMING_CONFIG, { bybit: stable, okx: stable }) };
}
export function runShadowFixture() {
  const runtime = new ShadowRuntime(true);
  const assessments = [shadowFixture(), shadowFixture(0.003, 100.3, 1_700_000_000_100)].map(input => runtime.evaluate(input));
  return { assessments, metrics: runtime.getMetrics() };
}
