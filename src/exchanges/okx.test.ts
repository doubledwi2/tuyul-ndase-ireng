import assert from 'node:assert/strict';
import test from 'node:test';

import { OkxOrderBookState } from './okx.js';

const RECEIVED = 1_700_000_000_999;

function message(
  action: 'snapshot' | 'update',
  bids: string[][],
  asks: string[][],
  previousSequenceId: number,
  sequenceId: number,
): string {
  return JSON.stringify({
    arg: { channel: 'books', instId: 'BTC-USDT' },
    action,
    data: [{
      bids: bids.map((level) => [...level, '0', '1']),
      asks: asks.map((level) => [...level, '0', '1']),
      ts: '1700000000100',
      prevSeqId: previousSequenceId,
      seqId: sequenceId,
      checksum: 0,
    }],
  });
}

test('OKX snapshot builds a sorted normalized book with correct top levels', () => {
  const state = new OkxOrderBookState();
  const result = state.applyMessage(
    message(
      'snapshot',
      [['99', '2'], ['100', '1']],
      [['102', '3'], ['101', '4']],
      -1,
      10,
    ),
    RECEIVED,
  );

  assert.equal(result.sequenceGap, false);
  assert.deepEqual(result.orderBook?.bids, [
    { price: 100, size: 1 },
    { price: 99, size: 2 },
  ]);
  assert.deepEqual(result.orderBook?.asks, [
    { price: 101, size: 4 },
    { price: 102, size: 3 },
  ]);
  assert.equal(result.orderBook?.matchingEngineTimestamp, null);
});

test('OKX delta updates, inserts, and removes price levels', () => {
  const state = new OkxOrderBookState();
  state.applyMessage(
    message('snapshot', [['100', '1'], ['99', '2']], [['101', '1']], -1, 10),
    RECEIVED,
  );
  const result = state.applyMessage(
    message(
      'update',
      [['100', '5'], ['100.5', '3'], ['99', '0']],
      [['101.5', '2']],
      10,
      11,
    ),
    RECEIVED + 1,
  );

  assert.deepEqual(result.orderBook?.bids, [
    { price: 100.5, size: 3 },
    { price: 100, size: 5 },
  ]);
  assert.deepEqual(result.orderBook?.asks, [
    { price: 101, size: 1 },
    { price: 101.5, size: 2 },
  ]);
});

test('OKX ignores malformed update safely and retains local state', () => {
  const state = new OkxOrderBookState();
  state.applyMessage(
    message('snapshot', [['100', '1']], [['101', '1']], -1, 10),
    RECEIVED,
  );
  const malformed = state.applyMessage(
    message('update', [['bad', '2']], [], 10, 11),
    RECEIVED + 1,
  );
  assert.equal(malformed.orderBook, null);
  assert.equal(malformed.sequenceGap, false);
  const valid = state.applyMessage(
    message('update', [['100', '2']], [], 10, 12),
    RECEIVED + 2,
  );
  assert.equal(valid.orderBook?.bids[0]?.size, 2);
});

test('OKX detects a sequence gap and requires a new snapshot', () => {
  const state = new OkxOrderBookState();
  state.applyMessage(
    message('snapshot', [['100', '1']], [['101', '1']], -1, 10),
    RECEIVED,
  );
  const gap = state.applyMessage(
    message('update', [['100', '2']], [], 9, 11),
    RECEIVED + 1,
  );
  assert.equal(gap.sequenceGap, true);
  assert.equal(
    state.applyMessage(
      message('update', [['100', '3']], [], 11, 12),
      RECEIVED + 2,
    ).orderBook,
    null,
  );
});
