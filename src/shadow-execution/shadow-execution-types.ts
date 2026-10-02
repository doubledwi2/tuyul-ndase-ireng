import type { Exchange } from '../private-read/types.js';
import type { FeeSource, FundingStatus } from '../shadow/shadow-types.js';
import type { CrossVenueRuleAssessment } from '../instrument-rules/types.js';

export type ShadowExecutionState = 'WAITING_ARRIVAL' | 'FILLING' | 'PARTIALLY_FILLED' | 'UNHEDGED' | 'UNWINDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
export type ShadowExecutionOutcome = 'CLEAN_FILL' | 'PARTIAL_BOTH' | 'BUY_ONLY' | 'SELL_ONLY' | 'NO_FILL' | 'UNWOUND' | 'UNWIND_FAILED' | 'TIMED_OUT' | 'ABORTED_SHUTDOWN' | 'ABORTED_DETAIL_LIMIT';
export interface ShadowLeg {
  exchange: Exchange; side: 'BUY' | 'SELL'; requestedBtc: number; arrivalAt: number; deadlineAt: number;
  filledBtc: number; notional: number; fee: number; firstFillAt: number | null;
  firstEligibleBookDelayMs: number | null; done: boolean;
}
export interface ShadowExecutionFill {
  sequence: number; at: number; leg: 'buy' | 'sell' | 'unwind'; size: number; notional: number; fee: number;
}
export interface ShadowExecutionAttempt {
  configuredTargetBtc: number; ruleAdjustedTargetBtc: number;
  ruleFreshAtTrigger: boolean; ruleAssessment: CrossVenueRuleAssessment;
  id: string; opportunityEventId: string; triggeredAt: number; closedAt: number | null;
  buyExchange: Exchange; sellExchange: Exchange; targetBtcSize: number;
  buy: ShadowLeg; sell: ShadowLeg; unwind: ShadowLeg | null;
  state: ShadowExecutionState; outcome: ShadowExecutionOutcome | null;
  entryOutcome: 'BUY_ONLY' | 'SELL_ONLY' | 'PARTIAL_BOTH' | 'NO_FILL' | 'CLEAN_FILL' | null;
  residualBtc: number; unhedgedStartedAt: number | null; unhedgedDurationMs: number;
  feeSources: Readonly<Record<Exchange, FeeSource>>; feeRates: Readonly<Record<Exchange, number>>;
  fundingAssessment: { status: FundingStatus; reasons: FundingStatus[] };
  degraded: boolean; reasons: string[];
  triggerBuyPrice: number; triggerSellPrice: number; triggerShadowNetPnl: number;
  buyPriceDriftBps: number | null; sellPriceDriftBps: number | null;
  grossPnl: number | null; buyFee: number; sellFee: number; unwindFee: number;
  unwindNotional: number; unwindRealizedPnl: number; netPnlAfterFees: number | null;
  // Net realized result only: unclosed residual is never marked to a made-up exit.
  unallocatedEntryFees: number;
  feasibility: 'FEASIBLE_CLEAN' | 'FEASIBLE_WITH_PARTIAL_OR_UNWIND' | 'NOT_FEASIBLE' | 'UNCERTAIN';
  fills: ShadowExecutionFill[]; fillCount: number;
  transitions: { at: number; state: ShadowExecutionState }[];
}
