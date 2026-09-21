import {
  PAPER_RISK_CONFIG,
  validatePaperRiskConfig,
  type PaperRiskConfig,
} from '../config/risk.js';
import { PAPER_BALANCE_EPSILON } from '../config/paper.js';
import type { PaperBalance, PaperBalances } from '../paper/balances.js';

export type RiskReason =
  | 'MAX_TOTAL_BTC_EXPOSURE'
  | 'VENUE_BTC_IMBALANCE'
  | 'LOW_BTC_RESERVE'
  | 'LOW_USDT_RESERVE'
  | 'MAX_OPEN_TRADES'
  | 'MAX_UNHEDGED_EXPOSURE'
  | 'SESSION_LOSS_LIMIT'
  | 'CONSECUTIVE_FAILURE_LIMIT';

export interface RiskDecision {
  allowed: boolean;
  reasons: RiskReason[];
}

export type SessionRiskState = 'RUNNING' | 'RISK_HALTED';
export type RebalanceAsset = 'BTC' | 'USDT';

export interface RebalanceSuggestion {
  fromExchange: PaperBalance['exchange'];
  toExchange: PaperBalance['exchange'];
  asset: RebalanceAsset;
  amount: number;
  reason: string;
}

export interface PaperRiskTradeSnapshot {
  id: string;
  buyExchange: PaperBalance['exchange'];
  sellExchange: PaperBalance['exchange'];
  state: string;
  outcome?: string | null;
  closedAt: number | null;
  residualBaseExposure: number;
  realizedPaperPnl: number;
  requestedBaseSize?: number;
  buyFilledSize?: number;
}

export interface PaperRiskAssessmentInput {
  balances: Readonly<PaperBalances>;
  trades: readonly PaperRiskTradeSnapshot[];
  buyExchange: PaperBalance['exchange'];
  sellExchange: PaperBalance['exchange'];
  requestedBaseSize: number;
  projectedBuyUsdtCost: number;
}

export interface VenueInventoryRisk {
  btcAvailable: number;
  btcReserved: number;
  usdtAvailable: number;
  usdtReserved: number;
  btcPercentage: number;
  usdtPercentage: number;
}

export interface PaperRiskMetrics {
  riskChecks: number;
  riskAllowed: number;
  riskRejected: number;
  rejectedMaxTotalBtcExposure: number;
  rejectedLowBtcReserve: number;
  rejectedLowUsdtReserve: number;
  rejectedVenueImbalance: number;
  rejectedOpenTradeLimit: number;
  rejectedExposureLimit: number;
  rejectedSessionLoss: number;
  rejectedFailureCircuitBreaker: number;
  sessionRiskState: SessionRiskState;
  currentGlobalUnhedgedBtc: number;
  maxObservedGlobalUnhedgedBtc: number;
  currentConsecutiveFailures: number;
  maxConsecutiveFailures: number;
  sessionRealizedPnlUsdt: number;
  bybitBtcPercentage: number;
  okxBtcPercentage: number;
  bybitUsdtPercentage: number;
  okxUsdtPercentage: number;
}

export interface PaperRiskSummary {
  state: SessionRiskState;
  haltReasons: RiskReason[];
  openTrades: number;
  globalResidualBtc: number;
  consecutiveFailures: number;
  sessionRealizedPnlUsdt: number;
  venues: Record<PaperBalance['exchange'], VenueInventoryRisk>;
  rebalanceSuggestions: RebalanceSuggestion[];
  metrics: PaperRiskMetrics;
}

function totalBtc(balance: Readonly<PaperBalance>): number {
  return balance.btcAvailable + balance.btcReserved;
}

function totalUsdt(balance: Readonly<PaperBalance>): number {
  return balance.usdtAvailable + balance.usdtReserved;
}

function percentage(value: number, total: number): number {
  return total <= PAPER_BALANCE_EPSILON ? 50 : (value / total) * 100;
}

function addReason(reasons: RiskReason[], reason: RiskReason): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function isExecutionFailure(trade: PaperRiskTradeSnapshot): boolean {
  return (
    trade.state === 'FAILED' ||
    trade.outcome === 'BUY_ONLY' ||
    trade.outcome === 'SELL_ONLY' ||
    trade.outcome === 'UNWIND_FAILED'
  );
}

function isExecutionSuccess(trade: PaperRiskTradeSnapshot): boolean {
  return trade.outcome === 'CLEAN_FILL' || trade.outcome === 'UNWOUND';
}

export class PaperRiskManager {
  private readonly config: PaperRiskConfig;
  private state: SessionRiskState = 'RUNNING';
  private readonly haltReasons: RiskReason[] = [];
  private readonly observedTerminalTradeIds = new Set<string>();
  private riskChecks = 0;
  private riskAllowed = 0;
  private riskRejected = 0;
  private rejectedMaxTotalBtcExposure = 0;
  private rejectedLowBtcReserve = 0;
  private rejectedLowUsdtReserve = 0;
  private rejectedVenueImbalance = 0;
  private rejectedOpenTradeLimit = 0;
  private rejectedExposureLimit = 0;
  private rejectedSessionLoss = 0;
  private rejectedFailureCircuitBreaker = 0;
  private consecutiveFailures = 0;
  private maxConsecutiveFailures = 0;
  private sessionRealizedPnlUsdt = 0;
  private maxObservedGlobalUnhedgedBtc = 0;

  constructor(config: PaperRiskConfig = PAPER_RISK_CONFIG) {
    validatePaperRiskConfig(config);
    this.config = { ...config };
  }

  assess(input: PaperRiskAssessmentInput): RiskDecision {
    this.observeExposure(input.trades);
    this.riskChecks += 1;
    const reasons: RiskReason[] = [];

    for (const reason of this.haltReasons) {
      addReason(reasons, reason);
    }

    const bybitBtc = totalBtc(input.balances.bybit);
    const okxBtc = totalBtc(input.balances.okx);
    const totalPortfolioBtc = bybitBtc + okxBtc;
    const pendingBuyExposure = input.trades
      .filter((trade) => trade.closedAt === null)
      .reduce(
        (sum, trade) =>
          sum +
          Math.max(
            0,
            (trade.requestedBaseSize ?? 0) - (trade.buyFilledSize ?? 0),
          ),
        0,
      );
    if (
      totalPortfolioBtc + pendingBuyExposure + input.requestedBaseSize >
      this.config.maxTotalBtcExposure + PAPER_BALANCE_EPSILON
    ) {
      addReason(reasons, 'MAX_TOTAL_BTC_EXPOSURE');
    }

    const projectedSellBtc =
      input.balances[input.sellExchange].btcAvailable -
      input.requestedBaseSize;
    if (
      projectedSellBtc + PAPER_BALANCE_EPSILON <
      this.config.minVenueBtcReserve
    ) {
      addReason(reasons, 'LOW_BTC_RESERVE');
    }

    const projectedBuyUsdt =
      input.balances[input.buyExchange].usdtAvailable -
      input.projectedBuyUsdtCost;
    if (
      projectedBuyUsdt + PAPER_BALANCE_EPSILON <
      this.config.minVenueUsdtReserve
    ) {
      addReason(reasons, 'LOW_USDT_RESERVE');
    }

    const currentImbalance = Math.abs(bybitBtc - okxBtc);
    const projectedBybitBtc =
      bybitBtc +
      (input.buyExchange === 'bybit' ? input.requestedBaseSize : 0) -
      (input.sellExchange === 'bybit' ? input.requestedBaseSize : 0);
    const projectedOkxBtc =
      okxBtc +
      (input.buyExchange === 'okx' ? input.requestedBaseSize : 0) -
      (input.sellExchange === 'okx' ? input.requestedBaseSize : 0);
    const projectedImbalance = Math.abs(projectedBybitBtc - projectedOkxBtc);
    if (
      projectedImbalance >
        this.config.maxVenueBtcImbalance + PAPER_BALANCE_EPSILON &&
      projectedImbalance > currentImbalance + PAPER_BALANCE_EPSILON
    ) {
      addReason(reasons, 'VENUE_BTC_IMBALANCE');
    }

    const openTrades = input.trades.filter(
      (trade) => trade.closedAt === null,
    ).length;
    if (openTrades >= this.config.maxOpenPaperTrades) {
      addReason(reasons, 'MAX_OPEN_TRADES');
    }

    const currentGlobalUnhedged = this.globalUnhedgedBtc(input.trades);
    const reducesExposure = this.directionReducesExposure(input);
    if (
      (currentGlobalUnhedged >
        this.config.maxUnhedgedBtc + PAPER_BALANCE_EPSILON ||
        currentGlobalUnhedged + input.requestedBaseSize >
          this.config.maxUnhedgedBtc + PAPER_BALANCE_EPSILON) &&
      !reducesExposure
    ) {
      addReason(reasons, 'MAX_UNHEDGED_EXPOSURE');
    }

    if (reasons.length === 0) {
      this.riskAllowed += 1;
      return { allowed: true, reasons: [] };
    }

    this.riskRejected += 1;
    this.countRejectionReasons(reasons);
    return { allowed: false, reasons };
  }

  observeTerminalTrade(trade: PaperRiskTradeSnapshot): void {
    if (
      trade.closedAt === null ||
      trade.state === 'REJECTED' ||
      this.observedTerminalTradeIds.has(trade.id)
    ) {
      return;
    }
    this.observedTerminalTradeIds.add(trade.id);
    this.sessionRealizedPnlUsdt += trade.realizedPaperPnl;

    if (isExecutionFailure(trade)) {
      this.consecutiveFailures += 1;
      this.maxConsecutiveFailures = Math.max(
        this.maxConsecutiveFailures,
        this.consecutiveFailures,
      );
    } else if (isExecutionSuccess(trade) && this.state === 'RUNNING') {
      this.consecutiveFailures = 0;
    }

    if (
      this.sessionRealizedPnlUsdt <=
      -this.config.maxSessionPaperLossUsdt
    ) {
      this.activateHalt('SESSION_LOSS_LIMIT');
    }
    if (
      this.consecutiveFailures >=
      this.config.maxConsecutiveExecutionFailures
    ) {
      this.activateHalt('CONSECUTIVE_FAILURE_LIMIT');
    }
  }

  observeExposure(trades: readonly PaperRiskTradeSnapshot[]): void {
    this.maxObservedGlobalUnhedgedBtc = Math.max(
      this.maxObservedGlobalUnhedgedBtc,
      this.globalUnhedgedBtc(trades),
    );
  }

  getSummary(
    balances: Readonly<PaperBalances>,
    trades: readonly PaperRiskTradeSnapshot[],
  ): PaperRiskSummary {
    this.observeExposure(trades);
    const bybitBtc = totalBtc(balances.bybit);
    const okxBtc = totalBtc(balances.okx);
    const bybitUsdt = totalUsdt(balances.bybit);
    const okxUsdt = totalUsdt(balances.okx);
    const totalPortfolioBtc = bybitBtc + okxBtc;
    const totalPortfolioUsdt = bybitUsdt + okxUsdt;
    const globalResidualBtc = this.globalUnhedgedBtc(trades);
    const venue = (
      exchange: PaperBalance['exchange'],
    ): VenueInventoryRisk => ({
      btcAvailable: balances[exchange].btcAvailable,
      btcReserved: balances[exchange].btcReserved,
      usdtAvailable: balances[exchange].usdtAvailable,
      usdtReserved: balances[exchange].usdtReserved,
      btcPercentage: percentage(totalBtc(balances[exchange]), totalPortfolioBtc),
      usdtPercentage: percentage(
        totalUsdt(balances[exchange]),
        totalPortfolioUsdt,
      ),
    });
    const metrics: PaperRiskMetrics = {
      riskChecks: this.riskChecks,
      riskAllowed: this.riskAllowed,
      riskRejected: this.riskRejected,
      rejectedMaxTotalBtcExposure: this.rejectedMaxTotalBtcExposure,
      rejectedLowBtcReserve: this.rejectedLowBtcReserve,
      rejectedLowUsdtReserve: this.rejectedLowUsdtReserve,
      rejectedVenueImbalance: this.rejectedVenueImbalance,
      rejectedOpenTradeLimit: this.rejectedOpenTradeLimit,
      rejectedExposureLimit: this.rejectedExposureLimit,
      rejectedSessionLoss: this.rejectedSessionLoss,
      rejectedFailureCircuitBreaker: this.rejectedFailureCircuitBreaker,
      sessionRiskState: this.state,
      currentGlobalUnhedgedBtc: globalResidualBtc,
      maxObservedGlobalUnhedgedBtc: this.maxObservedGlobalUnhedgedBtc,
      currentConsecutiveFailures: this.consecutiveFailures,
      maxConsecutiveFailures: this.maxConsecutiveFailures,
      sessionRealizedPnlUsdt: this.sessionRealizedPnlUsdt,
      bybitBtcPercentage: percentage(bybitBtc, totalPortfolioBtc),
      okxBtcPercentage: percentage(okxBtc, totalPortfolioBtc),
      bybitUsdtPercentage: percentage(bybitUsdt, totalPortfolioUsdt),
      okxUsdtPercentage: percentage(okxUsdt, totalPortfolioUsdt),
    };
    return {
      state: this.state,
      haltReasons: [...this.haltReasons],
      openTrades: trades.filter((trade) => trade.closedAt === null).length,
      globalResidualBtc,
      consecutiveFailures: this.consecutiveFailures,
      sessionRealizedPnlUsdt: this.sessionRealizedPnlUsdt,
      venues: { bybit: venue('bybit'), okx: venue('okx') },
      rebalanceSuggestions: this.getRebalanceSuggestions(balances),
      metrics,
    };
  }

  getRebalanceSuggestions(
    balances: Readonly<PaperBalances>,
  ): RebalanceSuggestion[] {
    const suggestions: RebalanceSuggestion[] = [];
    this.addRebalanceSuggestion(
      suggestions,
      'BTC',
      totalBtc(balances.bybit),
      totalBtc(balances.okx),
    );
    this.addRebalanceSuggestion(
      suggestions,
      'USDT',
      totalUsdt(balances.bybit),
      totalUsdt(balances.okx),
    );
    return suggestions;
  }

  private globalUnhedgedBtc(
    trades: readonly PaperRiskTradeSnapshot[],
  ): number {
    return trades
      .filter(
        (trade) =>
          trade.closedAt === null ||
          (trade.state === 'FAILED' &&
            Math.abs(trade.residualBaseExposure) > PAPER_BALANCE_EPSILON),
      )
      .reduce(
        (sum, trade) => sum + Math.abs(trade.residualBaseExposure),
        0,
      );
  }

  private directionReducesExposure(input: PaperRiskAssessmentInput): boolean {
    const venueResidual = { bybit: 0, okx: 0 };
    for (const trade of input.trades) {
      if (
        trade.closedAt !== null &&
        trade.state !== 'FAILED'
      ) {
        continue;
      }
      if (trade.residualBaseExposure > PAPER_BALANCE_EPSILON) {
        venueResidual[trade.buyExchange] += trade.residualBaseExposure;
      } else if (trade.residualBaseExposure < -PAPER_BALANCE_EPSILON) {
        venueResidual[trade.sellExchange] += trade.residualBaseExposure;
      }
    }
    const offsettableExposure =
      Math.max(0, venueResidual[input.sellExchange]) +
      Math.max(0, -venueResidual[input.buyExchange]);
    if (offsettableExposure <= PAPER_BALANCE_EPSILON) {
      return false;
    }
    const currentExposure = this.globalUnhedgedBtc(input.trades);
    const offsetSize = Math.min(input.requestedBaseSize, offsettableExposure);
    const overshootSize = Math.max(
      0,
      input.requestedBaseSize - offsettableExposure,
    );
    const projectedDirectionalExposure =
      currentExposure - offsetSize + overshootSize;
    return (
      projectedDirectionalExposure + PAPER_BALANCE_EPSILON < currentExposure
    );
  }

  private activateHalt(reason: RiskReason): void {
    this.state = 'RISK_HALTED';
    addReason(this.haltReasons, reason);
  }

  private countRejectionReasons(reasons: readonly RiskReason[]): void {
    for (const reason of reasons) {
      switch (reason) {
        case 'MAX_TOTAL_BTC_EXPOSURE':
          this.rejectedMaxTotalBtcExposure += 1;
          break;
        case 'LOW_BTC_RESERVE':
          this.rejectedLowBtcReserve += 1;
          break;
        case 'LOW_USDT_RESERVE':
          this.rejectedLowUsdtReserve += 1;
          break;
        case 'VENUE_BTC_IMBALANCE':
          this.rejectedVenueImbalance += 1;
          break;
        case 'MAX_OPEN_TRADES':
          this.rejectedOpenTradeLimit += 1;
          break;
        case 'MAX_UNHEDGED_EXPOSURE':
          this.rejectedExposureLimit += 1;
          break;
        case 'SESSION_LOSS_LIMIT':
          this.rejectedSessionLoss += 1;
          break;
        case 'CONSECUTIVE_FAILURE_LIMIT':
          this.rejectedFailureCircuitBreaker += 1;
          break;
      }
    }
  }

  private addRebalanceSuggestion(
    suggestions: RebalanceSuggestion[],
    asset: RebalanceAsset,
    bybitAmount: number,
    okxAmount: number,
  ): void {
    const total = bybitAmount + okxAmount;
    if (total <= PAPER_BALANCE_EPSILON) {
      return;
    }
    const bybitPercentage = percentage(bybitAmount, total);
    const deviation = Math.abs(bybitPercentage - 50);
    if (
      deviation <=
      this.config.rebalanceAllocationTolerancePercent + PAPER_BALANCE_EPSILON
    ) {
      return;
    }
    const bybitIsHigh = bybitAmount > okxAmount;
    suggestions.push({
      fromExchange: bybitIsHigh ? 'bybit' : 'okx',
      toExchange: bybitIsHigh ? 'okx' : 'bybit',
      asset,
      amount: Math.abs(bybitAmount - okxAmount) / 2,
      reason: `${asset} allocation ${bybitPercentage.toFixed(2)}% Bybit / ${(100 - bybitPercentage).toFixed(2)}% OKX exceeds the 50/50 tolerance band`,
    });
  }
}
