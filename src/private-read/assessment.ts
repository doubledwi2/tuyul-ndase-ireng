import type { FeeConfig } from '../config/fees.js';
import { FEES } from '../config/fees.js';
import type { Exchange } from './types.js';
import type { AccountCompatibilityAssessment, AccountFeeSnapshot, BybitAccountConfig, CredentialSafetyAssessment, OkxAccountConfig } from './account-types.js';
import { MAX_FEE_DELTA } from './config.js';

export function assessBybitCompatibility(config: BybitAccountConfig | null): AccountCompatibilityAssessment {
  if (!config) return { exchange: 'bybit', status: 'UNKNOWN', reasons: ['CONFIG_UNAVAILABLE'] };
  if (config.unifiedMarginStatus === 1 || config.marginMode === 'PORTFOLIO_MARGIN' || config.spotHedgingStatus === 'ON') {
    return { exchange: 'bybit', status: 'INCOMPATIBLE', reasons: ['BYBIT_UNSUPPORTED_ACCOUNT_MODE'] };
  }
  // This endpoint describes UTA/derivatives margin settings, not whether spot
  // liabilities/borrowing are disabled. Do not infer cash-only compatibility.
  return { exchange: 'bybit', status: 'UNKNOWN', reasons: ['BYBIT_SPOT_CASH_SEMANTICS_UNVERIFIED'] };
}
export function assessOkxCompatibility(config: OkxAccountConfig | null): AccountCompatibilityAssessment {
  if (!config) return { exchange: 'okx', status: 'UNKNOWN', reasons: ['CONFIG_UNAVAILABLE'] };
  if (config.accountLevel !== '1' || config.positionMode !== 'net_mode' || config.autoBorrowEnabled === true || config.spotBorrowEnabled === true) {
    return { exchange: 'okx', status: 'INCOMPATIBLE', reasons: ['OKX_MARGIN_OR_BORROWING_MODE_UNSUPPORTED'] };
  }
  if (config.autoBorrowEnabled === null || config.spotBorrowEnabled === null) {
    return { exchange: 'okx', status: 'UNKNOWN', reasons: ['OKX_BORROWING_CONFIG_UNAVAILABLE'] };
  }
  return { exchange: 'okx', status: 'COMPATIBLE', reasons: [] };
}
export function unknownCredential(exchange: Exchange): CredentialSafetyAssessment {
  return { exchange, status: 'UNKNOWN', reasons: ['PERMISSION_UNAVAILABLE'], checkedAt: null };
}
export interface ObservedFeeConfig {
  readonly mode: 'diagnostic'; readonly bybitTakerRate: number | null; readonly okxTakerRate: number | null;
}
export function observedFeeConfig(bybit: AccountFeeSnapshot | null, okx: AccountFeeSnapshot | null): ObservedFeeConfig {
  return Object.freeze({ mode: 'diagnostic', bybitTakerRate: bybit?.takerFeeRate.normalizedCostRate ?? null,
    okxTakerRate: okx?.takerFeeRate.normalizedCostRate ?? null });
}
export function feeDiagnostic(bybit: AccountFeeSnapshot | null, okx: AccountFeeSnapshot | null, configured: FeeConfig = FEES) {
  const candidate = observedFeeConfig(bybit, okx);
  const b = candidate.bybitTakerRate === null ? null : candidate.bybitTakerRate - configured.bybit.takerRate;
  const o = candidate.okxTakerRate === null ? null : candidate.okxTakerRate - configured.okx.takerRate;
  // Tiny floating-point error at exactly 2 bps is not a mismatch.
  const mismatch = (delta: number | null) => delta !== null && Math.abs(delta) > MAX_FEE_DELTA + 1e-12;
  return { mode: 'diagnostic' as const, bybitConfiguredFee: configured.bybit.takerRate,
    bybitObservedAccountFee: candidate.bybitTakerRate, bybitFeeDelta: b,
    okxConfiguredFee: configured.okx.takerRate, okxObservedAccountFee: candidate.okxTakerRate, okxFeeDelta: o,
    bybitWarning: mismatch(b) ? 'FEE_MODEL_MISMATCH' : null, okxWarning: mismatch(o) ? 'FEE_MODEL_MISMATCH' : null };
}
