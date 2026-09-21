import assert from 'node:assert/strict';
import test from 'node:test';

import { INITIAL_PAPER_BALANCES } from '../config/paper.js';
import {
  applyPaperBuy,
  applyPaperSell,
  createPaperBalances,
  settlePaperTradeAtomically,
} from './balances.js';

test('initial paper balances match the engineering baseline', () => {
  const balances = createPaperBalances({
    bybit: { ...INITIAL_PAPER_BALANCES.bybit },
    okx: { ...INITIAL_PAPER_BALANCES.okx },
  });
  assert.deepEqual(balances, {
    bybit: { exchange: 'bybit', btcAvailable: 0.1, usdtAvailable: 10_000 },
    okx: { exchange: 'okx', btcAvailable: 0.1, usdtAvailable: 10_000 },
  });
});

test('paper buy adds BTC and deducts notional plus fee', () => {
  const result = applyPaperBuy(INITIAL_PAPER_BALANCES.bybit, 1_000, 1, 0.01);
  assert.equal(result.btcAvailable, 0.11);
  assert.equal(result.usdtAvailable, 8_999);
});

test('paper sell deducts BTC and credits notional minus fee', () => {
  const result = applyPaperSell(INITIAL_PAPER_BALANCES.okx, 1_100, 1.1, 0.01);
  assert.ok(Math.abs(result.btcAvailable - 0.09) < 1e-12);
  assert.ok(Math.abs(result.usdtAvailable - 11_098.9) < 1e-12);
});

test('paper buy rejects insufficient USDT', () => {
  assert.throws(
    () => applyPaperBuy(INITIAL_PAPER_BALANCES.bybit, 10_000, 1, 0.01),
    /Insufficient paper USDT/,
  );
});

test('paper sell rejects insufficient BTC', () => {
  assert.throws(
    () => applyPaperSell(INITIAL_PAPER_BALANCES.okx, 11_000, 11, 0.11),
    /Insufficient paper BTC/,
  );
});

test('near-zero residual is clamped and never becomes negative', () => {
  const result = applyPaperSell(INITIAL_PAPER_BALANCES.okx, 10_000, 0, 0.1);
  assert.equal(result.btcAvailable, 0);
  assert.ok(result.btcAvailable >= 0);
  assert.throws(
    () =>
      applyPaperSell(
        { ...INITIAL_PAPER_BALANCES.okx, usdtAvailable: 0 },
        1,
        2,
        0.01,
      ),
    /negative USDT/,
  );
});

test('atomic settlement leaves input balances unchanged if either leg fails', () => {
  const balances = createPaperBalances({
    bybit: { ...INITIAL_PAPER_BALANCES.bybit },
    okx: { ...INITIAL_PAPER_BALANCES.okx, btcAvailable: 0 },
  });
  const before = structuredClone(balances);
  assert.throws(() =>
    settlePaperTradeAtomically(balances, {
      buyExchange: 'bybit',
      sellExchange: 'okx',
      buyNotional: 1,
      sellNotional: 1.03,
      buyFee: 0.001,
      sellFee: 0.00103,
      buyFilledSize: 0.01,
      sellFilledSize: 0.01,
    }),
  );
  assert.deepEqual(balances, before);
});
