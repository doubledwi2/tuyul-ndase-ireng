import assert from 'node:assert/strict';
import test from 'node:test';

import type { TimingConfig } from '../config/timing.js';
import { runPaperReplay } from './replay.js';

const FIXTURE_PATH = 'fixtures/paper-qualified-orderbooks.jsonl';

const TEST_TIMING_CONFIG: TimingConfig = {
  maxReceiveSkewMs: 100,
  maxBookAgeMs: 500,
  maxSourceTimestampSkewMs: 250,
  clockJumpThresholdMs: 50,
  minOffsetSamples: 1,
  offsetWindowSize: 10,
  maxOffsetDeviationMs: 100,
};

async function replayOnce() {
  let nextTradeId = 0;
  return runPaperReplay({
    filePath: FIXTURE_PATH,
    speed: 'max',
    timingConfig: TEST_TIMING_CONFIG,
    qualityConfig: {
      minNetSpreadPercent: 0.03,
      minNetPnlUsdt: 0.01,
      minActiveDurationMs: 100,
      maxSyncDiffMsForQualified: 100,
    },
    engineOptions: {
      idGenerator: () => `paper-trade-${++nextTradeId}`,
    },
  });
}

test('paper replay is deterministic for trades, balances, fees, PnL, and portfolio value', async () => {
  const first = await replayOnce();
  const second = await replayOnce();

  assert.equal(first.processedRecords, 4);
  assert.equal(first.summary.tradesFilled, 1);
  assert.equal(first.summary.tradesRejected, 0);
  assert.equal(first.trades[0]?.state, 'FILLED');
  assert.equal(first.trades[0]?.buyExchange, 'bybit');
  assert.equal(first.trades[0]?.sellExchange, 'okx');

  assert.deepEqual(second.summary, first.summary);
  assert.deepEqual(second.summary.balances, first.summary.balances);
  assert.equal(second.summary.feesPaid, first.summary.feesPaid);
  assert.equal(second.summary.netTradePnl, first.summary.netTradePnl);
  assert.equal(
    second.summary.currentPortfolioValueUsdt,
    first.summary.currentPortfolioValueUsdt,
  );
  assert.equal(second.trades[0]?.id, first.trades[0]?.id);
});
