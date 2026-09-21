import assert from 'node:assert/strict';
import test from 'node:test';

import type { PaperExecutionConfig } from '../config/paper.js';
import type { TimingConfig } from '../config/timing.js';
import { runLatencyPaperReplay } from './latency-replay.js';
import type { PaperTradeOutcome } from './types.js';

const TIMING: TimingConfig = {
  maxReceiveSkewMs: 100,
  maxBookAgeMs: 500,
  maxSourceTimestampSkewMs: 250,
  clockJumpThresholdMs: 50,
  minOffsetSamples: 1,
  offsetWindowSize: 10,
  maxOffsetDeviationMs: 100,
};

const QUALITY = {
  minNetSpreadPercent: 0.03,
  minNetPnlUsdt: 0.01,
  minActiveDurationMs: 0,
  maxSyncDiffMsForQualified: 100,
};

interface FixtureExpectation {
  name: string;
  outcome: PaperTradeOutcome;
  fills: number;
  residual: number;
  config?: Partial<PaperExecutionConfig>;
}

const CASES: FixtureExpectation[] = [
  { name: 'clean-fill', outcome: 'CLEAN_FILL', fills: 2, residual: 0 },
  {
    name: 'buy-only',
    outcome: 'BUY_ONLY',
    fills: 1,
    residual: 0.01,
    config: { allowPartialFill: false, maxUnhedgedDurationMs: 300 },
  },
  {
    name: 'sell-only',
    outcome: 'SELL_ONLY',
    fills: 1,
    residual: -0.01,
    config: { allowPartialFill: false, maxUnhedgedDurationMs: 300 },
  },
  {
    name: 'partial-mismatch',
    outcome: 'PARTIAL_BOTH',
    fills: 2,
    residual: 0.002,
    config: { maxUnhedgedDurationMs: 300 },
  },
  {
    name: 'timeout-no-fill',
    outcome: 'TIMEOUT_NO_FILL',
    fills: 0,
    residual: 0,
    config: { allowPartialFill: false },
  },
  { name: 'unwind-success', outcome: 'UNWOUND', fills: 3, residual: 0 },
  {
    name: 'unwind-failure',
    outcome: 'UNWIND_FAILED',
    fills: 3,
    residual: 0.003,
  },
];

async function runFixture(fixture: FixtureExpectation) {
  let nextId = 0;
  return runLatencyPaperReplay({
    filePath: `fixtures/paper-3.1/${fixture.name}.jsonl`,
    speed: 'max',
    timingConfig: TIMING,
    qualityConfig: QUALITY,
    engineOptions: {
      executionConfig: {
        buyOrderLatencyMs: 50,
        sellOrderLatencyMs: 50,
        orderTimeoutMs: 250,
        maxUnhedgedDurationMs: 200,
        allowPartialFill: true,
        ...fixture.config,
      },
      idGenerator: () => `paper-${++nextId}`,
    },
  });
}

for (const fixture of CASES) {
  test(`latency replay fixture ${fixture.name} has deterministic ${fixture.outcome} outcome`, async () => {
    const first = await runFixture(fixture);
    const second = await runFixture(fixture);
    const trade = first.trades[0];

    assert.equal(first.trades.length, 1);
    assert.equal(trade?.outcome, fixture.outcome);
    assert.equal(first.fills.length, fixture.fills);
    assert.ok(
      Math.abs((trade?.residualBaseExposure ?? Number.NaN) - fixture.residual) <
        1e-12,
    );
    assert.equal(first.summary.balances.bybit.btcReserved, 0);
    assert.equal(first.summary.balances.bybit.usdtReserved, 0);
    assert.equal(first.summary.balances.okx.btcReserved, 0);
    assert.equal(first.summary.balances.okx.usdtReserved, 0);
    assert.ok(Number.isFinite(first.summary.netTradePnl));

    assert.deepEqual(second.summary, first.summary);
    assert.deepEqual(second.metrics, first.metrics);
    assert.deepEqual(second.orders, first.orders);
    assert.deepEqual(second.fills, first.fills);
  });
}
