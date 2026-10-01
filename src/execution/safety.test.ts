import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { parseExecutionSafety, ExecutionSafetyError } from './safety.js';
import { EXCHANGE_CAPABILITIES, requirePrivateCapability } from './capabilities.js';
import { DisabledLiveExecutionAdapter } from './disabled-live-adapter.js';
import { PaperExecutionAdapter } from './paper-adapter.js';
import { LatencyPaperTradingEngine } from '../paper/latency-engine.js';
import type { LatencyPaperExecutionInput } from '../paper/latency-engine.js';
import { createClientOrderId, validClientOrderId, createOrderIntent, type OrderRequest } from './orders.js';

test('default safety is paper; only private read capability is available', () => {
  assert.deepEqual(parseExecutionSafety({}), { mode: 'paper', realExecutionEnabled: false, killSwitch: true });
  assert.equal(new PaperExecutionAdapter(new LatencyPaperTradingEngine()).mode, 'paper');
  for (const exchange of ['bybit', 'okx'] as const) {
    assert.deepEqual(EXCHANGE_CAPABILITIES[exchange], { publicMarketData: true, privateRead: true, privateTrade: false, withdrawal: false });
    assert.doesNotThrow(() => requirePrivateCapability(exchange, 'privateRead'));
    assert.throws(() => requirePrivateCapability(exchange, 'privateTrade'), ExecutionSafetyError);
    assert.throws(() => requirePrivateCapability(exchange, 'withdrawal'), ExecutionSafetyError);
    assert.ok(Object.isFrozen(EXCHANGE_CAPABILITIES[exchange]));
  }
});
test('real enable, unknown modes and malformed booleans fail closed', () => {
  assert.throws(() => parseExecutionSafety({ REAL_EXECUTION_ENABLED: 'true' }), /Real execution is not implemented\/enabled in Phase 5.2\./);
  for (const mode of ['real', 'live', 'disabled-live', '', 'PAPER']) assert.throws(() => parseExecutionSafety({ EXECUTION_MODE: mode }));
  for (const value of ['', '1', 'FALSE', 'yes']) assert.throws(() => parseExecutionSafety({ EXECUTION_KILL_SWITCH: value }));
  assert.equal(parseExecutionSafety({ EXECUTION_KILL_SWITCH: 'false' }).realExecutionEnabled, false);
});
test('every disabled adapter method throws even with kill switch off', () => {
  parseExecutionSafety({ EXECUTION_KILL_SWITCH: 'false' });
  for (const exchange of ['bybit', 'okx'] as const) {
    const adapter = new DisabledLiveExecutionAdapter(exchange);
    assert.equal(adapter.approval.approved, false);
    assert.throws(() => adapter.submitOrder({} as OrderRequest), ExecutionSafetyError);
    assert.throws(() => adapter.cancelOrder('id', 1), ExecutionSafetyError);
    assert.throws(() => adapter.getOrderStatus('id'), ExecutionSafetyError);
  }
});
test('paper readiness blocks before touching engine', () => {
  const engine = new LatencyPaperTradingEngine();
  const adapter = new PaperExecutionAdapter(engine, () => false);
  assert.equal(adapter.getApproval().approved, false);
  assert.equal(adapter.submitOrder({} as LatencyPaperExecutionInput), null);
  assert.equal(engine.getTrades().length, 0);
});
test('client IDs are bounded, opaque and valid; intents are immutable and reproducible with explicit IDs', () => {
  const ids = new Set(Array.from({ length: 1000 }, createClientOrderId));
  assert.equal(ids.size, 1000);
  for (const id of ids) { assert.equal(validClientOrderId(id), true); assert.ok(id.length <= 32); }
  for (const id of ['', 'user@example.com', 'bad/id', 'x'.repeat(100)]) assert.equal(validClientOrderId(id), false);
  const request: OrderRequest = { clientOrderId: createClientOrderId(), exchange: 'bybit', symbol: 'BTC/USDT', side: 'BUY', type: 'MARKET', quantity: 0.01 };
  const intentId = createClientOrderId();
  const intent = createOrderIntent(request, 'trade-1', 100, intentId);
  assert.ok(Object.isFrozen(intent));
  assert.deepEqual(intent, createOrderIntent(request, 'trade-1', 100, intentId));
  assert.throws(() => createOrderIntent({ ...request, quantity: NaN }, 'trade-1', 100));
  assert.throws(() => createOrderIntent({ ...request, type: 'LIMIT' }, 'trade-1', 100));
});
test('paper startup refuses real mode before network or runtime lock', async () => {
  for (const settings of [{ EXECUTION_MODE: 'real' }, { REAL_EXECUTION_ENABLED: 'true' }]) {
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/paper.ts'], {
      env: { ...process.env, ...settings }, timeout: 15000,
    }), (error: unknown) => {
      const failure = error as { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr, /Phase 5.2/);
      assert.doesNotMatch(failure.stdout, /connected|recovery_empty|runtime_started/);
      return true;
    });
  }
});
test('execution modules have no network transport, authentication or private endpoints', async () => {
  for (const name of await readdir('src/execution')) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    const source = await readFile(`src/execution/${name}`, 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(|\bWebSocket\b|from ['"](?:node:)?(?:https?|net|tls|ws)['"]|createHmac|https?:\/\//);
  }
});
