import type { BestQuote } from '../types/market.js';

export interface ExchangeFeeConfig {
  takerRate: number;
}

export type FeeConfig = Readonly<
  Record<BestQuote['exchange'], Readonly<ExchangeFeeConfig>>
>;

// Baseline only. Actual fees may vary by VIP tier, region, promotion,
// and account-specific pricing.
export const FEES: FeeConfig = {
  bybit: {
    takerRate: 0.001,
  },
  okx: {
    takerRate: 0.001,
  },
};
