export type Exchange = 'bybit' | 'okx';
export interface DecimalRule { raw: string; scale: number; units: bigint }
export type Constraint = 'minQuantity' | 'maxQuantity' | 'minNotional' | 'maxNotional';
export interface InstrumentRules {
  exchange: Exchange; symbol: 'BTC/USDT';
  priceTick: DecimalRule; quantityStep: DecimalRule;
  minQuantity: number | null; maxQuantity: number | null;
  minNotional: number | null; maxNotional: number | null;
  exact: Record<Constraint, DecimalRule | null>;
  // USD is NOT USDT. Without a conversion source this extra cap is unknown.
  maxNotionalUsd: DecimalRule | null;
  instrumentStatus: 'TRADABLE' | 'NOT_TRADABLE' | 'UNKNOWN';
  receivedAt: number;
}
export type RuleSnapshots = Readonly<Record<Exchange, InstrumentRules | null>>;
export type RuleReason = 'UNKNOWN_RULES' | 'RULE_STALE' | 'RULE_FUTURE' | 'NOT_TRADABLE' |
  'BELOW_MIN_QUANTITY' | 'ABOVE_MAX_QUANTITY' | 'BELOW_MIN_NOTIONAL' | 'ABOVE_MAX_NOTIONAL' |
  'STEP_MISMATCH' | 'NOT_EXECUTABLE_RULES' | 'NOTIONAL_UNAVAILABLE' | 'USD_CONVERSION_UNAVAILABLE';
export interface OrderRuleAssessment {
  exchange: Exchange; valid: 'VALID' | 'INVALID' | 'UNKNOWN';
  normalizedQuantity: number | null; reasons: RuleReason[]; rulesReceivedAt: number | null;
}
export interface CrossVenueRuleAssessment {
  targetQuantity: number; commonQuantity: number | null;
  bybit: OrderRuleAssessment; okx: OrderRuleAssessment;
  status: 'EXECUTABLE' | 'NOT_EXECUTABLE' | 'UNKNOWN';
}
