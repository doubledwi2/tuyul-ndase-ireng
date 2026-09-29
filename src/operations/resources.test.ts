import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationalStateManager } from './operational-state.js';
import { getHealthHttpResponse } from './health-server.js';
import { ResourceMonitor, delayMilliseconds, persistenceReady } from './resources.js';
import { LatencyPaperTradingEngine } from '../paper/latency-engine.js';
import { positiveEnv, operationalConfigSnapshot } from '../config/runtime.js';
import type { PersistenceHealth } from '../persistence/durable-paper-state.js';

test('connected but silent feeds block readiness and entries; fresh books recover', () => {
  let now = 1000;
  const state = new OperationalStateManager(() => now, 5000);
  state.beginRecovery(); state.completeRecovery();
  state.setFeedConnected('bybit', true); state.setFeedConnected('okx', true);
  state.observeTiming('SYNC_HEALTHY', 'HEALTHY');
  assert.equal(state.canAcceptPaperEntry(), false);
  state.observeBook('bybit'); state.observeBook('okx');
  assert.equal(state.canAcceptPaperEntry(), true);
  now += 5001;
  assert.equal(state.canAcceptPaperEntry(), false);
  const health = state.getHealth(new LatencyPaperTradingEngine().getRiskSummary());
  assert.equal(getHealthHttpResponse('GET', '/ready', health).statusCode, 503);
  assert.ok(health.readinessReasons?.includes('FEED_SILENT'));
  state.observeBook('bybit'); state.observeBook('okx');
  assert.equal(state.canAcceptPaperEntry(), true);
});
test('event loop metrics tolerate no samples and serialize finite values', () => {
  const monitor = new ResourceMonitor();
  try {
    assert.deepEqual(monitor.snapshot().eventLoopDelayMs, { p50: null, p95: null, p99: null, max: null });
    assert.doesNotMatch(JSON.stringify(monitor.snapshot()), /NaN|Infinity/);
    assert.equal(delayMilliseconds(Infinity), null);
    assert.equal(delayMilliseconds(1e6), 1);
  } finally { monitor.close(); }
});
test('disk, dirty checkpoint age and queue guard; idle checkpoint stays healthy', () => {
  const health: PersistenceHealth = { checkpointHealthy: true, journalHealthy: true, lastCheckpointAt: 0,
    lastJournalSeq: 0, lastError: null, journalBytes: 0, queueDepth: 0, dirtySince: null, directorySyncSupported: true };
  assert.equal(persistenceReady(health, 1e12, 1e9), true);
  assert.equal(persistenceReady({ ...health, dirtySince: 1 }, 1e12, 1e9), false);
  assert.equal(persistenceReady({ ...health, queueDepth: 1001 }, 1e12, 100), false);
  assert.equal(persistenceReady(health, 100, 100), false);
  assert.equal(persistenceReady(health, null, 100), true);
});
test('operational env rejects invalid numbers and snapshot is allowlisted', () => {
  for (const value of ['', '-1', '0', 'NaN', 'Infinity', '1.5']) assert.throws(() => positiveEnv('X', 1, { X: value }));
  assert.equal(positiveEnv('X', 7, {}), 7);
  assert.equal('PATH' in operationalConfigSnapshot(), false);
});
