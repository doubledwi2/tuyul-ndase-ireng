import assert from 'node:assert/strict';
import test from 'node:test';

import { FEES, type FeeConfig } from '../config/fees.js';
import type { NormalizedOrderBook, OrderBookLevel } from '../types/orderbook.js';
import { compareOrderBooks } from './depth-comparator.js';

const NOW = 10_000;
const ZERO_FEES: FeeConfig = {
  bybit: { takerRate: 0 },
  okx: { takerRate: 0 },
};

function book(
  exchange: 'bybit' | 'okx',
  bids: OrderBookLevel[],
  asks: OrderBookLevel[],
  receivedTimestamp = NOW,
): NormalizedOrderBook {
  return {
    exchange,
    symbol: 'BTC/USDT',
    bids,
    asks,
    exchangeTimestamp: receivedTimestamp,
    matchingEngineTimestamp: null,
    receivedTimestamp,
  };
}

test('best prices can look positive while depth makes simulated net negative', () => {
  const comparisons = compareOrderBooks(
    book('bybit', [{ price: 99, size: 1 }], [
      { price: 100, size: 0.1 },
      { price: 102, size: 0.1 },
    ]),
    book('okx', [{ price: 101, size: 1 }], [{ price: 103, size: 1 }]),
    0.2,
    ZERO_FEES,
    NOW,
  );
  assert.ok(comparisons);
  assert.equal(comparisons[0].bestGrossSpreadAbsolute, 1);
  assert.ok(
    comparisons[0].buyExecution.averageExecutionPrice !== null &&
      Math.abs(comparisons[0].buyExecution.averageExecutionPrice - 101) < 1e-12,
  );
  assert.ok(Math.abs(comparisons[0].estimatedNetPnlAbsolute ?? 1) < 1e-12);
  assert.equal(comparisons[0].status, 'EXECUTABLE_NET_ZERO_OR_NEGATIVE');
});

test('enough depth fully fills both legs and can produce positive simulated net', () => {
  const comparisons = compareOrderBooks(
    book('bybit', [{ price: 99, size: 1 }], [{ price: 100, size: 1 }]),
    book('okx', [{ price: 102, size: 1 }], [{ price: 103, size: 1 }]),
    0.5,
    ZERO_FEES,
    NOW,
  );
  assert.ok(comparisons);
  assert.equal(comparisons[0].buyExecution.fullyFilled, true);
  assert.equal(comparisons[0].sellExecution.fullyFilled, true);
  assert.equal(comparisons[0].grossPnlAbsolute, 1);
  assert.equal(comparisons[0].estimatedNetPnlAbsolute, 1);
  assert.equal(comparisons[0].status, 'EXECUTABLE_NET_POSITIVE');
});

test('insufficient liquidity returns INSUFFICIENT_DEPTH without economic result', () => {
  const comparisons = compareOrderBooks(
    book('bybit', [{ price: 99, size: 1 }], [{ price: 100, size: 0.1 }]),
    book('okx', [{ price: 102, size: 1 }], [{ price: 103, size: 1 }]),
    0.5,
    ZERO_FEES,
    NOW,
  );
  assert.ok(comparisons);
  assert.equal(comparisons[0].status, 'INSUFFICIENT_DEPTH');
  assert.equal(comparisons[0].estimatedNetPnlAbsolute, null);
  assert.equal(comparisons[0].simulatedBuyNotional, null);
});

test('fees use simulated buy and sell notionals', () => {
  const comparisons = compareOrderBooks(
    book('bybit', [{ price: 99, size: 1 }], [{ price: 100, size: 1 }]),
    book('okx', [{ price: 101, size: 1 }], [{ price: 102, size: 1 }]),
    0.2,
    FEES,
    NOW,
  );
  assert.ok(comparisons);
  assert.equal(comparisons[0].simulatedBuyNotional, 20);
  assert.ok(
    comparisons[0].simulatedSellNotional !== null &&
      Math.abs(comparisons[0].simulatedSellNotional - 20.2) < 1e-12,
  );
  assert.equal(comparisons[0].estimatedBuyFee, 0.02);
  assert.ok(
    comparisons[0].estimatedSellFee !== null &&
      Math.abs(comparisons[0].estimatedSellFee - 0.0202) < 1e-12,
  );
  assert.ok(
    comparisons[0].estimatedNetPnlAbsolute !== null &&
      comparisons[0].estimatedNetPnlAbsolute > 0,
  );
});

test('fees can make a fully-filled simulated result negative', () => {
  const comparisons = compareOrderBooks(
    book('bybit', [{ price: 99, size: 1 }], [{ price: 100, size: 1 }]),
    book('okx', [{ price: 100.1, size: 1 }], [{ price: 101, size: 1 }]),
    0.2,
    FEES,
    NOW,
  );
  assert.ok(comparisons);
  assert.ok((comparisons[0].estimatedNetPnlAbsolute ?? 0) < 0);
  assert.equal(comparisons[0].status, 'EXECUTABLE_NET_ZERO_OR_NEGATIVE');
});

test('STALE overrides otherwise positive economic status', () => {
  const comparisons = compareOrderBooks(
    book('bybit', [{ price: 99, size: 1 }], [{ price: 100, size: 1 }], NOW),
    book('okx', [{ price: 102, size: 1 }], [{ price: 103, size: 1 }], NOW - 251),
    0.2,
    ZERO_FEES,
    NOW,
  );
  assert.ok(comparisons);
  assert.ok((comparisons[0].estimatedNetPnlAbsolute ?? 0) > 0);
  assert.equal(comparisons[0].status, 'STALE');
});
