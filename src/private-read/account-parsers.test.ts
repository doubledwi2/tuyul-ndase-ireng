import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBybitApiKeyInfo, parseBybitAccountInfo, parseOkxAccountConfig, parseBybitFeeResponse, parseOkxFeeResponse, normalizeOkxFeeRate, parseReadResponse } from './account-parsers.js';
import { bybitPermissionFixture, bybitInfoFixture, bybitFeeFixture, okxConfigFixture, okxFeeFixture, fixtureForKind } from './fixtures.js';
import { assessBybitCompatibility, assessOkxCompatibility, feeDiagnostic, observedFeeConfig } from './assessment.js';
import { READ_PATHS, privateReadConfig, type RequestKind } from './config.js';
import { FEES } from '../config/fees.js';

test('Bybit readOnly=1 with explicitly empty write arrays is SAFE; readOnly=0 is unsafe', () => {
  const f = bybitPermissionFixture(); const safe = parseBybitApiKeyInfo(f, 100);
  assert.equal(safe.assessment.status, 'SAFE_READ_ONLY'); assert.equal(safe.ipBound, false);
  f.result.readOnly = 0;
  assert.deepEqual(parseBybitApiKeyInfo(f, 100).assessment.reasons, ['BYBIT_KEY_NOT_READ_ONLY']);
});
test('Bybit write permission arrays are inspected even with readOnly=1; all reasons preserved', () => {
  const f = bybitPermissionFixture(); f.result.permissions.Spot = ['SpotTrade'];
  f.result.permissions.Wallet = ['Withdraw', 'AccountTransfer', 'SubMemberTransfer', 'SubMemberTransferList'];
  f.result.ips = ['192.0.2.100'];
  const parsed = parseBybitApiKeyInfo(f, 100);
  assert.equal(parsed.ipBound, true); assert.equal(parsed.assessment.status, 'UNSAFE_WRITE_ENABLED');
  assert.deepEqual(parsed.assessment.reasons, ['BYBIT_SPOT_TRADE_PERMISSION_PRESENT', 'BYBIT_TRANSFER_PERMISSION_PRESENT', 'BYBIT_WITHDRAW_PERMISSION_PRESENT']);
  f.result.readOnly = 0; assert.equal(parseBybitApiKeyInfo(f, 100).assessment.reasons.length, 4);
});
test('Bybit unknown permission schema, enum, IP representation and readOnly type fail SCHEMA', () => {
  const f = bybitPermissionFixture();
  for (const patch of [{ readOnly: '1' }, { readOnly: 2 }, { permissions: {} },
    { permissions: { Spot: ['future'], Wallet: [] } }, { permissions: { ...f.result.permissions, Future: [] } },
    { ips: ['bad address'] }, { permissions: { Spot: 'SpotTrade', Wallet: [] } }]) {
    assert.throws(() => parseBybitApiKeyInfo({ ...f, result: { ...f.result, ...patch } }, 1), { category: 'SCHEMA' });
  }
  f.result.ips = ['*']; assert.equal(parseBybitApiKeyInfo(f, 100).ipBound, false);
  assert.equal(parseBybitApiKeyInfo({ ...f, result: { ...f.result, ips: undefined } }, 100).ipBound, null);
});
for (const permission of ['trade', 'withdraw', 'read_only,trade', 'read_only,withdraw', 'read_only,trade,withdraw']) {
  test(`OKX unsafe permission ${permission}`, () => {
    const f = okxConfigFixture(); f.data[0]!.perm = permission;
    assert.equal(parseOkxAccountConfig(f, 100).safety.assessment.status, 'UNSAFE_WRITE_ENABLED');
  });
}
test('OKX read-only permission and IP binding normalized, missing/unknown/malformed permissions rejected', () => {
  const f = okxConfigFixture(); f.data[0]!.ip = '192.0.2.20,192.0.2.21';
  assert.equal(parseOkxAccountConfig(f, 100).safety.ipBound, true);
  assert.equal(parseOkxAccountConfig(f, 100).safety.assessment.status, 'SAFE_READ_ONLY');
  for (const perm of ['', 'read_only,future', 'read_only,read_only']) {
    f.data[0]!.perm = perm; assert.throws(() => parseOkxAccountConfig(f, 100), { category: 'SCHEMA' });
  }
});
test('account compatibility conservatively refuses unverified Bybit spot-cash and unsupported margin modes', () => {
  const f = bybitInfoFixture();
  assert.equal(assessBybitCompatibility(parseBybitAccountInfo(f)).status, 'UNKNOWN');
  f.result.marginMode = 'PORTFOLIO_MARGIN'; assert.equal(assessBybitCompatibility(parseBybitAccountInfo(f)).status, 'INCOMPATIBLE');
  f.result.marginMode = 'ISOLATED_MARGIN'; f.result.spotHedgingStatus = 'ON';
  assert.equal(assessBybitCompatibility(parseBybitAccountInfo(f)).status, 'INCOMPATIBLE');
  f.result.unifiedMarginStatus = 99; assert.throws(() => parseBybitAccountInfo(f), { category: 'SCHEMA' });
});
test('OKX compatibility requires spot/net with explicitly disabled autoLoan and spot borrowing', () => {
  const f = okxConfigFixture();
  assert.equal(assessOkxCompatibility(parseOkxAccountConfig(f, 1).config).status, 'COMPATIBLE');
  for (const patch of [{ acctLv: '2' }, { acctLv: '3' }, { acctLv: '4' }, { autoLoan: true }, { enableSpotBorrow: true }, { posMode: 'long_short_mode' }]) {
    assert.equal(assessOkxCompatibility(parseOkxAccountConfig({ ...f, data: [{ ...f.data[0], ...patch }] }, 1).config).status, 'INCOMPATIBLE');
  }
  const missing = { ...f, data: [{ ...f.data[0], autoLoan: undefined }] };
  assert.equal(assessOkxCompatibility(parseOkxAccountConfig(missing, 1).config).status, 'UNKNOWN');
  for (const patch of [{ acctLv: '99' }, { autoLoan: 'false' }, { posMode: 'unknown' }]) {
    assert.throws(() => parseOkxAccountConfig({ ...f, data: [{ ...f.data[0], ...patch }] }, 1), { category: 'SCHEMA' });
  }
});
for (const [raw, expected] of [['-0.001', 0.001], ['0.0002', -0.0002], ['0', 0], ['-0', 0]] as const) {
  test(`OKX fee ${raw} means normalized cost ${expected}`, () => {
    assert.deepEqual(normalizeOkxFeeRate(raw), { rawRate: raw, normalizedCostRate: expected });
  });
}
for (const value of ['NaN', 'Infinity', '1e-3', '', ' ', '0.06', '-0.06', '0x10', 0.001, null]) {
  test(`fee parsers reject invalid/bounded value ${JSON.stringify(value)}`, () => {
    assert.throws(() => normalizeOkxFeeRate(value), { category: 'SCHEMA' });
    const f = bybitFeeFixture();
    assert.throws(() => parseBybitFeeResponse({ ...f, result: { ...f.result, list: [{ ...f.result.list[0], takerFeeRate: value }] } }, 1), { category: 'SCHEMA' });
  });
}
test('fee parsers require exact scope, unique OKX fee group, success code and no fabricated update time', () => {
  const b = bybitFeeFixture(), o = okxFeeFixture();
  assert.equal(parseBybitFeeResponse(b, 10).sourceUpdatedAt, null);
  assert.equal(parseOkxFeeResponse(o, 10).sourceUpdatedAt, null);
  assert.equal(parseOkxFeeResponse(o, 10).takerFeeRate.normalizedCostRate, 0.001);
  b.result.list[0]!.symbol = 'ETHUSDT'; assert.throws(() => parseBybitFeeResponse(b, 1));
  o.data[0]!.feeGroup.push(o.data[0]!.feeGroup[0]!); assert.throws(() => parseOkxFeeResponse(o, 1));
  assert.throws(() => parseOkxFeeResponse({ code: '0', data: [{ instType: 'SPOT', maker: '-0.001', taker: '-0.001' }] }, 1));
  const negative = bybitFeeFixture(); negative.result.list[0]!.takerFeeRate = '-0.001';
  assert.throws(() => parseBybitFeeResponse(negative, 1));
});
test('every new parser rejects malformed or unsuccessful response without preserving metadata', () => {
  for (const kind of Object.keys(READ_PATHS) as RequestKind[]) {
    for (const value of [null, [], {}, { retCode: '0', result: {} }, { code: 0, data: [] }]) assert.throws(() => parseReadResponse(kind, value, 1));
    assert.doesNotThrow(() => parseReadResponse(kind, fixtureForKind(kind), 1));
  }
});
test('diagnostic fee delta uses observed-minus-configured, exact 2bps boundary and immutable candidate without engine mutation', () => {
  const before = JSON.stringify(FEES), b = bybitFeeFixture();
  b.result.list[0]!.takerFeeRate = '0.0012';
  const snapshot = parseBybitFeeResponse(b, 1);
  assert.equal(feeDiagnostic(snapshot, null).bybitWarning, null);
  b.result.list[0]!.takerFeeRate = '0.00121';
  assert.equal(feeDiagnostic(parseBybitFeeResponse(b, 1), null).bybitWarning, 'FEE_MODEL_MISMATCH');
  b.result.list[0]!.takerFeeRate = '0.0005';
  assert.equal(feeDiagnostic(parseBybitFeeResponse(b, 1), null).bybitFeeDelta, -0.0005);
  assert.ok(Object.isFrozen(observedFeeConfig(snapshot, null))); assert.equal(JSON.stringify(FEES), before);
  assert.throws(() => privateReadConfig({ ACCOUNT_FEE_MODE: 'live' }));
  assert.doesNotThrow(() => privateReadConfig({ ACCOUNT_FEE_MODE: 'diagnostic' }));
});
