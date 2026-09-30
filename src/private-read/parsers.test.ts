import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBybitBalanceResponse, parseOkxBalanceResponse } from './parsers.js';
import { bybitFixture, okxFixture } from './fixtures.js';

test('Bybit UNIFIED uses walletBalance, never deprecated available or response time as update time', () => {
  assert.deepEqual(parseBybitBalanceResponse(bybitFixture(), 42), {
    exchange: 'bybit', receivedAt: 42, sourceUpdatedAt: null, rawAccountType: 'UNIFIED',
    btc: { total: 1.25, available: null }, usdt: { total: 2500, available: null },
  });
});
test('OKX cash balance, availability and source update timestamp remain distinct', () => {
  assert.deepEqual(parseOkxBalanceResponse(okxFixture(), 42), {
    exchange: 'okx', receivedAt: 42, sourceUpdatedAt: 1700000000000,
    btc: { total: 1.25, available: 1 }, usdt: { total: 2500, available: 2300 },
  });
  const v = okxFixture(); v.data[0]!.details[0]!.availBal = ''; v.data[0]!.uTime = '';
  assert.equal(parseOkxBalanceResponse(v, 42).btc.available, null);
  assert.equal(parseOkxBalanceResponse(v, 42).sourceUpdatedAt, null);
});
for (const value of ['', ' ', 'NaN', 'Infinity', '-1', '1e2', '0x10', '.1', '1.', '21000001', '0.'.padEnd(70, '0') + '1']) {
  test(`parsers reject malformed or out-of-bound BTC amount ${JSON.stringify(value)}`, () => {
    const b = bybitFixture(); b.result.list[0]!.coin[0]!.walletBalance = value;
    const o = okxFixture(); o.data[0]!.details[0]!.cashBal = value;
    assert.throws(() => parseBybitBalanceResponse(b, 42));
    assert.throws(() => parseOkxBalanceResponse(o, 42));
    const size = okxFixture(); size.data[0]!.details[0]!.availBal = value;
    if (value !== '') assert.throws(() => parseOkxBalanceResponse(size, 42));
  });
}
test('explicit zero supported, missing coins and duplicate requested labels fail closed', () => {
  const b = bybitFixture(); b.result.list[0]!.coin[0]!.walletBalance = '0';
  assert.equal(parseBybitBalanceResponse(b, 42).btc.total, 0);
  b.result.list[0]!.coin.pop(); assert.throws(() => parseBybitBalanceResponse(b, 42));
  const o = okxFixture(); o.data[0]!.details.push(o.data[0]!.details[0]!);
  assert.throws(() => parseOkxBalanceResponse(o, 42));
  o.data[0]!.details = []; assert.throws(() => parseOkxBalanceResponse(o, 42));
});
test('unrelated currencies ignored; schema, response status, timestamp and numeric types validated', () => {
  const b = bybitFixture(); b.result.list[0]!.coin.push({ coin: 'ETH', walletBalance: 'ignored' });
  assert.equal(parseBybitBalanceResponse(b, 42).btc.total, 1.25);
  const o = okxFixture(); o.data[0]!.details.push({ ccy: 'ETH', cashBal: 'ignored', availBal: 'ignored' });
  assert.equal(parseOkxBalanceResponse(o, 42).btc.total, 1.25);
  for (const bad of [null, [], 'bad', {}, { code: '1', data: [] }, { retCode: 1 }, { retCode: '0', result: b.result }]) {
    assert.throws(() => parseBybitBalanceResponse(bad, 42)); assert.throws(() => parseOkxBalanceResponse(bad, 42));
  }
  o.data[0]!.uTime = 'NaN'; assert.throws(() => parseOkxBalanceResponse(o, 42));
  assert.throws(() => parseBybitBalanceResponse(b, NaN));
  assert.throws(() => parseBybitBalanceResponse({ ...b, result: { list: [{ accountType: 'SPOT', coin: [] }] } }, 42));
});
