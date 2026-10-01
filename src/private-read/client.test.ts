import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { SecretString, safeJson } from '../security/secrets.js';
import { BybitReadOnlyClient } from './bybit.js';
import { OkxReadOnlyClient } from './okx.js';
import { PrivateAccountCollector } from './collector.js';
import { balanceUrl, PRIVATE_BALANCE_POLL_INTERVAL_MS, PRIVATE_READ_RETRY_DELAY_MS } from './config.js';
import { signBybitBalance, signOkxBalance } from './signing.js';
import { PrivateReadError } from './types.js';
import { bybitFixture, fixtureForKind } from './fixtures.js';
import { createPrivateReadClients } from './startup.js';
import { compareInventory } from './inventory.js';
import { LatencyPaperTradingEngine } from '../paper/latency-engine.js';

const key = new SecretString('sample-key'), secret = new SecretString('sample-secret'), pass = new SecretString('sample-passphrase');
const url = balanceUrl('bybit', 'https://api.bybit.com');
test('fixed fake balance-only HMAC vectors: Bybit hex and OKX base64', () => {
  const b = signBybitBalance(key, secret, 1700000000000);
  b.use(headers => {
    assert.equal(headers['X-BAPI-SIGN'], '6d9366c2aa01dff062f1bd798ba842143287048d021866780bcb412f3620471d');
    assert.equal(headers['X-BAPI-TIMESTAMP'], '1700000000000'); assert.equal(headers['X-BAPI-RECV-WINDOW'], '5000');
  });
  const o = signOkxBalance(key, secret, pass, 1700000000000);
  o.use(headers => {
    assert.equal(headers['OK-ACCESS-SIGN'], 'CsJgwpNTakaCDFUz3seUdb6kkubENuZvyVxRBkOdhqE=');
    assert.equal(headers['OK-ACCESS-TIMESTAMP'], '2023-11-14T22:13:20.000Z');
  });
  for (const headers of [b, o]) {
    assert.equal(inspect(headers), '[REDACTED]'); assert.equal(JSON.stringify(headers), '"[REDACTED]"');
    assert.equal(safeJson(headers), '{}');
  }
});
for (const category of ['NETWORK', 'TIMEOUT', 'RATE_LIMIT', 'HTTP'] as const) {
  test(`${category} retries once only, with deterministic backoff and fresh signatures`, async () => {
    let calls = 0, now = 1000;
    const signatures: string[] = [];
    const delays: number[] = [];
    const client = new BybitReadOnlyClient(key, secret, { enabled: true, url, now: () => now,
      sleep: async ms => { delays.push(ms); now += ms; }, transport: { get: async request => {
        calls++; request.headers.use(h => signatures.push(h['X-BAPI-SIGN']!));
        throw new PrivateReadError(category, category === 'HTTP' ? 503 : null);
      } } });
    await assert.rejects(client.readBalance(), { category });
    assert.equal(calls, 2); assert.deepEqual(delays, [PRIVATE_READ_RETRY_DELAY_MS]); assert.notEqual(signatures[0], signatures[1]);
    assert.equal(client.getMetrics().privateReadFailures, 2);
  });
}
test('success after retry, parser fail closed without retry, metrics and 10s monotonic poll guard', async () => {
  let calls = 0, mono = 0;
  const client = new BybitReadOnlyClient(key, secret, { enabled: true, url, monotonicNow: () => mono,
    sleep: async () => {}, transport: { get: async () => {
      calls++; if (calls === 1) throw new Error('never logged');
      return { payload: calls === 3 ? {} : bybitFixture(), receivedAt: 25 };
    } } });
  assert.equal((await client.readBalance()).receivedAt, 25);
  await assert.rejects(client.readBalance(), { category: 'POLL_GUARD' });
  assert.equal(calls, 2); mono = PRIVATE_BALANCE_POLL_INTERVAL_MS;
  await assert.rejects(client.readBalance()); assert.equal(calls, 3);
  assert.equal(client.getMetrics().privateReadSuccess, 1);
  assert.equal(client.getMetrics().privateReadRequests, 3);
});
test('non-transient authentication/400 errors are not retried', async () => {
  let calls = 0;
  const client = new BybitReadOnlyClient(key, secret, { enabled: true, url, transport: { get: async () => {
    calls++; throw new PrivateReadError('HTTP', 401);
  } } });
  await assert.rejects(client.readBalance()); assert.equal(calls, 1);
});
test('default disabled and stopped clients make no request; mutable options cannot enable IO', async () => {
  let calls = 0;
  const options = { enabled: false, url, transport: { get: async () => { calls++; return { payload: bybitFixture(), receivedAt: 25 }; } } };
  const client = new BybitReadOnlyClient(key, secret, options); options.enabled = true;
  await assert.rejects(client.readBalance(), { category: 'CONFIG' }); assert.equal(calls, 0);
  const stopped = new BybitReadOnlyClient(key, secret, options); stopped.stop();
  await assert.rejects(stopped.readBalance(), { category: 'STOPPED' }); assert.equal(calls, 0);
});
test('enabled requires both complete credential sets; disabled startup makes no request', async () => {
  assert.equal((await createPrivateReadClients({})).enabled, false);
  await assert.rejects(createPrivateReadClients({ PRIVATE_READ_ENABLED: 'true' }));
  await assert.rejects(createPrivateReadClients({ PRIVATE_READ_ENABLED: 'true', BYBIT_API_KEY: 'REPLACE_ME' }));
});
test('collector isolates failures, degrades after five, deduplicates polls, recovers, and freshness expires', async () => {
  let now = 100, fail = true;
  const warnings: unknown[] = [];
  const bybit = new BybitReadOnlyClient(key, secret, { enabled: true, url, monotonicNow: () => now,
    sleep: async () => {}, transport: { get: async request => {
      if (fail && request.kind === 'BYBIT_BALANCE') throw new PrivateReadError('HTTP', 401);
      return { payload: fixtureForKind(request.kind!), receivedAt: now };
    } } });
  const okx = new OkxReadOnlyClient(key, secret, pass, { enabled: true, url: balanceUrl('okx', 'https://openapi.okx.com'),
    monotonicNow: () => now, sleep: async () => {}, transport: { get: async request => ({ payload: fixtureForKind(request.kind!), receivedAt: now }) } });
  const collector = new PrivateAccountCollector(true, [bybit, okx], (...args) => { warnings.push(args); }, () => now);
  for (let i = 0; i < 5; i++) { await Promise.all([collector.pollOnce(), collector.pollOnce()]); now += 10_000; }
  assert.equal(collector.getHealth().bybitDegraded, true); assert.equal(collector.getHealth().okxHealthy, true);
  assert.equal(warnings.length, 2); assert.equal(collector.getHealth().diagnosticReady, false);
  fail = false; await collector.pollOnce(); assert.equal(collector.getHealth().bybitHealthy, true);
  assert.equal(collector.getHealth().bybit.credentialSafety.status, 'SAFE_READ_ONLY');
  const copy = collector.getInventory(); copy.bybit!.btc.total = 0;
  assert.equal(collector.getInventory().bybit!.btc.total, 1.25);
  now += 30_001; assert.equal(collector.getHealth().bybitHealthy, false);
  await collector.stop(); await collector.pollOnce(); assert.equal(bybit.getMetrics().byKind.BYBIT_BALANCE!.privateReadRequests, 6);
});
test('inventory observation includes reservations and does not mutate paper; disabled collector remains inert', async () => {
  const engine = new LatencyPaperTradingEngine();
  const before = engine.exportState();
  const balances = engine.getBalances(); balances.bybit.btcAvailable = 1; balances.bybit.btcReserved = 0.2;
  const collector = new PrivateAccountCollector(false, []); collector.start(); await collector.pollOnce(); await collector.stop();
  const diff = compareInventory({ bybit: { exchange: 'bybit', receivedAt: 1, sourceUpdatedAt: null,
    btc: { total: 2, available: null }, usdt: { total: 3, available: null } } }, balances);
  assert.equal(diff.bybitBtcDifference, 0.8); assert.equal(diff.okxBtcDifference, null); assert.equal(diff.label, 'diagnostic only');
  assert.deepEqual(engine.exportState(), before); assert.equal(collector.getHealth().enabled, false);
});
test('static production boundary: exactly seven approved endpoint paths, no write references or private WS', async () => {
  let all = '';
  for (const name of await readdir('src/private-read')) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    all += await readFile(`src/private-read/${name}`, 'utf8');
  }
  const paths = [...all.matchAll(/\/(?:api\/)?v5\/[a-zA-Z0-9/_-]+/g)].map(match => match[0]);
  assert.deepEqual([...new Set(paths)].sort(), ['/api/v5/account/balance', '/api/v5/account/config', '/api/v5/account/trade-fee',
    '/v5/account/fee-rate', '/v5/account/info', '/v5/account/wallet-balance', '/v5/user/query-api']);
  assert.doesNotMatch(all, /\/(?:order|cancel|amend|withdraw|transfer)(?:[/?'"`]|$)|\/set-/);
  assert.doesNotMatch(all, /\b(?:POST|DELETE|PATCH|PUT)\b|wss?:\/\/|WebSocket/);
  assert.equal((all.match(/method: 'GET'/g) ?? []).length, 1);
});
