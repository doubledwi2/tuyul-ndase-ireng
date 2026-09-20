import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedOrderBook, OrderBookLevel } from '../types/orderbook.js';
import { simulateExecution } from './execution-simulator.js';

function book(
  bids: OrderBookLevel[] = [{ price: 99, size: 1 }],
  asks: OrderBookLevel[] = [{ price: 100, size: 1 }],
): NormalizedOrderBook {
  return {
    exchange: 'bybit',
    symbol: 'BTC/USDT',
    bids,
    asks,
    exchangeTimestamp: null,
    matchingEngineTimestamp: null,
    receivedTimestamp: 1_000,
  };
}

test('BUY single-level full fill calculates notional and zero slippage', () => {
  const result = simulateExecution(book(), 'BUY', 0.2);
  assert.equal(result.fullyFilled, true);
  assert.equal(result.filledSize, 0.2);
  assert.equal(result.notional, 20);
  assert.equal(result.averageExecutionPrice, 100);
  assert.equal(result.slippagePercent, 0);
});

test('BUY multi-level fill calculates VWAP, notional, and slippage', () => {
  const result = simulateExecution(
    book(
      [{ price: 99, size: 1 }],
      [{ price: 100, size: 0.1 }, { price: 101, size: 0.2 }],
    ),
    'BUY',
    0.2,
  );
  assert.ok(Math.abs(result.notional - 20.1) < 1e-12);
  assert.ok(
    result.averageExecutionPrice !== null &&
      Math.abs(result.averageExecutionPrice - 100.5) < 1e-12,
  );
  assert.ok(
    result.slippagePercent !== null &&
      Math.abs(result.slippagePercent - 0.5) < 1e-12,
  );
});

test('BUY reports a partial fill and unfilled size', () => {
  const result = simulateExecution(
    book(
      [{ price: 99, size: 1 }],
      [{ price: 100, size: 0.1 }, { price: 101, size: 0.2 }],
    ),
    'BUY',
    0.5,
  );
  assert.equal(result.fullyFilled, false);
  assert.ok(Math.abs(result.filledSize - 0.3) < 1e-12);
  assert.ok(Math.abs(result.unfilledSize - 0.2) < 1e-12);
});

test('SELL single-level full fill calculates notional and zero slippage', () => {
  const result = simulateExecution(book(), 'SELL', 0.2);
  assert.equal(result.fullyFilled, true);
  assert.equal(result.notional, 19.8);
  assert.equal(result.averageExecutionPrice, 99);
  assert.equal(result.slippagePercent, 0);
});

test('SELL multi-level fill calculates negative slippage from best bid', () => {
  const result = simulateExecution(
    book(
      [{ price: 100, size: 0.1 }, { price: 99, size: 0.2 }],
      [{ price: 101, size: 1 }],
    ),
    'SELL',
    0.2,
  );
  assert.ok(Math.abs(result.notional - 19.9) < 1e-12);
  assert.ok(
    result.averageExecutionPrice !== null &&
      Math.abs(result.averageExecutionPrice - 99.5) < 1e-12,
  );
  assert.ok(
    result.slippagePercent !== null &&
      Math.abs(result.slippagePercent - -0.5) < 1e-12,
  );
});

test('SELL reports a partial fill', () => {
  const result = simulateExecution(
    book(
      [{ price: 100, size: 0.1 }, { price: 99, size: 0.2 }],
      [{ price: 101, size: 1 }],
    ),
    'SELL',
    0.5,
  );
  assert.equal(result.fullyFilled, false);
  assert.ok(Math.abs(result.filledSize - 0.3) < 1e-12);
});

test('rejects invalid requested size and invalid normalized levels', () => {
  assert.throws(() => simulateExecution(book(), 'BUY', 0), RangeError);
  assert.throws(() => simulateExecution(book(), 'SELL', -1), RangeError);
  assert.throws(
    () => simulateExecution(
      book([{ price: 99, size: 0 }], [{ price: 100, size: 1 }]),
      'SELL',
      0.1,
    ),
    RangeError,
  );
});

test('requires deterministic normalized level ordering', () => {
  const unsorted = book(
    [{ price: 99, size: 1 }, { price: 100, size: 1 }],
    [{ price: 101, size: 1 }],
  );
  assert.throws(() => simulateExecution(unsorted, 'SELL', 0.1), RangeError);
  assert.deepEqual(simulateExecution(book(), 'BUY', 0.1), simulateExecution(book(), 'BUY', 0.1));
});
