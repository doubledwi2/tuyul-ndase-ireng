import { MAX_INSTRUMENT_RULE_AGE_MS } from './config.js';
import { commonStepQuantity, compareDecimal, decimal, onStep } from './rounding.js';
import type { CrossVenueRuleAssessment, Exchange, InstrumentRules, OrderRuleAssessment, RuleReason, RuleSnapshots } from './types.js';
export const EMPTY_RULES: RuleSnapshots = { bybit: null, okx: null };
export function rulesFresh(r: InstrumentRules | null, at: number): boolean {
  return !!r && Number.isSafeInteger(r.receivedAt) && r.receivedAt >= 0 && Number.isFinite(at) && r.receivedAt <= at && at - r.receivedAt <= MAX_INSTRUMENT_RULE_AGE_MS;
}
export function assessOrderRules(exchange: Exchange, rule: InstrumentRules | null, at: number,
  target: number, quantity: number | null, notional: number | null): OrderRuleAssessment {
  const reasons: RuleReason[] = [];
  const result = (valid: OrderRuleAssessment['valid']): OrderRuleAssessment => ({ exchange, valid,
    normalizedQuantity: quantity, reasons, rulesReceivedAt: rule?.receivedAt ?? null });
  if (!rule || rule.exchange !== exchange || rule.symbol !== 'BTC/USDT') { reasons.push('UNKNOWN_RULES'); return result('UNKNOWN'); }
  if (!rulesFresh(rule, at)) { reasons.push(rule.receivedAt > at ? 'RULE_FUTURE' : 'RULE_STALE'); return result('UNKNOWN'); }
  if (rule.instrumentStatus === 'UNKNOWN') { reasons.push('UNKNOWN_RULES'); return result('UNKNOWN'); }
  if (rule.instrumentStatus !== 'TRADABLE') reasons.push('NOT_TRADABLE');
  if (!Number.isFinite(target) || target <= 0 || quantity === null || !Number.isFinite(quantity) || quantity <= 0) reasons.push('NOT_EXECUTABLE_RULES');
  else {
    if (!onStep(quantity, rule.quantityStep)) reasons.push('STEP_MISMATCH');
    if (rule.exact.minQuantity && compareDecimal(decimal(quantity), rule.exact.minQuantity) < 0) reasons.push('BELOW_MIN_QUANTITY');
  }
  if (Number.isFinite(target) && target > 0 && rule.exact.maxQuantity && compareDecimal(decimal(target), rule.exact.maxQuantity) > 0) reasons.push('ABOVE_MAX_QUANTITY');
  if (quantity === null && Number.isFinite(target) && target > 0 && rule.exact.minQuantity && compareDecimal(decimal(target), rule.exact.minQuantity) < 0) reasons.push('BELOW_MIN_QUANTITY');
  const complete = notional !== null && Number.isFinite(notional) && notional > 0;
  if (complete) {
    if (rule.exact.minNotional && compareDecimal(decimal(notional), rule.exact.minNotional) < 0) reasons.push('BELOW_MIN_NOTIONAL');
    if (rule.exact.maxNotional && compareDecimal(decimal(notional), rule.exact.maxNotional) > 0) reasons.push('ABOVE_MAX_NOTIONAL');
  }
  const invalid = reasons.length > 0;
  if (!complete) reasons.push('NOTIONAL_UNAVAILABLE');
  if (rule.maxNotionalUsd) reasons.push('USD_CONVERSION_UNAVAILABLE');
  return result(invalid ? 'INVALID' : reasons.length ? 'UNKNOWN' : 'VALID');
}
// Notional callback must re-simulate at q, never scale configured-target economics.
export function assessCrossVenueRules(target: number, snapshots: RuleSnapshots, at: number,
  notionals: (q: number) => Record<Exchange, number | null>): CrossVenueRuleAssessment {
  const { bybit, okx } = snapshots;
  const commonQuantity = bybit && okx && rulesFresh(bybit, at) && rulesFresh(okx, at)
    ? commonStepQuantity(target, bybit, okx) : null;
  const n = commonQuantity === null ? { bybit: null, okx: null } : notionals(commonQuantity);
  const b = assessOrderRules('bybit', bybit, at, target, commonQuantity, n.bybit);
  const o = assessOrderRules('okx', okx, at, target, commonQuantity, n.okx);
  // Missing counterpart doesn't mean the available venue's quantity is invalid.
  if (commonQuantity === null && (!rulesFresh(bybit, at) || !rulesFresh(okx, at))) {
    for (const v of [b, o]) if (v.reasons.includes('NOT_EXECUTABLE_RULES')) {
      v.reasons = v.reasons.filter(r => r !== 'NOT_EXECUTABLE_RULES'); v.reasons.push('UNKNOWN_RULES');
      v.valid = v.reasons.some(r => ['NOT_TRADABLE', 'ABOVE_MAX_QUANTITY', 'BELOW_MIN_QUANTITY'].includes(r)) ? 'INVALID' : 'UNKNOWN';
    }
  }
  return { targetQuantity: target, commonQuantity, bybit: b, okx: o,
    status: b.valid === 'INVALID' || o.valid === 'INVALID' ? 'NOT_EXECUTABLE' : b.valid === 'VALID' && o.valid === 'VALID' ? 'EXECUTABLE' : 'UNKNOWN' };
}
