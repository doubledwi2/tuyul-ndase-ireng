import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOkxMessage } from './okx.js';

const RECEIVED_TIMESTAMP = 1_700_000_000_999;

function payload(
  bid: [string, string] = ['100.10', '1.25'],
  ask: [string, string] = ['100.20', '0.75'],
): string {
  return JSON.stringify({
    arg: {
      channel: 'bbo-tbt',
      instId: 'BTC-USDT',
    },
    data: [
      {
        bids: [[...bid, '0', '2']],
        asks: [[...ask, '0', '1']],
        ts: '1700000000100',
        seqId: 456,
      },
    ],
  });
}

test('normalizes a valid OKX BBO quote', () => {
  assert.deepEqual(parseOkxMessage(payload(), RECEIVED_TIMESTAMP), {
    exchange: 'okx',
    symbol: 'BTC/USDT',
    bid: 100.1,
    bidSize: 1.25,
    ask: 100.2,
    askSize: 0.75,
    exchangeTimestamp: 1_700_000_000_100,
    matchingEngineTimestamp: 1_700_000_000_100,
    receivedTimestamp: RECEIVED_TIMESTAMP,
  });
});

test('ignores malformed OKX payloads', () => {
  assert.equal(parseOkxMessage('{not-json', RECEIVED_TIMESTAMP), null);
  assert.equal(parseOkxMessage('{}', RECEIVED_TIMESTAMP), null);
});

test('ignores OKX quotes with zero or invalid prices', () => {
  assert.equal(parseOkxMessage(payload(['0', '1.25']), RECEIVED_TIMESTAMP), null);
  assert.equal(
    parseOkxMessage(payload(['invalid', '1.25']), RECEIVED_TIMESTAMP),
    null,
  );
});

test('ignores OKX quotes with zero or invalid sizes', () => {
  assert.equal(parseOkxMessage(payload(['100.10', '0']), RECEIVED_TIMESTAMP), null);
  assert.equal(
    parseOkxMessage(payload(['100.10', 'invalid']), RECEIVED_TIMESTAMP),
    null,
  );
});

test('ignores a crossed OKX quote', () => {
  assert.equal(
    parseOkxMessage(
      payload(['100.30', '1.25'], ['100.20', '0.75']),
      RECEIVED_TIMESTAMP,
    ),
    null,
  );
});
