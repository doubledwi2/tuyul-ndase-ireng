import type { DecimalRule, InstrumentRules, Exchange } from './types.js';

// Bounded exact positive decimal parsing, including explicitly expanded exponents.
export function decimal(value: string | number): DecimalRule {
  const raw = String(value);
  if (raw.length > 100) throw new RangeError('Invalid decimal.');
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!m) throw new RangeError('Invalid decimal.');
  const exponent = Number(m[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30) throw new RangeError('Invalid decimal exponent.');
  let scale = (m[2]?.length ?? 0) - exponent;
  let units = BigInt(m[1]! + (m[2] ?? ''));
  if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
  if (scale > 30 || !Number.isFinite(Number(raw))) throw new RangeError('Invalid decimal scale.');
  while (scale > 0 && units % 10n === 0n) { units /= 10n; scale--; }
  return { raw, scale, units };
}
const scaled = (d: DecimalRule, scale: number) => d.units * 10n ** BigInt(scale - d.scale);
export function compareDecimal(a: DecimalRule, b: DecimalRule): number {
  const scale = Math.max(a.scale, b.scale), x = scaled(a, scale), y = scaled(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}
export function decimalString(units: bigint, scale: number): string {
  const s = units.toString().padStart(scale + 1, '0');
  return scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s;
}
export function onStep(value: string | number, step: DecimalRule): boolean {
  try {
    const d = decimal(value), scale = Math.max(d.scale, step.scale);
    return d.units > 0n && step.units > 0n && scaled(d, scale) % scaled(step, scale) === 0n;
  } catch { return false; }
}
export function quantize(value: string | number, step: DecimalRule, up = false): string {
  const d = decimal(value), scale = Math.max(d.scale, step.scale);
  if (step.units <= 0n) throw new RangeError('Invalid step.');
  const n = scaled(d, scale), s = scaled(step, scale);
  return decimalString(((n + (up ? s - 1n : 0n)) / s) * s, scale);
}
export function commonStepQuantity(target: number, a: InstrumentRules, b: InstrumentRules): number | null {
  try {
    if (!Number.isFinite(target) || target <= 0) return null;
    const scale = Math.max(a.quantityStep.scale, b.quantityStep.scale);
    const x = scaled(a.quantityStep, scale), y = scaled(b.quantityStep, scale);
    if (x <= 0n || y <= 0n) return null;
    let g = x, h = y;
    while (h) { const r = g % h; g = h; h = r; }
    const q = Number(quantize(target, { raw: '', units: x / g * y, scale }));
    if (!Number.isFinite(q) || q <= 0 || q > target || !onStep(q, a.quantityStep) || !onStep(q, b.quantityStep)) return null;
    return q;
  } catch { return null; }
}
export function commonExecutableQuantity(target: number, a: InstrumentRules, b: InstrumentRules): number | null {
  const q = commonStepQuantity(target, a, b);
  if (q === null) return null;
  for (const rule of [a, b]) {
    if (rule.exact.minQuantity && compareDecimal(decimal(q), rule.exact.minQuantity) < 0) return null;
    if (rule.exact.maxQuantity && compareDecimal(decimal(target), rule.exact.maxQuantity) > 0) return null;
  }
  return q;
}
export function normalizeHypotheticalOrder(rules: InstrumentRules, exchange: Exchange, side: 'BUY' | 'SELL',
  quantity: number, orderType: 'MARKET' | 'LIMIT', price?: number) {
  if (rules.exchange !== exchange || quantity <= 0 || !Number.isFinite(quantity)) throw new RangeError('Invalid order intent.');
  const quantityDecimal = quantize(quantity, rules.quantityStep), normalizedQuantity = Number(quantityDecimal);
  if (orderType === 'LIMIT' && (price === undefined || price <= 0 || !Number.isFinite(price))) throw new RangeError('Limit price required.');
  // BUY floor avoids increasing spend; SELL ceil avoids reducing minimum proceeds.
  const priceDecimal = orderType === 'LIMIT' ? quantize(price!, rules.priceTick, side === 'SELL') : null;
  const normalizedPrice = priceDecimal === null ? null : Number(priceDecimal);
  return { exchange, side, orderType, originalQuantity: quantity, normalizedQuantity, quantityDecimal,
    originalPrice: price ?? null, normalizedPrice, priceDecimal,
    adjustments: [...(quantity !== normalizedQuantity ? ['QUANTITY_ROUNDED_DOWN'] : []),
      ...(orderType === 'LIMIT' && price !== normalizedPrice ? ['PRICE_ROUNDED_CONSERVATIVELY'] : [])] };
}
