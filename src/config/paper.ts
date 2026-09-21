import type { PaperBalance } from '../paper/balances.js';

// Engineering-only virtual balances. These are not capital recommendations.
export const INITIAL_PAPER_BALANCES: Readonly<
  Record<PaperBalance['exchange'], Readonly<PaperBalance>>
> = {
  bybit: {
    exchange: 'bybit',
    btcAvailable: 0.1,
    usdtAvailable: 10_000,
  },
  okx: {
    exchange: 'okx',
    btcAvailable: 0.1,
    usdtAvailable: 10_000,
  },
};

export const MAX_PAPER_TRIGGER_AGE_MS = 100;
export const PAPER_BALANCE_EPSILON = 1e-12;
