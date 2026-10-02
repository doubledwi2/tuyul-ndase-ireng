import type { AccountCompatibilityAssessment, AccountFeeSnapshot, CredentialSafetyAssessment } from '../private-read/account-types.js';
import type { Exchange, PrivateAccountSnapshot } from '../private-read/types.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import type { SyncAssessment } from '../timing/sync-model.js';
import type { RuleSnapshots, CrossVenueRuleAssessment } from '../instrument-rules/types.js';

export type FundingStatus = 'FUNDED' | 'INSUFFICIENT_FUNDS' | 'UNKNOWN_AVAILABLE_BALANCE' |
  'STALE_BALANCE' | 'ACCOUNT_INCOMPATIBLE' | 'ACCOUNT_COMPATIBILITY_UNKNOWN';
export type FeeSource = 'ACCOUNT_OBSERVED' | 'SIMULATION_FALLBACK';
export type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export interface DiagnosticSnapshot<T> { readonly value: Immutable<T>; readonly receivedAt: number; readonly healthy: boolean }
export interface ShadowVenueInput {
  readonly balance: Immutable<PrivateAccountSnapshot> | null;
  readonly balanceHealthy: boolean;
  readonly fee: Immutable<AccountFeeSnapshot> | null;
  readonly feeHealthy: boolean;
  readonly compatibility: DiagnosticSnapshot<AccountCompatibilityAssessment> | null;
  readonly permission: DiagnosticSnapshot<CredentialSafetyAssessment> | null;
}
export type ShadowAccountState = Readonly<Record<Exchange, ShadowVenueInput>>;
export interface ShadowInput {
  readonly instrumentRules?: RuleSnapshots;
  readonly evaluatedAt: number;
  readonly books: Readonly<Record<Exchange, NormalizedOrderBook>>;
  readonly sync: SyncAssessment;
  readonly accounts: ShadowAccountState;
}
export interface ShadowFreshness { balance: boolean; fee: boolean; config: boolean; permission: boolean }
export interface ShadowDirection {
  ruleAssessment: CrossVenueRuleAssessment;
  ruleCalibratedNetPnl: number | null;
  ruleCalibratedBuyNotional: number | null;
  ruleCalibratedSellNotional: number | null;
  buyExchange: Exchange; sellExchange: Exchange;
  economicsStatus: 'SHADOW_POSITIVE' | 'SHADOW_ZERO_OR_NEGATIVE' | 'SHADOW_UNCERTAIN';
  fundingStatus: FundingStatus;
  fundingReasons: FundingStatus[];
  baselineNetPnl: number | null; shadowNetPnl: number | null;
  baselineNetSpread: number | null; shadowNetSpread: number | null;
  feeImpactUsdt: number | null;
}
// Deliberately excludes account snapshots, identifiers and raw diagnostic payloads.
export interface ShadowAssessment {
  evaluatedAt: number;
  directions: [ShadowDirection, ShadowDirection];
  feeSourceByExchange: Record<Exchange, FeeSource>;
  freshness: Record<Exchange, ShadowFreshness>;
  degraded: boolean;
  reasons: string[];
}
