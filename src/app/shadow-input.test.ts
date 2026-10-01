import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shadowAccounts, shadowInput } from './shadow-input.js';
import { MarketPipeline } from './pipeline.js';
import { ShadowRuntime } from '../shadow/shadow-runtime.js';
import { shadowFixture } from '../shadow/fixture.js';
import { PrivateAccountCollector } from '../private-read/collector.js';
import { BybitReadOnlyClient } from '../private-read/bybit.js';
import { OkxReadOnlyClient } from '../private-read/okx.js';
import { balanceUrl } from '../private-read/config.js';
import { fixtureForKind } from '../private-read/fixtures.js';
import { SecretString } from '../security/secrets.js';
import type { ReadOnlyHttpTransport } from '../private-read/transport.js';
import { parseExecutionSafety } from '../execution/safety.js';
import { EXCHANGE_CAPABILITIES } from '../execution/capabilities.js';
import { DisabledLiveExecutionAdapter } from '../execution/disabled-live-adapter.js';
import type { OrderRequest } from '../execution/orders.js';

test('cache-only integration: seven initial reads, no extra reads per candidate, paper comparison immutable', async () => {
  let requests = 0; const at = shadowFixture().evaluatedAt;
  const key = new SecretString('synthetic-shadow-key');
  const transport: ReadOnlyHttpTransport = { get: async request => {
    requests++; return { payload: fixtureForKind(request.kind!), receivedAt: at };
  } };
  const options = { enabled: true, transport, now: () => at, monotonicNow: () => at, sleep: async () => {} };
  const clients = [new BybitReadOnlyClient(key, key, { ...options, url: balanceUrl('bybit', 'https://api.bybit.com') }),
    new OkxReadOnlyClient(key, key, key, { ...options, url: balanceUrl('okx', 'https://openapi.okx.com') })];
  const collector = new PrivateAccountCollector(true, clients, undefined, () => at);
  try {
    await collector.pollOnce(); assert.equal(requests, 7);
    const accounts = shadowAccounts(collector);
    assert.ok(Object.isFrozen(accounts)); assert.ok(Object.isFrozen(accounts.bybit.balance!.btc));
    assert.ok(Object.isFrozen(accounts.bybit.fee!.takerFeeRate));
    assert.ok(Object.isFrozen(accounts.bybit.compatibility!.value.reasons));
    assert.equal(accounts.bybit.balance!.btc.available, null);
    assert.equal(accounts.bybit.compatibility!.value.status, 'UNKNOWN');
    const runtime = new ShadowRuntime(true), pipeline = new MarketPipeline();
    const books = shadowFixture().books;
    for (let i = 0; i < 40; i++) {
      pipeline.processOrderBook(books.bybit, at);
      const snapshot = pipeline.processOrderBook(books.okx, at)!;
      const before = structuredClone(snapshot);
      const a = runtime.evaluate(shadowInput(snapshot, collector, at))!;
      assert.equal(a.directions[0].fundingStatus, 'UNKNOWN_AVAILABLE_BALANCE');
      assert.ok(a.directions[0].fundingReasons.includes('ACCOUNT_COMPATIBILITY_UNKNOWN'));
      assert.deepEqual(snapshot, before);
    }
    assert.equal(requests, 7); assert.equal(runtime.getMetrics().shadowEvaluations, 40);
    assert.equal(runtime.getHealth(at).status, 'DEGRADED');
  } finally { await collector.stop(); }
});
test('shadow flags never enable real execution or private write capabilities', () => {
  const flags = { SHADOW_MODE_ENABLED: 'true', PRIVATE_READ_ENABLED: 'true' };
  assert.throws(() => parseExecutionSafety({ ...flags, REAL_EXECUTION_ENABLED: 'true' }));
  assert.throws(() => parseExecutionSafety({ ...flags, EXECUTION_MODE: 'shadow' }));
  for (const ex of ['bybit', 'okx'] as const) {
    assert.equal(EXCHANGE_CAPABILITIES[ex].privateTrade, false);
    assert.equal(EXCHANGE_CAPABILITIES[ex].withdrawal, false);
    assert.throws(() => new DisabledLiveExecutionAdapter(ex).submitOrder({} as OrderRequest));
  }
});
test('paper startup rejects enabled shadow without private reads before network/recovery', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/paper.ts'], {
    env: { PATH: process.env.PATH, PRIVATE_READ_ENABLED: 'false', SHADOW_MODE_ENABLED: 'true' }, timeout: 15000,
  }), (error: unknown) => {
    const failure = error as { code: number; stdout: string; stderr: string };
    assert.equal(failure.code, 1); assert.match(failure.stderr, /CONFIG/);
    assert.doesNotMatch(failure.stdout, /connected|recovery_empty|runtime_started/); return true;
  });
});
test('shadow check defaults to offline fixture despite private flags and nonexistent credential path', async () => {
  const output = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/shadow-check.ts'], {
    env: { PATH: process.env.PATH, PRIVATE_READ_ENABLED: 'true', SHADOW_MODE_ENABLED: 'true', BYBIT_API_KEY_FILE: '/nonexistent/unused-by-shadow-mock' }, timeout: 15000,
  });
  const value = JSON.parse(output.stdout) as { mode: string; deterministic: boolean };
  assert.equal(value.mode, 'SYNTHETIC_ONLY'); assert.equal(value.deterministic, true);
});
