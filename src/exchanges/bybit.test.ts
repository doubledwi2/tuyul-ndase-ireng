import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBybitMessage } from './bybit.js';

const RECEIVED_TIMESTAMP = 1_700_000_000_999;

function payload(
  bid: [string, string] = ['100.10', '1.25'],
  ask: [string, string] = ['100.20', '0.75'],
): string {
  return JSON.stringify({
    topic: 'orderbook.1.BTCUSDT',
    type: 'snapshot',
    ts: 1_700_000_000_100,
    data: {
      s: 'BTCUSDT',
      b: [bid],
      a: [ask],
      u: 123,
      seq: 456,
    },
    cts: 1_700_000_000_098,
  });
}

test('normalizes a valid Bybit level 1 quote', () => {
  assert.deepEqual(parseBybitMessage(payload(), RECEIVED_TIMESTAMP), {
    exchange: 'bybit',
    symbol: 'BTC/USDT',
    bid: 100.1,
    bidSize: 1.25,
    ask: 100.2,
    askSize: 0.75,
    exchangeTimestamp: 1_700_000_000_100,
    matchingEngineTimestamp: 1_700_000_000_098,
    receivedTimestamp: RECEIVED_TIMESTAMP,
  });
});

test('ignores malformed Bybit payloads', () => {
  assert.equal(parseBybitMessage('{not-json', RECEIVED_TIMESTAMP), null);
  assert.equal(parseBybitMessage('{}', RECEIVED_TIMESTAMP), null);
});

test('ignores Bybit quotes with zero or invalid prices', () => {
  assert.equal(
    parseBybitMessage(payload(['0', '1.25']), RECEIVED_TIMESTAMP),
    null,
  );
  assert.equal(
    parseBybitMessage(payload(['invalid', '1.25']), RECEIVED_TIMESTAMP),
    null,
  );
});

test('ignores Bybit quotes with zero or invalid sizes', () => {
  assert.equal(
    parseBybitMessage(payload(['100.10', '0']), RECEIVED_TIMESTAMP),
    null,
  );
  assert.equal(
    parseBybitMessage(payload(['100.10', 'invalid']), RECEIVED_TIMESTAMP),
    null,
  );
});

test('ignores a crossed Bybit quote', () => {
  assert.equal(
    parseBybitMessage(
      payload(['100.30', '1.25'], ['100.20', '0.75']),
      RECEIVED_TIMESTAMP,
    ),
    null,
  );
});
