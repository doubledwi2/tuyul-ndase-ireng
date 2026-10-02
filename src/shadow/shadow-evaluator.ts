import { FEES, type FeeConfig } from '../config/fees.js';
import { assessCrossVenueRules, EMPTY_RULES } from '../instrument-rules/validator.js';
import { TARGET_BTC_SIZE } from '../config/simulation.js';
import { TIMING_CONFIG } from '../config/timing.js';
import { MAX_BALANCE_AGE_MS, MAX_DIAGNOSTIC_AGE_MS } from '../private-read/config.js';
import type { Exchange } from '../private-read/types.js';
import { simulateExecution } from '../scanner/execution-simulator.js';
import { isValidNormalizedOrderBook } from '../types/orderbook.js';
import type { FundingStatus, ShadowAssessment, ShadowDirection, ShadowInput } from './shadow-types.js';

export function freshAt(receivedAt: number | null | undefined, at: number, maxAge: number): boolean {
  return receivedAt != null && Number.isFinite(receivedAt) && receivedAt <= at && at - receivedAt <= maxAge;
}
const validRate = (rate: number) => Number.isFinite(rate) && Math.abs(rate) <= 0.05;

// Pure: no wall clock, I/O, account mutation, reservations or paper-engine calls.
export function evaluateShadow(input: ShadowInput, target = TARGET_BTC_SIZE, baseline: FeeConfig = FEES): ShadowAssessment {
  const at = input.evaluatedAt;
  if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(target) || target <= 0) throw new RangeError('Invalid shadow decision time or target.');
  const result: Omit<ShadowAssessment, 'directions'> = { evaluatedAt: at,
    feeSourceByExchange: { bybit: 'SIMULATION_FALLBACK', okx: 'SIMULATION_FALLBACK' },
    freshness: { bybit: { balance: false, fee: false, config: false, permission: false },
      okx: { balance: false, fee: false, config: false, permission: false } }, degraded: false, reasons: [] };
  const rates: Record<Exchange, number> = { bybit: baseline.bybit.takerRate, okx: baseline.okx.takerRate };
  for (const ex of ['bybit', 'okx'] as const) {
    if (!validRate(rates[ex]) || rates[ex] < 0) throw new RangeError('Invalid baseline fee.');
    const a = input.accounts[ex], f = a.fee, c = a.compatibility, p = a.permission;
    const fresh = result.freshness[ex];
    fresh.balance = a.balanceHealthy && a.balance?.exchange === ex && freshAt(a.balance.receivedAt, at, MAX_BALANCE_AGE_MS);
    fresh.fee = a.feeHealthy && f?.exchange === ex && f.symbol === 'BTC/USDT' && f.source === 'ACCOUNT_PRIVATE_READ' &&
      freshAt(f.receivedAt, at, MAX_DIAGNOSTIC_AGE_MS) && validRate(f.takerFeeRate.normalizedCostRate);
    fresh.config = !!c && c.healthy && c.value.exchange === ex && freshAt(c.receivedAt, at, MAX_DIAGNOSTIC_AGE_MS);
    fresh.permission = !!p && p.healthy && p.value.exchange === ex && freshAt(p.receivedAt, at, MAX_DIAGNOSTIC_AGE_MS) &&
      freshAt(p.value.checkedAt, at, MAX_DIAGNOSTIC_AGE_MS);
    if (fresh.fee && f) { rates[ex] = f.takerFeeRate.normalizedCostRate; result.feeSourceByExchange[ex] = 'ACCOUNT_OBSERVED'; }
    for (const category of ['balance', 'fee', 'config', 'permission'] as const) {
      if (!fresh[category]) result.reasons.push(`${ex.toUpperCase()}_${category.toUpperCase()}_UNAVAILABLE_OR_STALE`);
    }
    if (fresh.permission && p?.value.status === 'UNSAFE_WRITE_ENABLED') result.reasons.push('CREDENTIAL_PERMISSION_REVIEW_REQUIRED');
    if (!fresh.permission || p?.value.status === 'UNKNOWN') result.reasons.push('CREDENTIAL_PERMISSION_UNKNOWN');
    if (!fresh.config || c?.value.status === 'UNKNOWN') result.reasons.push('ACCOUNT_COMPATIBILITY_UNKNOWN');
    if (fresh.config && c?.value.status === 'INCOMPATIBLE') result.reasons.push('ACCOUNT_INCOMPATIBLE');
  }
  const booksValid = (['bybit', 'okx'] as const).every(ex => input.books[ex].exchange === ex && isValidNormalizedOrderBook(input.books[ex]) &&
    freshAt(input.books[ex].receivedTimestamp, at, TIMING_CONFIG.maxBookAgeMs));
  const healthy = booksValid && input.sync.status === 'SYNC_HEALTHY' && input.sync.reasons.length === 0 &&
    Math.abs(input.books.bybit.receivedTimestamp - input.books.okx.receivedTimestamp) <= TIMING_CONFIG.maxReceiveSkewMs;
  if (!booksValid) result.reasons.push('BOOK_UNAVAILABLE_OR_STALE');
  if (!healthy) result.reasons.push('SYNC_NOT_HEALTHY');
  function direction(buy: Exchange, sell: Exchange): ShadowDirection {
    let ruleCalibratedNetPnl: number | null = null;
    let ruleCalibratedBuyNotional: number | null = null, ruleCalibratedSellNotional: number | null = null;
    const ruleAssessment = assessCrossVenueRules(target, input.instrumentRules ?? EMPTY_RULES, at, quantity => {
      if (!healthy) return { bybit: null, okx: null };
      const rb = simulateExecution(input.books[buy], 'BUY', quantity), rs = simulateExecution(input.books[sell], 'SELL', quantity);
      ruleCalibratedBuyNotional = rb.fullyFilled && Number.isFinite(rb.notional) ? rb.notional : null;
      ruleCalibratedSellNotional = rs.fullyFilled && Number.isFinite(rs.notional) ? rs.notional : null;
      const net = rs.notional * (1 - rates[sell]) - rb.notional * (1 + rates[buy]);
      if (ruleCalibratedBuyNotional !== null && ruleCalibratedSellNotional !== null && Number.isFinite(net)) ruleCalibratedNetPnl = net;
      return buy === 'bybit' ? { bybit: ruleCalibratedBuyNotional, okx: ruleCalibratedSellNotional }
        : { bybit: ruleCalibratedSellNotional, okx: ruleCalibratedBuyNotional };
    });
    if (ruleAssessment.status !== 'EXECUTABLE') ruleCalibratedNetPnl = null;
    const b = booksValid ? simulateExecution(input.books[buy], 'BUY', target) : null;
    const s = booksValid ? simulateExecution(input.books[sell], 'SELL', target) : null;
    const complete = !!b?.fullyFilled && !!s?.fullyFilled;
    const baselineNetPnl = complete ? s.notional * (1 - baseline[sell].takerRate) - b.notional * (1 + baseline[buy].takerRate) : null;
    const shadowNetPnl = complete ? s.notional * (1 - rates[sell]) - b.notional * (1 + rates[buy]) : null;
    const finite = baselineNetPnl !== null && shadowNetPnl !== null && b !== null && b.notional > 0 &&
      [baselineNetPnl, shadowNetPnl, shadowNetPnl - baselineNetPnl,
        baselineNetPnl / b.notional * 100, shadowNetPnl / b.notional * 100].every(Number.isFinite);
    if (!complete) result.reasons.push('INSUFFICIENT_OR_UNAVAILABLE_DEPTH');
    if (complete && !finite) result.reasons.push('NON_FINITE_ECONOMICS');
    const fundingReasons: FundingStatus[] = [];
    for (const ex of [buy, sell]) {
      const a = input.accounts[ex], fresh = result.freshness[ex];
      if (!fresh.balance) fundingReasons.push('STALE_BALANCE');
      else {
        const available = ex === buy ? a.balance?.usdt.available : a.balance?.btc.available;
        if (available == null || !Number.isFinite(available) || available < 0) fundingReasons.push('UNKNOWN_AVAILABLE_BALANCE');
        else if (ex === sell) {
          if (available < target) fundingReasons.push('INSUFFICIENT_FUNDS');
        } else if (!complete || !b || !finite || !Number.isFinite(b.notional * (1 + Math.max(0, rates[buy])))) {
          fundingReasons.push('UNKNOWN_AVAILABLE_BALANCE');
        } else if (available < b.notional * (1 + Math.max(0, rates[buy]))) fundingReasons.push('INSUFFICIENT_FUNDS');
      }
      if (!fresh.config || a.compatibility?.value.status === 'UNKNOWN') fundingReasons.push('ACCOUNT_COMPATIBILITY_UNKNOWN');
      else if (a.compatibility?.value.status === 'INCOMPATIBLE') fundingReasons.push('ACCOUNT_INCOMPATIBLE');
    }
    const reasons = [...new Set(fundingReasons)];
    // Balance uncertainty is kept primary; all compatibility blockers remain visible.
    const primary = (['STALE_BALANCE', 'UNKNOWN_AVAILABLE_BALANCE', 'ACCOUNT_INCOMPATIBLE', 'ACCOUNT_COMPATIBILITY_UNKNOWN', 'INSUFFICIENT_FUNDS'] as const)
      .find(reason => reasons.includes(reason)) ?? 'FUNDED';
    return { ruleAssessment, ruleCalibratedNetPnl, ruleCalibratedBuyNotional, ruleCalibratedSellNotional,
      buyExchange: buy, sellExchange: sell, fundingStatus: primary, fundingReasons: reasons,
      economicsStatus: !finite || !healthy ? 'SHADOW_UNCERTAIN' : shadowNetPnl > 0 ? 'SHADOW_POSITIVE' : 'SHADOW_ZERO_OR_NEGATIVE',
      baselineNetPnl: finite ? baselineNetPnl : null, shadowNetPnl: finite ? shadowNetPnl : null,
      baselineNetSpread: finite && b ? baselineNetPnl / b.notional * 100 : null,
      shadowNetSpread: finite && b ? shadowNetPnl / b.notional * 100 : null,
      feeImpactUsdt: finite ? shadowNetPnl - baselineNetPnl : null };
  }
  const directions: ShadowAssessment['directions'] = [direction('bybit', 'okx'), direction('okx', 'bybit')];
  result.reasons = [...new Set(result.reasons)];
  result.degraded = result.reasons.length > 0;
  return { ...result, directions };
}
