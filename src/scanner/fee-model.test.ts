import assert from 'node:assert/strict';
import test from 'node:test';

import { FEES, type FeeConfig } from '../config/fees.js';
import type { SpreadComparison } from './comparator.js';
import { calculateFeeAwareComparison } from './fee-model.js';

function comparison(
  overrides: Partial<SpreadComparison> = {},
): SpreadComparison {
  return {
    symbol: 'BTC/USDT',
    buyExchange: 'bybit',
    sellExchange: 'okx',
    buyPrice: 100,
    sellPrice: 101,
    grossSpreadAbsolute: 1,
    grossSpreadPercent: 1,
    tradableSize: 2,
    buyReceivedTimestamp: 1_000,
    sellReceivedTimestamp: 1_010,
    receiveTimeDifferenceMs: 10,
    status: 'SYNC_OK',
    ...overrides,
  };
}

test('calculates notionals, fees, total fee, and gross PnL', () => {
  const result = calculateFeeAwareComparison(comparison(), FEES);

  assert.equal(result.buyNotional, 200);
  assert.equal(result.sellNotional, 202);
  assert.equal(result.estimatedBuyFee, 0.2);
  assert.equal(result.estimatedSellFee, 0.202);
  assert.equal(result.estimatedTotalFee, 0.402);
  assert.equal(result.grossPnlAbsolute, 2);
});

test('calculates positive estimated net PnL and net spread percent', () => {
  const result = calculateFeeAwareComparison(comparison(), FEES);

  assert.ok(Math.abs(result.estimatedNetPnlAbsolute - 1.598) < 1e-12);
  assert.ok(Math.abs(result.estimatedNetSpreadPercent - 0.799) < 1e-12);
  assert.equal(result.feeStatus, 'NET_POSITIVE');
});

test('calculates negative estimated net PnL', () => {
  const result = calculateFeeAwareComparison(
    comparison({ sellPrice: 100.1, grossSpreadAbsolute: 0.1 }),
    FEES,
  );

  assert.ok(result.estimatedNetPnlAbsolute < 0);
  assert.equal(result.feeStatus, 'NET_ZERO_OR_NEGATIVE');
});

test('marks a stale comparison as STALE regardless of net value', () => {
  const result = calculateFeeAwareComparison(
    comparison({ status: 'STALE' }),
    FEES,
  );

  assert.equal(result.feeStatus, 'STALE');
});

test('zero estimated net is NET_ZERO_OR_NEGATIVE', () => {
  const noFees: FeeConfig = {
    bybit: { takerRate: 0 },
    okx: { takerRate: 0 },
  };
  const result = calculateFeeAwareComparison(
    comparison({ sellPrice: 100, grossSpreadAbsolute: 0, grossSpreadPercent: 0 }),
    noFees,
  );

  assert.equal(result.estimatedNetPnlAbsolute, 0);
  assert.equal(result.feeStatus, 'NET_ZERO_OR_NEGATIVE');
});

test('accepts custom fee configuration', () => {
  const customFees: FeeConfig = {
    bybit: { takerRate: 0.002 },
    okx: { takerRate: 0.003 },
  };
  const result = calculateFeeAwareComparison(comparison(), customFees);

  assert.equal(result.buyFeeRate, 0.002);
  assert.equal(result.sellFeeRate, 0.003);
  assert.equal(result.estimatedBuyFee, 0.4);
  assert.equal(result.estimatedSellFee, 0.606);
});

test('returns only finite calculated values for a valid comparison', () => {
  const result = calculateFeeAwareComparison(comparison(), FEES);
  const values = [
    result.buyNotional,
    result.sellNotional,
    result.estimatedBuyFee,
    result.estimatedSellFee,
    result.estimatedTotalFee,
    result.grossPnlAbsolute,
    result.estimatedNetPnlAbsolute,
    result.estimatedNetSpreadPercent,
  ];

  assert.ok(values.every(Number.isFinite));
  assert.throws(
    () => calculateFeeAwareComparison(comparison(), {
      bybit: { takerRate: Number.NaN },
      okx: { takerRate: 0.001 },
    }),
    RangeError,
  );
});
