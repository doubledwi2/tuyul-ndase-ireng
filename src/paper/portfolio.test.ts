import assert from 'node:assert/strict';
import test from 'node:test';

import { INITIAL_PAPER_BALANCES } from '../config/paper.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import { createPaperBalances } from './balances.js';
import {
  calculatePaperInventory,
  calculateReferenceBtcPrice,
  valuePaperPortfolio,
} from './portfolio.js';

function book(
  exchange: 'bybit' | 'okx',
  bid: number,
  ask: number,
): NormalizedOrderBook {
  return {
    exchange,
    symbol: 'BTC/USDT',
    bids: [{ price: bid, size: 1 }],
    asks: [{ price: ask, size: 1 }],
    exchangeTimestamp: 1_000,
    matchingEngineTimestamp: null,
    receivedTimestamp: 1_000,
  };
}

test('paper inventory totals initial BTC and USDT', () => {
  const balances = createPaperBalances({
    bybit: { ...INITIAL_PAPER_BALANCES.bybit },
    okx: { ...INITIAL_PAPER_BALANCES.okx },
  });
  assert.deepEqual(calculatePaperInventory(balances), {
    totalBTC: 0.2,
    totalUSDT: 20_000,
  });
});

test('reference price is deterministic average of both venue mid-prices', () => {
  const result = calculateReferenceBtcPrice(
    book('bybit', 99, 101),
    book('okx', 103, 105),
  );
  assert.equal(result, 102);
});

test('portfolio valuation marks total BTC to the reference price', () => {
  const balances = createPaperBalances({
    bybit: { ...INITIAL_PAPER_BALANCES.bybit },
    okx: { ...INITIAL_PAPER_BALANCES.okx },
  });
  assert.equal(valuePaperPortfolio(balances, 100_000), 40_000);
});

test('portfolio valuation reflects inventory and USDT changes after trade', () => {
  const balances = createPaperBalances({
    bybit: {
      ...INITIAL_PAPER_BALANCES.bybit,
      btcAvailable: 0.11,
      usdtAvailable: 9_998.999,
    },
    okx: {
      ...INITIAL_PAPER_BALANCES.okx,
      btcAvailable: 0.09,
      usdtAvailable: 10_001.02897,
    },
  });
  assert.ok(Math.abs(valuePaperPortfolio(balances, 101.5) - 20_020.32797) < 1e-9);
});

test('repeated portfolio valuation does not mutate balances', () => {
  const balances = createPaperBalances({
    bybit: { ...INITIAL_PAPER_BALANCES.bybit },
    okx: { ...INITIAL_PAPER_BALANCES.okx },
  });
  const before = structuredClone(balances);
  assert.equal(valuePaperPortfolio(balances, 100), 20_020);
  assert.equal(valuePaperPortfolio(balances, 100), 20_020);
  assert.deepEqual(balances, before);
});
