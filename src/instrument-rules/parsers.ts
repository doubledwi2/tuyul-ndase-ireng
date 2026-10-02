import { decimal } from './rounding.js';
import type { DecimalRule, InstrumentRules, Exchange } from './types.js';

export class RuleError extends Error {
  constructor(readonly category: 'SCHEMA' | 'HTTP' | 'NETWORK' | 'TIMEOUT' | 'BODY_LIMIT' | 'API',
    readonly status: number | null = null, readonly transient = false) { super(category); }
}
function obj(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new RuleError('SCHEMA');
  return x as Record<string, unknown>;
}
function positive(x: unknown): DecimalRule {
  if (typeof x !== 'string') throw new RuleError('SCHEMA');
  try { const d = decimal(x); if (d.units <= 0n || Number(x) <= 0) throw new Error(); return d; }
  catch { throw new RuleError('SCHEMA'); }
}
// An explicitly empty optional API field is unavailable/not supplied, not zero.
function optional(x: unknown): DecimalRule | null { return x === '' ? null : positive(x); }
export function parseInstrumentRules(exchange: Exchange, payload: unknown, receivedAt: number): InstrumentRules {
  if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) throw new RuleError('SCHEMA');
  const root = obj(payload);
  let tick: DecimalRule, step: DecimalRule, min: DecimalRule | null, max: DecimalRule | null;
  let minValue: DecimalRule | null, maxValue: DecimalRule | null, usd: DecimalRule | null = null;
  let status: unknown;
  if (exchange === 'bybit') {
    if (root.retCode !== 0) throw new RuleError(typeof root.retCode === 'number' ? 'API' : 'SCHEMA');
    const result = obj(root.result);
    if (result.category !== 'spot' || !Array.isArray(result.list) || result.list.length !== 1) throw new RuleError('SCHEMA');
    const row = obj(result.list[0]);
    if (row.symbol !== 'BTCUSDT' || row.baseCoin !== 'BTC' || row.quoteCoin !== 'USDT') throw new RuleError('SCHEMA');
    const lot = obj(row.lotSizeFilter);
    tick = positive(obj(row.priceFilter).tickSize); step = positive(lot.basePrecision);
    // Current Spot schema deprecates minOrderQty/maxOrderQty/maxOrderAmt.
    min = null; max = positive(lot.maxMarketOrderQty); minValue = positive(lot.minOrderAmt); maxValue = null;
    status = row.status;
  } else {
    if (root.code !== '0') throw new RuleError(typeof root.code === 'string' ? 'API' : 'SCHEMA');
    if (!Array.isArray(root.data) || root.data.length !== 1) throw new RuleError('SCHEMA');
    const row = obj(root.data[0]);
    if (row.instType !== 'SPOT' || row.instId !== 'BTC-USDT' || row.baseCcy !== 'BTC' || row.quoteCcy !== 'USDT') throw new RuleError('SCHEMA');
    tick = positive(row.tickSz); step = positive(row.lotSz); min = positive(row.minSz);
    max = null; minValue = null;
    // Official Spot maxMktSz is USDT, NOT base BTC; maxMktAmt is USD.
    maxValue = positive(row.maxMktSz); usd = optional(row.maxMktAmt); status = row.state;
  }
  if (typeof status !== 'string') throw new RuleError('SCHEMA');
  const tradable = status === (exchange === 'bybit' ? 'Trading' : 'live');
  const inactive = ['suspend', 'preopen', 'test', 'post_only', 'rebase', 'settling', 'Closed', 'Settled', 'PreLaunch', 'PendingOpen'];
  return { exchange, symbol: 'BTC/USDT', priceTick: tick, quantityStep: step,
    minQuantity: min ? Number(min.raw) : null, maxQuantity: max ? Number(max.raw) : null,
    minNotional: minValue ? Number(minValue.raw) : null, maxNotional: maxValue ? Number(maxValue.raw) : null,
    exact: { minQuantity: min, maxQuantity: max, minNotional: minValue, maxNotional: maxValue }, maxNotionalUsd: usd,
    instrumentStatus: tradable ? 'TRADABLE' : inactive.includes(status) ? 'NOT_TRADABLE' : 'UNKNOWN', receivedAt };
}
