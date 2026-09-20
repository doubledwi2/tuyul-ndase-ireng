import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareQuotes,
  MAX_QUOTE_AGE_MS,
  MAX_RECEIVE_DIFF_MS,
} from './comparator.js';
import type { BestQuote } from '../types/market.js';

const NOW = 1_700_000_001_000;

function quote(
  exchange: BestQuote['exchange'],
  overrides: Partial<BestQuote> = {},
): BestQuote {
  return {
    exchange,
    symbol: 'BTC/USDT',
    bid: exchange === 'bybit' ? 99 : 101,
    bidSize: exchange === 'bybit' ? 0.8 : 0.4,
    ask: exchange === 'bybit' ? 100 : 102,
    askSize: exchange === 'bybit' ? 0.5 : 0.3,
    exchangeTimestamp: null,
    matchingEngineTimestamp: null,
    receivedTimestamp: NOW - 100,
    ...overrides,
  };
}

test('calculates positive and negative gross spreads in both directions', () => {
  const comparisons = compareQuotes(quote('bybit'), quote('okx'), NOW);

  assert.ok(comparisons);
  assert.equal(comparisons[0].grossSpreadAbsolute, 1);
  assert.equal(comparisons[1].grossSpreadAbsolute, -3);
});

test('calculates gross spread percentage from the buy price', () => {
  const comparisons = compareQuotes(quote('bybit'), quote('okx'), NOW);

  assert.ok(comparisons);
  assert.equal(comparisons[0].grossSpreadPercent, 1);
  assert.ok(Math.abs(comparisons[1].grossSpreadPercent - (-3 / 102) * 100) < 1e-12);
});

test('uses the minimum top-level size as tradable size', () => {
  const comparisons = compareQuotes(quote('bybit'), quote('okx'), NOW);

  assert.ok(comparisons);
  assert.equal(comparisons[0].tradableSize, 0.4);
  assert.equal(comparisons[1].tradableSize, 0.3);
});

test('marks quotes within the receive-time threshold as SYNC_OK', () => {
  const comparisons = compareQuotes(
    quote('bybit', { receivedTimestamp: NOW - 200 }),
    quote('okx', { receivedTimestamp: NOW - 200 - MAX_RECEIVE_DIFF_MS }),
    NOW,
  );

  assert.ok(comparisons);
  assert.equal(comparisons[0].receiveTimeDifferenceMs, MAX_RECEIVE_DIFF_MS);
  assert.equal(comparisons[0].status, 'SYNC_OK');
  assert.equal(comparisons[1].status, 'SYNC_OK');
});

test('marks quotes beyond the receive-time threshold as STALE', () => {
  const comparisons = compareQuotes(
    quote('bybit', { receivedTimestamp: NOW - 100 }),
    quote('okx', {
      receivedTimestamp: NOW - 100 - MAX_RECEIVE_DIFF_MS - 1,
    }),
    NOW,
  );

  assert.ok(comparisons);
  assert.equal(comparisons[0].status, 'STALE');
  assert.equal(comparisons[1].status, 'STALE');
});

test('marks a comparison STALE when either quote is too old', () => {
  const comparisons = compareQuotes(
    quote('bybit', { receivedTimestamp: NOW - MAX_QUOTE_AGE_MS - 1 }),
    quote('okx', { receivedTimestamp: NOW - MAX_QUOTE_AGE_MS - 1 }),
    NOW,
  );

  assert.ok(comparisons);
  assert.equal(comparisons[0].receiveTimeDifferenceMs, 0);
  assert.equal(comparisons[0].status, 'STALE');
  assert.equal(comparisons[1].status, 'STALE');
});

test('does not compare until both quotes are available and valid', () => {
  assert.equal(compareQuotes(quote('bybit'), undefined, NOW), null);
  assert.equal(
    compareQuotes(quote('bybit', { askSize: 0 }), quote('okx'), NOW),
    null,
  );
});
