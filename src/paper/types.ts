import type { PaperBalance, PaperBalances } from './balances.js';

export type PaperTradeState = 'PENDING' | 'FILLED' | 'REJECTED' | 'CLOSED';

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
