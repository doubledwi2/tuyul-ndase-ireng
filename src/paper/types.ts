import type { PaperBalance, PaperBalances } from './balances.js';

export type PaperTradeState =
  | 'PENDING'
  | 'SUBMITTING'
  | 'PARTIALLY_FILLED'
  | 'ONE_LEG_FILLED'
  | 'FILLED'
  | 'UNHEDGED'
  | 'UNWINDING'
  | 'CLOSED'
  | 'REJECTED'
  | 'FAILED';

export type PaperOrderSide = 'BUY' | 'SELL';

export type PaperOrderState =
  | 'PENDING'
  | 'SUBMITTED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'TIMED_OUT'
  | 'CANCELLED';

export type PaperTradeOutcome =
  | 'CLEAN_FILL'
  | 'PARTIAL_BOTH'
  | 'BUY_ONLY'
  | 'SELL_ONLY'
  | 'UNWOUND'
  | 'UNWIND_FAILED'
  | 'TIMEOUT_NO_FILL'
  | 'REJECTED_PRETRADE';

export type PaperTradeRejectionReason =
  | 'NOT_QUALIFIED'
  | 'SYNC_UNHEALTHY'
  | 'INSUFFICIENT_DEPTH'
  | 'INSUFFICIENT_BUY_USDT'
  | 'INSUFFICIENT_SELL_BTC'
  | 'NET_NOT_POSITIVE'
  | 'STALE_OPPORTUNITY'
  | 'DUPLICATE_EVENT';

export interface PaperTrade {
  id: string;
  opportunityEventId: string;
  symbol: 'BTC/USDT';
  buyExchange: PaperBalance['exchange'];
  sellExchange: PaperBalance['exchange'];
  requestedBaseSize: number;
  state: PaperTradeState;
  createdAt: number;
  filledAt: number | null;
  buyAveragePrice: number | null;
  sellAveragePrice: number | null;
  buyNotional: number | null;
  sellNotional: number | null;
  buyFee: number | null;
  sellFee: number | null;
  totalFee: number | null;
  grossPnl: number | null;
  netPnl: number | null;
  buyFilledSize: number;
  sellFilledSize: number;
  rejectionReason: PaperTradeRejectionReason | null;
  outcome?: PaperTradeOutcome | null;
}

export interface PaperOrder {
  id: string;
  tradeId: string;
  exchange: PaperBalance['exchange'];
  side: PaperOrderSide;
  requestedSize: number;
  filledSize: number;
  remainingSize: number;
  state: PaperOrderState;
  submittedAt: number;
  arrivalAt: number;
  firstFillAt: number | null;
  completedAt: number | null;
  averageFillPrice: number | null;
  notional: number;
  fee: number;
  isUnwind: boolean;
}

export interface PaperFill {
  id: string;
  orderId: string;
  tradeId: string;
  exchange: PaperBalance['exchange'];
  side: PaperOrderSide;
  timestamp: number;
  size: number;
  averagePrice: number;
  notional: number;
  fee: number;
  isUnwind: boolean;
}

export interface LatencyPaperTrade extends PaperTrade {
  qualifiedAt: number;
  decisionAt: number;
  buySubmittedAt: number;
  sellSubmittedAt: number;
  buyArrivalAt: number;
  sellArrivalAt: number;
  buyCompletedAt: number | null;
  sellCompletedAt: number | null;
  closedAt: number | null;
  buyLatencyMs: number | null;
  sellLatencyMs: number | null;
  unhedgedSince: number | null;
  unhedgedDurationMs: number;
  residualBaseExposure: number;
  entryGrossPnl: number;
  entryFees: number;
  unwindCashFlow: number;
  unwindFees: number;
  realizedPaperPnl: number;
  buyOrderId: string;
  sellOrderId: string;
  unwindOrderId: string | null;
  outcome: PaperTradeOutcome | null;
}

export type PaperExecutionEvent =
  | { type: 'TRADE'; recordedAt: number; trade: LatencyPaperTrade }
  | { type: 'ORDER'; recordedAt: number; order: PaperOrder }
  | { type: 'FILL'; recordedAt: number; fill: PaperFill };

export interface PaperExecutionMetrics {
  tradesTriggered: number;
  pretradeRejections: number;
  executionFailures: number;
  cleanFills: number;
  partialTrades: number;
  buyOnlyCount: number;
  sellOnlyCount: number;
  unhedgedTrades: number;
  unwindAttempts: number;
  unwindSuccess: number;
  unwindFailures: number;
  timeouts: number;
  averageBuyFillLatencyMs: number | null;
  p50BuyFillLatencyMs: number | null;
  p95BuyFillLatencyMs: number | null;
  p99BuyFillLatencyMs: number | null;
  averageSellFillLatencyMs: number | null;
  p50SellFillLatencyMs: number | null;
  p95SellFillLatencyMs: number | null;
  p99SellFillLatencyMs: number | null;
  averageUnwindFillLatencyMs: number | null;
  p50UnwindFillLatencyMs: number | null;
  p95UnwindFillLatencyMs: number | null;
  p99UnwindFillLatencyMs: number | null;
  averageUnhedgedDurationMs: number | null;
  p50UnhedgedDurationMs: number | null;
  p95UnhedgedDurationMs: number | null;
  p99UnhedgedDurationMs: number | null;
  averageAbsoluteResidualBtc: number | null;
  maxAbsoluteResidualBtc: number | null;
  paperEntryPnl: number;
  paperUnwindCost: number;
  paperFinalTradePnl: number;
}

export interface PaperSessionSummary {
  tradesAttempted: number;
  tradesFilled: number;
  tradesRejected: number;
  grossPaperPnl: number;
  feesPaid: number;
  netTradePnl: number;
  referenceBtcPrice: number | null;
  initialPortfolioValueUsdt: number | null;
  currentPortfolioValueUsdt: number | null;
  paperPortfolioPnlUsdt: number | null;
  totalBTC: number;
  totalUSDT: number;
  balances: PaperBalances;
}
