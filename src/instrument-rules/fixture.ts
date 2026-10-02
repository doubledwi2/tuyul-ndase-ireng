import { decimal } from './rounding.js';
import type { InstrumentRules, Exchange } from './types.js';
// Synthetic rules, deliberately NOT claims about live exchange filters.
export function ruleFixture(exchange: Exchange, receivedAt: number, step = '0.00001'): InstrumentRules {
  return { exchange, symbol: 'BTC/USDT', priceTick: decimal('0.01'), quantityStep: decimal(step),
    minQuantity: 0.00001, maxQuantity: 100, minNotional: 0.01, maxNotional: null,
    exact: { minQuantity: decimal('0.00001'), maxQuantity: decimal('100'), minNotional: decimal('0.01'), maxNotional: null },
    maxNotionalUsd: null, instrumentStatus: 'TRADABLE', receivedAt };
}
