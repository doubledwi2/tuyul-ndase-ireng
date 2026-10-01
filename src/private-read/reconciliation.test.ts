import assert from 'node:assert/strict';
import test from 'node:test';
import { SecretString } from '../security/secrets.js';
import { balanceUrl, requestUrl, validateReadUrl, READ_PATHS, type RequestKind, type BybitRequestKind, type OkxRequestKind } from './config.js';
import { signBybitRead, signOkxRead } from './signing.js';
import { BybitReadOnlyClient } from './bybit.js';
import { OkxReadOnlyClient } from './okx.js';
import { PrivateAccountCollector } from './collector.js';
import { fixtureForKind, okxFeeFixture, bybitPermissionFixture } from './fixtures.js';
import { parseOkxFeeResponse } from './account-parsers.js';
import { accountCheckSummary } from './check-summary.js';
import { reconcileAccount } from './inventory.js';
import { LatencyPaperTradingEngine } from '../paper/latency-engine.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import type { PrivateAccountSnapshot } from './types.js';

const key = new SecretString('sample-key'), secret = new SecretString('sample-secret'), pass = new SecretString('sample-passphrase');
const vectors: Record<RequestKind, string> = {
  BYBIT_BALANCE: '6d9366c2aa01dff062f1bd798ba842143287048d021866780bcb412f3620471d',
  BYBIT_FEE_RATE: '9b56f1d4b11b965e647fd4bacfc11e56a8c31799bc4d1217704dad0f6bc65234',
  BYBIT_ACCOUNT_INFO: '9070d4b068ab77e4ee323013606a4a60ccdaf1b66a5ed74f250c7d75d68acb69',
  BYBIT_API_KEY_INFO: '9070d4b068ab77e4ee323013606a4a60ccdaf1b66a5ed74f250c7d75d68acb69',
  OKX_BALANCE: 'CsJgwpNTakaCDFUz3seUdb6kkubENuZvyVxRBkOdhqE=',
  OKX_ACCOUNT_CONFIG: 'c/QtPk30UT9ELdJd+p3hR0oyejU/Z4dMM1fd2JilSOo=',
  OKX_TRADE_FEE: 'BEiJqxiOiSZXh4ykACpUgIW/XBvpfiyxX6xPJgOUrXk=',
};
for (const kind of Object.keys(vectors) as RequestKind[]) {
  test(`fixed fake signing vector and runtime exact URL guard: ${kind}`, () => {
    const bybit = kind.startsWith('BYBIT_'), exchange = bybit ? 'bybit' : 'okx';
    const headers = bybit ? signBybitRead(kind as BybitRequestKind, key, secret, 1700000000000) : signOkxRead(kind as OkxRequestKind, key, secret, pass, 1700000000000);
    headers.use(h => assert.equal(h[bybit ? 'X-BAPI-SIGN' : 'OK-ACCESS-SIGN'], vectors[kind]));
    const base = balanceUrl(exchange, bybit ? 'https://api.bybit.com' : 'https://openapi.okx.com');
    const url = requestUrl(kind, base);
    assert.ok(url.endsWith(READ_PATHS[kind])); assert.doesNotThrow(() => validateReadUrl(exchange, kind, url));
    for (const bad of [url + '&extra=1', url + '/', url.replace('https:', 'http:'), url.replace('.com', '.com.evil')]) {
      assert.throws(() => validateReadUrl(exchange, kind, bad));
    }
    assert.throws(() => validateReadUrl(bybit ? 'okx' : 'bybit', kind, url));
  });
}
test('signers reject arbitrary request kinds and cross-exchange kinds at runtime', () => {
  for (const value of ['/arbitrary', '__proto__', 'toString', 'OKX_BALANCE']) {
    assert.throws(() => signBybitRead(value as BybitRequestKind, key, secret, 1));
  }
  assert.throws(() => signOkxRead('BYBIT_BALANCE' as OkxRequestKind, key, secret, pass, 1));
});
test('serial scheduler caps concurrent requests at one, prioritizes queued balance, and spaces reads', async () => {
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: RequestKind[] = [], delays: number[] = []; let active = 0, peak = 0;
  const client = new BybitReadOnlyClient(key, secret, { enabled: true, url: balanceUrl('bybit', 'https://api.bybit.com'),
    monotonicNow: () => 0, sleep: async ms => { delays.push(ms); }, transport: { get: async r => {
      active++; peak = Math.max(peak, active); order.push(r.kind!);
      if (r.kind === 'BYBIT_FEE_RATE') { entered(); await gate; }
      active--; return { payload: fixtureForKind(r.kind!), receivedAt: 100 };
    } } });
  const fee = client.read('BYBIT_FEE_RATE'); await ready;
  const config = client.read('BYBIT_ACCOUNT_INFO'), permission = client.read('BYBIT_API_KEY_INFO'), balance = client.readBalance();
  release(); await Promise.all([fee, config, permission, balance]);
  assert.equal(peak, 1); assert.deepEqual(order, ['BYBIT_FEE_RATE', 'BYBIT_BALANCE', 'BYBIT_ACCOUNT_INFO', 'BYBIT_API_KEY_INFO']);
  assert.deepEqual(delays, [500, 500, 500]);
});
test('collector cadence per kind, separate success times, retained snapshots on failure and strict freshness', async () => {
  let mono = 0, failFee = false; const now = () => 1700000000000 + mono;
  const client = new BybitReadOnlyClient(key, secret, { enabled: true, url: balanceUrl('bybit', 'https://api.bybit.com'),
    now, monotonicNow: () => mono, sleep: async () => {}, transport: { get: async r => ({
      payload: failFee && r.kind === 'BYBIT_FEE_RATE' ? {} : fixtureForKind(r.kind!), receivedAt: now(),
    }) } });
  const collector = new PrivateAccountCollector(true, [client], undefined, now);
  await collector.pollOnce(); assert.equal(client.getMetrics().privateReadRequests, 4);
  mono = 9999; await collector.pollOnce(); assert.equal(client.getMetrics().privateReadRequests, 4);
  mono = 10_000; await collector.pollOnce(); assert.equal(client.getMetrics().privateReadRequests, 5);
  const health = collector.getDiagnosticHealth('bybit');
  assert.equal(health.lastBalanceSuccessAt, now()); assert.equal(health.lastConfigSuccessAt, 1700000000000);
  mono = 300_000; failFee = true; await collector.pollOnce();
  assert.equal(client.getMetrics().byKind.BYBIT_FEE_RATE!.privateReadRequests, 2);
  assert.equal(client.cache('BYBIT_FEE_RATE').lastSuccessAt, 1700000000000);
  assert.ok(client.cache('BYBIT_FEE_RATE').snapshot); assert.equal(collector.getDiagnosticHealth('bybit').fee.degraded, true);
  assert.equal(collector.getFeeDiagnostic().bybitObservedAccountFee, null);
  mono = 330_000; assert.equal(collector.getDiagnosticHealth('bybit').balanceFresh, true);
  mono++; assert.equal(collector.getDiagnosticHealth('bybit').balanceFresh, false);
  mono = 900_000; assert.equal(collector.getDiagnosticHealth('bybit').feeFresh, true);
  mono++; assert.equal(collector.getDiagnosticHealth('bybit').feeFresh, false);
  assert.notEqual(collector.getSafetySummary().overall, 'SAFE_FOR_READ_ONLY_OBSERVATION');
  await collector.stop();
});
test('unsafe keys warn once per transition and polling continues; CLI nonzero, paper unaffected', async () => {
  let mono = 0; const warnings: string[] = []; const engine = new LatencyPaperTradingEngine(), before = engine.exportState();
  const client = new BybitReadOnlyClient(key, secret, { enabled: true, url: balanceUrl('bybit', 'https://api.bybit.com'),
    monotonicNow: () => mono, sleep: async () => {}, transport: { get: async r => {
      const payload = r.kind === 'BYBIT_API_KEY_INFO' ? bybitPermissionFixture() : fixtureForKind(r.kind!);
      if (r.kind === 'BYBIT_API_KEY_INFO' && 'result' in payload && 'readOnly' in payload.result) payload.result.readOnly = 0;
      return { payload, receivedAt: 100 + mono };
    } } });
  const collector = new PrivateAccountCollector(true, [client], undefined, () => 100 + mono, (_, category) => { warnings.push(category); });
  await collector.pollOnce(); assert.equal(collector.getSafetySummary().overall, 'REVIEW_REQUIRED');
  assert.equal(collector.getHealth().bybit.credentialSafety.status, 'UNSAFE_WRITE_ENABLED');
  mono = 10_000; await collector.pollOnce(); assert.equal(client.getMetrics().byKind.BYBIT_BALANCE!.privateReadSuccess, 2);
  assert.deepEqual(warnings, ['UNSAFE_WRITE_ENABLED']); assert.equal(accountCheckSummary(collector, [client]).exitCode, 1);
  assert.deepEqual(engine.exportState(), before); await collector.stop();
});
test('CLI fails unknown config, stale fee and read failures; OKX safe spot fixture is OK', async () => {
  let mono = 0;
  const client = new OkxReadOnlyClient(key, secret, pass, { enabled: true, url: balanceUrl('okx', 'https://openapi.okx.com'),
    monotonicNow: () => mono, sleep: async () => {}, transport: { get: async r => ({ payload: fixtureForKind(r.kind!), receivedAt: 100 }) } });
  const collector = new PrivateAccountCollector(true, [client], undefined, () => 100 + mono);
  await collector.pollOnce(); const check = accountCheckSummary(collector, [client]);
  assert.equal(check.exitCode, 0); assert.equal(check.summaries[0]!.accountConfig, 'COMPATIBLE');
  mono = 900_001; assert.equal(accountCheckSummary(collector, [client]).exitCode, 1);
  assert.equal(accountCheckSummary(collector, [client]).summaries[0]!.fee, 'not available');
  await collector.stop();
});
const real: PrivateAccountSnapshot = { exchange: 'okx', receivedAt: 1000, sourceUpdatedAt: null,
  btc: { total: 2, available: 1 }, usdt: { total: 1000, available: 100 } };
const book: NormalizedOrderBook = { exchange: 'okx', symbol: 'BTC/USDT', receivedTimestamp: 1000,
  exchangeTimestamp: null, matchingEngineTimestamp: null, bids: [{ price: 999, size: 1 }], asks: [{ price: 1000, size: 1 }] };
test('reconciliation uses available funds, target depth cost and observed fee; does not mutate paper', () => {
  const engine = new LatencyPaperTradingEngine(), before = engine.exportState(), paper = engine.getBalances();
  paper.okx.btcReserved = 0.2;
  const fee = parseOkxFeeResponse(okxFeeFixture(), 1000);
  const result = reconcileAccount('okx', real, paper, fee, book, 1000);
  assert.equal(result.targetBtcSize, 0.01); assert.ok(Math.abs(result.requiredBuyUsdt! - 10.01) < 1e-10);
  assert.equal(result.enoughForConfiguredPaperTarget, true); assert.ok(Math.abs(result.btcDifference! - 1.7) < 1e-10);
  assert.deepEqual(engine.exportState(), before);
});
test('funding fails closed for missing availability, stale balances/books, insufficient funds/depth and invalid targets', () => {
  const paper = new LatencyPaperTradingEngine().getBalances();
  for (const snapshot of [null, { ...real, btc: { ...real.btc, available: null } }, { ...real, usdt: { total: 100000, available: 1 } },
    { ...real, btc: { total: 100, available: 0 } }, { ...real, receivedAt: 100000 }]) {
    assert.equal(reconcileAccount('okx', snapshot, paper, null, book, 1000).enoughForConfiguredPaperTarget, false);
  }
  for (const market of [null, { ...book, receivedTimestamp: 1 }, { ...book, asks: [{ price: 1000, size: 0.001 }] }]) {
    assert.equal(reconcileAccount('okx', real, paper, null, market, 2000).enoughForConfiguredPaperTarget, false);
  }
  assert.equal(reconcileAccount('okx', real, paper, null, book, 1000, false).enoughForConfiguredPaperTarget, false);
  assert.equal(reconcileAccount('okx', real, paper, null, book, 1000, true, NaN).enoughForConfiguredPaperTarget, false);
});
test('rebates remain negative observed costs but cannot reduce upfront funding requirement', () => {
  const f = okxFeeFixture(); f.data[0]!.feeGroup[0]!.taker = '0.001';
  const result = reconcileAccount('okx', real, new LatencyPaperTradingEngine().getBalances(), parseOkxFeeResponse(f, 1000), book, 1000);
  assert.equal(result.requiredBuyUsdt, 10);
});
