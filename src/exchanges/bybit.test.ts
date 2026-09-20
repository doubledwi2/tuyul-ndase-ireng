import assert from 'node:assert/strict';
import test from 'node:test';

import { BybitOrderBookState } from './bybit.js';

const RECEIVED = 1_700_000_000_999;

function message(
  type: 'snapshot' | 'delta',
  bids: string[][],
  asks: string[][],
  updateId: number,
): string {
  return JSON.stringify({
    topic: 'orderbook.50.BTCUSDT',
    type,
    ts: 1_700_000_000_100 + updateId,
    data: { s: 'BTCUSDT', b: bids, a: asks, u: updateId, seq: updateId * 10 },
    cts: 1_700_000_000_098 + updateId,
  });
}

test('Bybit snapshot builds a sorted normalized book with correct top levels', () => {
  const state = new BybitOrderBookState();
  const book = state.applyMessage(
    message(
      'snapshot',
      [['99', '2'], ['100', '1']],
      [['102', '3'], ['101', '4']],
      10,
    ),
    RECEIVED,
  );

  assert.deepEqual(book?.bids, [
    { price: 100, size: 1 },
    { price: 99, size: 2 },
  ]);
  assert.deepEqual(book?.asks, [
    { price: 101, size: 4 },
    { price: 102, size: 3 },
  ]);
  assert.equal(book?.bids[0]?.price, 100);
  assert.equal(book?.asks[0]?.price, 101);
});

test('Bybit delta updates, inserts, and removes price levels', () => {
  const state = new BybitOrderBookState();
  state.applyMessage(
    message('snapshot', [['100', '1'], ['99', '2']], [['101', '1']], 10),
    RECEIVED,
  );
  const book = state.applyMessage(
    message(
      'delta',
      [['100', '5'], ['100.5', '3'], ['99', '0']],
      [['101.5', '2']],
      11,
    ),
    RECEIVED + 1,
  );

  assert.deepEqual(book?.bids, [
    { price: 100.5, size: 3 },
    { price: 100, size: 5 },
  ]);
  assert.deepEqual(book?.asks, [
    { price: 101, size: 1 },
    { price: 101.5, size: 2 },
  ]);
});

test('Bybit ignores malformed updates without corrupting local state', () => {
  const state = new BybitOrderBookState();
  state.applyMessage(
    message('snapshot', [['100', '1']], [['101', '1']], 10),
    RECEIVED,
  );
  assert.equal(
    state.applyMessage(
      message('delta', [['bad', '2']], [], 11),
      RECEIVED + 1,
    ),
    null,
  );
  const book = state.applyMessage(
    message('delta', [['100', '2']], [], 12),
    RECEIVED + 2,
  );
  assert.equal(book?.bids[0]?.size, 2);
});

test('Bybit ignores a delta received before the initial snapshot', () => {
  const state = new BybitOrderBookState();
  assert.equal(
    state.applyMessage(
      message('delta', [['100', '1']], [['101', '1']], 10),
      RECEIVED,
    ),
    null,
  );
});
