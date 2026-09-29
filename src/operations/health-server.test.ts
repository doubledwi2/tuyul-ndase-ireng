import assert from 'node:assert/strict';
import test from 'node:test';

import { getHealthHttpResponse } from './health-server.js';
import {
  OperationalStateManager,
  type ServiceHealth,
} from './operational-state.js';

function health(
  overrides: Partial<ServiceHealth> = {},
): ServiceHealth {
  return {
    market: { bybitConnected: true, okxConnected: true },
    timing: { syncStatus: 'SYNC_HEALTHY', clockHealth: 'HEALTHY' },
    persistence: {
      checkpointHealthy: true,
      journalHealthy: true,
      lastCheckpointAt: 1,
    },
    paper: {
      operationalState: 'RUNNING',
      riskState: 'RUNNING',
      openTrades: 0,
      residualExposure: 0,
    },
    ...overrides,
  };
}

test('health server separates liveness, readiness, and sanitized health', () => {
  const warming = health({
    paper: {
      operationalState: 'WARMING_UP',
      riskState: 'RUNNING',
      openTrades: 0,
      residualExposure: 0,
    },
  });
  assert.equal(getHealthHttpResponse('GET', '/live', warming).statusCode, 200);
  assert.equal(getHealthHttpResponse('GET', '/ready', warming).statusCode, 503);

  const running = health();
  assert.equal(getHealthHttpResponse('GET', '/ready', running).statusCode, 200);

  const unhealthy = health({
    persistence: {
      checkpointHealthy: false,
      journalHealthy: true,
      lastCheckpointAt: 1,
    },
  });
  assert.equal(
    getHealthHttpResponse('GET', '/ready', unhealthy).statusCode,
    503,
  );
  const response = getHealthHttpResponse('GET', '/health', unhealthy);
  const body = JSON.stringify(response.body);
  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(body.toLowerCase(), /api.?key|secret|credential/);
  assert.deepEqual(response.body, unhealthy);
});

test('operational state requires recovery, feeds, timing, and persistence', () => {
  const state = new OperationalStateManager();
  assert.equal(state.getState(), 'STARTING');
  state.beginRecovery();
  assert.equal(state.getState(), 'RECOVERING');
  state.completeRecovery();
  assert.equal(state.getState(), 'WARMING_UP');
  state.setFeedConnected('bybit', true);
  state.setFeedConnected('okx', true);
  state.observeBook('bybit');
  state.observeBook('okx');
  state.observeTiming('SYNC_HEALTHY', 'HEALTHY');
  assert.equal(state.getState(), 'RUNNING');
  assert.equal(state.canAcceptPaperEntry(), true);
  state.setPersistenceHealth({
    checkpointHealthy: true,
    journalHealthy: false,
    lastCheckpointAt: 1,
  });
  assert.equal(state.getState(), 'DEGRADED');
  assert.equal(state.canAcceptPaperEntry(), false);
  state.beginShutdown();
  assert.equal(state.getState(), 'SHUTTING_DOWN');
});
