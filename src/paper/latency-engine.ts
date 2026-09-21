import { randomUUID } from 'node:crypto';

import { FEES, type FeeConfig } from '../config/fees.js';
import type { PaperRiskConfig } from '../config/risk.js';
import {
  INITIAL_PAPER_BALANCES,
  MAX_PAPER_TRIGGER_AGE_MS,
  PAPER_BALANCE_EPSILON,
  PAPER_EXECUTION_CONFIG,
  validatePaperExecutionConfig,
  type PaperExecutionConfig,
} from '../config/paper.js';
import type { OpportunityEvent } from '../scanner/opportunity.js';
import type { OpportunityQualification } from '../scanner/opportunity-filter.js';
import { simulateExecution } from '../scanner/execution-simulator.js';
import type { SyncAssessment } from '../timing/sync-model.js';
import {
  PaperRiskManager,
  type PaperRiskSummary,
} from '../risk/paper-risk-manager.js';
import {
  isValidNormalizedOrderBook,
  type NormalizedOrderBook,
} from '../types/orderbook.js';
import {
  clonePaperBalances,
  consumeReservedPaperBuy,
  consumeReservedPaperSell,
  createPaperBalances,
  releasePaperBtc,
  releasePaperUsdt,
  reservePaperBtc,
  reservePaperUsdt,
  type PaperBalances,
} from './balances.js';
import {
  calculatePaperInventory,
  calculateReferenceBtcPrice,
  valuePaperPortfolio,
} from './portfolio.js';
import type {
  LatencyPaperTrade,
  PaperExecutionEvent,
  PaperExecutionMetrics,
  PaperFill,
  PaperOrder,
  PaperOrderSide,
  PaperSessionSummary,
  PaperTradeOutcome,
  PaperTradeRejectionReason,
} from './types.js';

export interface LatencyPaperExecutionInput {
  event: OpportunityEvent;
  bybitBook: NormalizedOrderBook;
  okxBook: NormalizedOrderBook;
  syncAssessment: SyncAssessment;
  timestamp: number;
  latestQualification?: OpportunityQualification;
}

export interface LatencyPaperTradingEngineOptions {
  initialBalances?: Readonly<PaperBalances>;
  fees?: FeeConfig;
  executionConfig?: PaperExecutionConfig;
  maxTriggerAgeMs?: number;
  idGenerator?: () => string;
  onExecutionEvent?: (event: PaperExecutionEvent) => void;
  riskConfig?: PaperRiskConfig;
  riskManager?: PaperRiskManager;
}

interface InternalOrder extends PaperOrder {
  deadlineAt: number;
  reservedQuoteRemaining: number;
  reservedBaseRemaining: number;
}

interface CachedBook {
  book: NormalizedOrderBook;
  logicalTimestamp: number;
}

interface FillResult {
  size: number;
  notional: number;
  averagePrice: number;
}

const TERMINAL_ORDER_STATES = new Set<PaperOrder['state']>([
  'FILLED',
  'TIMED_OUT',
  'CANCELLED',
]);

function initialBalancesFromConfig(): PaperBalances {
  return {
    bybit: { ...INITIAL_PAPER_BALANCES.bybit },
    okx: { ...INITIAL_PAPER_BALANCES.okx },
  };
}

function cloneTrade(trade: LatencyPaperTrade): LatencyPaperTrade {
  return {
    ...trade,
    riskReasons: [...(trade.riskReasons ?? [])],
  };
}

function cloneOrder(order: InternalOrder): PaperOrder {
  const {
    deadlineAt: _deadlineAt,
    reservedQuoteRemaining: _reservedQuoteRemaining,
    reservedBaseRemaining: _reservedBaseRemaining,
    ...snapshot
  } = order;
  return { ...snapshot };
}

function average(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], requested: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((requested / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

function terminal(order: InternalOrder): boolean {
  return TERMINAL_ORDER_STATES.has(order.state);
}

function fillWithinBudget(
  book: NormalizedOrderBook,
  requestedSize: number,
  budget: number,
  feeRate: number,
): FillResult | null {
  let remaining = requestedSize;
  let remainingBudget = budget;
  let size = 0;
  let notional = 0;
  for (const level of book.asks) {
    const costPerBtc = level.price * (1 + feeRate);
    const affordable = remainingBudget / costPerBtc;
    const fillSize = Math.min(level.size, remaining, affordable);
    if (fillSize <= PAPER_BALANCE_EPSILON) {
      break;
    }
    const fillNotional = fillSize * level.price;
    size += fillSize;
    notional += fillNotional;
    remaining -= fillSize;
    remainingBudget -= fillNotional * (1 + feeRate);
    if (remaining <= PAPER_BALANCE_EPSILON) {
      break;
    }
  }
  return size <= PAPER_BALANCE_EPSILON
    ? null
    : { size, notional, averagePrice: notional / size };
}

export class LatencyPaperTradingEngine {
  private balances: PaperBalances;
  private readonly initialBalances: PaperBalances;
  private readonly fees: FeeConfig;
  private readonly config: PaperExecutionConfig;
  private readonly maxTriggerAgeMs: number;
  private readonly idGenerator: () => string;
  private readonly onExecutionEvent:
    | ((event: PaperExecutionEvent) => void)
    | undefined;
  private readonly riskManager: PaperRiskManager;
  private readonly seenEventIds = new Set<string>();
  private readonly trades: LatencyPaperTrade[] = [];
  private readonly orders = new Map<string, InternalOrder>();
  private readonly fills: PaperFill[] = [];
  private readonly processedBookUpdates = new WeakSet<NormalizedOrderBook>();
  private readonly latestBooks = new Map<NormalizedOrderBook['exchange'], CachedBook>();
  private readonly everUnhedged = new Set<string>();
  private readonly everBuyOnly = new Set<string>();
  private readonly everSellOnly = new Set<string>();
  private readonly unhedgedAccumulatedMs = new Map<string, number>();
  private referenceBtcPrice: number | null = null;
  private initialPortfolioValueUsdt: number | null = null;
  private lastLogicalTimestamp = 0;

  constructor(options: LatencyPaperTradingEngineOptions = {}) {
    this.balances = createPaperBalances(
      options.initialBalances ?? initialBalancesFromConfig(),
    );
    this.initialBalances = clonePaperBalances(this.balances);
    this.fees = options.fees ?? FEES;
    for (const [exchange, fee] of Object.entries(this.fees)) {
      if (!Number.isFinite(fee.takerRate) || fee.takerRate < 0) {
        throw new RangeError(`Invalid paper taker fee for ${exchange}.`);
      }
    }
    this.config = options.executionConfig ?? PAPER_EXECUTION_CONFIG;
    validatePaperExecutionConfig(this.config);
    this.maxTriggerAgeMs = options.maxTriggerAgeMs ?? MAX_PAPER_TRIGGER_AGE_MS;
    if (!Number.isFinite(this.maxTriggerAgeMs) || this.maxTriggerAgeMs < 0) {
      throw new RangeError('Paper trigger age must be finite and non-negative.');
    }
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.onExecutionEvent = options.onExecutionEvent;
    this.riskManager =
      options.riskManager ?? new PaperRiskManager(options.riskConfig);
  }

  triggerOpportunity(input: LatencyPaperExecutionInput): LatencyPaperTrade {
    const trade = this.createTrade(input.event, input.timestamp);
    if (this.seenEventIds.has(input.event.id)) {
      return this.reject(trade, 'DUPLICATE_EVENT', input.timestamp);
    }
    this.seenEventIds.add(input.event.id);
    if (input.event.state !== 'QUALIFIED') {
      return this.reject(trade, 'NOT_QUALIFIED', input.timestamp);
    }
    const age = input.timestamp - input.event.updatedAt;
    if (age < 0 || age > this.maxTriggerAgeMs) {
      return this.reject(trade, 'STALE_OPPORTUNITY', input.timestamp);
    }
    if (input.syncAssessment.status !== 'SYNC_HEALTHY') {
      return this.reject(trade, 'SYNC_UNHEALTHY', input.timestamp);
    }
    if (
      !Number.isFinite(input.event.currentEstimatedNetPnlAbsolute) ||
      input.event.currentEstimatedNetPnlAbsolute <= 0
    ) {
      return this.reject(trade, 'NET_NOT_POSITIVE', input.timestamp);
    }
    if (
      input.latestQualification !== undefined &&
      !input.latestQualification.qualified
    ) {
      return this.reject(trade, 'NOT_QUALIFIED', input.timestamp);
    }
    if (
      !isValidNormalizedOrderBook(input.bybitBook) ||
      !isValidNormalizedOrderBook(input.okxBook)
    ) {
      return this.reject(trade, 'INSUFFICIENT_DEPTH', input.timestamp);
    }

    const buyBook =
      input.event.buyExchange === 'bybit' ? input.bybitBook : input.okxBook;
    const bestAsk = buyBook.asks[0]?.price;
    if (bestAsk === undefined) {
      return this.reject(trade, 'INSUFFICIENT_DEPTH', input.timestamp);
    }
    const buyReservation =
      input.event.targetBaseSize *
      bestAsk *
      (1 + this.fees[input.event.buyExchange].takerRate);
    const riskDecision = this.riskManager.assess({
      balances: this.balances,
      trades: this.trades,
      buyExchange: input.event.buyExchange,
      sellExchange: input.event.sellExchange,
      requestedBaseSize: input.event.targetBaseSize,
      projectedBuyUsdtCost: buyReservation,
    });
    if (!riskDecision.allowed) {
      trade.riskReasons = [...riskDecision.reasons];
      return this.reject(trade, 'RISK_REJECTED', input.timestamp);
    }
    if (
      this.balances[input.event.buyExchange].usdtAvailable +
        PAPER_BALANCE_EPSILON <
      buyReservation
    ) {
      return this.reject(trade, 'INSUFFICIENT_BUY_USDT', input.timestamp);
    }
    if (
      this.balances[input.event.sellExchange].btcAvailable +
        PAPER_BALANCE_EPSILON <
      input.event.targetBaseSize
    ) {
      return this.reject(trade, 'INSUFFICIENT_SELL_BTC', input.timestamp);
    }

    const nextBalances = clonePaperBalances(this.balances);
    nextBalances[input.event.buyExchange] = reservePaperUsdt(
      nextBalances[input.event.buyExchange],
      buyReservation,
    );
    nextBalances[input.event.sellExchange] = reservePaperBtc(
      nextBalances[input.event.sellExchange],
      input.event.targetBaseSize,
    );
    this.balances = nextBalances;

    const buyOrder = this.createOrder(
      trade,
      input.event.buyExchange,
      'BUY',
      input.event.targetBaseSize,
      input.timestamp,
      trade.buyArrivalAt,
      buyReservation,
      0,
      false,
    );
    const sellOrder = this.createOrder(
      trade,
      input.event.sellExchange,
      'SELL',
      input.event.targetBaseSize,
      input.timestamp,
      trade.sellArrivalAt,
      0,
      input.event.targetBaseSize,
      false,
    );
    trade.buyOrderId = buyOrder.id;
    trade.sellOrderId = sellOrder.id;
    trade.state = 'SUBMITTING';
    this.trades.push(trade);
    this.orders.set(buyOrder.id, buyOrder);
    this.orders.set(sellOrder.id, sellOrder);
    this.emitOrder(buyOrder, input.timestamp);
    this.emitOrder(sellOrder, input.timestamp);
    this.emitTrade(trade, input.timestamp);
    this.lastLogicalTimestamp = Math.max(
      this.lastLogicalTimestamp,
      input.timestamp,
    );
    return cloneTrade(trade);
  }

  processOrderBook(
    book: NormalizedOrderBook,
    logicalTimestamp: number,
  ): void {
    if (!isValidNormalizedOrderBook(book)) {
      return;
    }
    if (this.processedBookUpdates.has(book)) {
      return;
    }
    this.processedBookUpdates.add(book);
    if (!Number.isFinite(logicalTimestamp) || logicalTimestamp < 0) {
      throw new RangeError('Logical timestamp must be finite and non-negative.');
    }
    if (logicalTimestamp < this.lastLogicalTimestamp) {
      throw new RangeError('Paper execution time cannot move backwards.');
    }
    this.lastLogicalTimestamp = logicalTimestamp;
    this.latestBooks.set(book.exchange, { book, logicalTimestamp });
    this.observePortfolioBooks();

    for (const order of this.orders.values()) {
      if (
        terminal(order) ||
        order.exchange !== book.exchange ||
        logicalTimestamp < order.arrivalAt ||
        logicalTimestamp > order.deadlineAt
      ) {
        continue;
      }
      if (order.isUnwind) {
        this.attemptUnwindFill(order, book, logicalTimestamp);
      } else {
        this.attemptEntryFill(order, book, logicalTimestamp);
      }
    }
    this.expireOrders(logicalTimestamp);
    this.refreshAndMaybeUnwind(logicalTimestamp);
    this.riskManager.observeExposure(this.trades);
  }

  finish(): void {
    if (this.trades.every((trade) => trade.closedAt !== null)) {
      return;
    }
    const pendingEntryDeadlines = this.ordersArray()
      .filter((order) => !order.isUnwind && !terminal(order))
      .map((order) => order.deadlineAt);
    let finalTimestamp = Math.max(
      this.lastLogicalTimestamp,
      pendingEntryDeadlines.length === 0
        ? this.lastLogicalTimestamp
        : Math.max(...pendingEntryDeadlines),
    );
    this.lastLogicalTimestamp = finalTimestamp;
    this.expireOrders(finalTimestamp);
    this.refreshAndMaybeUnwind(finalTimestamp);

    const pendingUnwindDeadlines = this.ordersArray()
      .filter((order) => order.isUnwind && !terminal(order))
      .map((order) => order.deadlineAt);
    if (pendingUnwindDeadlines.length > 0) {
      finalTimestamp = Math.max(finalTimestamp, ...pendingUnwindDeadlines);
      this.lastLogicalTimestamp = finalTimestamp;
      this.expireOrders(finalTimestamp);
      this.refreshAndMaybeUnwind(finalTimestamp);
    }

    for (const trade of this.trades) {
      if (trade.closedAt !== null || trade.state === 'REJECTED') {
        continue;
      }
      const outcome: PaperTradeOutcome =
        trade.buyFilledSize > 0 && trade.sellFilledSize === 0
          ? 'BUY_ONLY'
          : trade.sellFilledSize > 0 && trade.buyFilledSize === 0
            ? 'SELL_ONLY'
            : 'PARTIAL_BOTH';
      this.closeTrade(trade, outcome, 'FAILED', finalTimestamp);
    }
    this.riskManager.observeExposure(this.trades);
  }

  getBalances(): PaperBalances {
    return clonePaperBalances(this.balances);
  }

  getRiskSummary(): PaperRiskSummary {
    return this.riskManager.getSummary(this.balances, this.trades);
  }

  getTrades(): LatencyPaperTrade[] {
    return this.trades.map(cloneTrade);
  }

  getOrders(): PaperOrder[] {
    return [...this.orders.values()].map(cloneOrder);
  }

  getFills(): PaperFill[] {
    return this.fills.map((fill) => ({ ...fill }));
  }

  getSummary(): PaperSessionSummary {
    const inventory = calculatePaperInventory(this.balances);
    const currentPortfolioValueUsdt =
      this.referenceBtcPrice === null
        ? null
        : valuePaperPortfolio(this.balances, this.referenceBtcPrice);
    return {
      tradesAttempted: this.trades.length,
      tradesFilled: this.trades.filter((trade) =>
        ['CLEAN_FILL', 'PARTIAL_BOTH', 'UNWOUND'].includes(
          trade.outcome ?? '',
        ),
      ).length,
      tradesRejected: this.trades.filter((trade) => trade.state === 'REJECTED')
        .length,
      grossPaperPnl: this.trades.reduce(
        (sum, trade) => sum + trade.entryGrossPnl + trade.unwindCashFlow,
        0,
      ),
      feesPaid: this.trades.reduce(
        (sum, trade) => sum + trade.entryFees + trade.unwindFees,
        0,
      ),
      netTradePnl: this.trades.reduce(
        (sum, trade) => sum + trade.realizedPaperPnl,
        0,
      ),
      referenceBtcPrice: this.referenceBtcPrice,
      initialPortfolioValueUsdt: this.initialPortfolioValueUsdt,
      currentPortfolioValueUsdt,
      paperPortfolioPnlUsdt:
        currentPortfolioValueUsdt === null ||
        this.initialPortfolioValueUsdt === null
          ? null
          : currentPortfolioValueUsdt - this.initialPortfolioValueUsdt,
      totalBTC: inventory.totalBTC,
      totalUSDT: inventory.totalUSDT,
      balances: clonePaperBalances(this.balances),
    };
  }

  getMetrics(): PaperExecutionMetrics {
    const buyLatencies = this.ordersBySide('BUY')
      .map((order) =>
        order.firstFillAt === null ? null : order.firstFillAt - order.submittedAt,
      )
      .filter((value): value is number => value !== null);
    const sellLatencies = this.ordersBySide('SELL')
      .map((order) =>
        order.firstFillAt === null ? null : order.firstFillAt - order.submittedAt,
      )
      .filter((value): value is number => value !== null);
    const unwindLatencies = this.ordersArray()
      .filter((order) => order.isUnwind)
      .map((order) =>
        order.firstFillAt === null ? null : order.firstFillAt - order.submittedAt,
      )
      .filter((value): value is number => value !== null);
    const finalized = this.trades.filter((trade) => trade.closedAt !== null);
    const unhedgedDurations = finalized
      .filter((trade) => this.everUnhedged.has(trade.id))
      .map((trade) => trade.unhedgedDurationMs);
    const residuals = finalized.map((trade) =>
      Math.abs(trade.residualBaseExposure),
    );
    const outcomes = (outcome: PaperTradeOutcome): number =>
      finalized.filter((trade) => trade.outcome === outcome).length;
    return {
      tradesTriggered: this.trades.filter((trade) => trade.state !== 'REJECTED')
        .length,
      pretradeRejections: this.trades.filter(
        (trade) => trade.outcome === 'REJECTED_PRETRADE',
      ).length,
      executionFailures: finalized.filter((trade) => trade.state === 'FAILED')
        .length,
      cleanFills: outcomes('CLEAN_FILL'),
      partialTrades: finalized.filter((trade) =>
        [trade.buyFilledSize, trade.sellFilledSize].some(
          (size) =>
            size > PAPER_BALANCE_EPSILON &&
            size + PAPER_BALANCE_EPSILON < trade.requestedBaseSize,
        ),
      ).length,
      buyOnlyCount: finalized.filter((trade) => this.everBuyOnly.has(trade.id))
        .length,
      sellOnlyCount: finalized.filter((trade) =>
        this.everSellOnly.has(trade.id),
      ).length,
      unhedgedTrades: finalized.filter((trade) =>
        this.everUnhedged.has(trade.id),
      ).length,
      unwindAttempts: this.ordersArray().filter((order) => order.isUnwind).length,
      unwindSuccess: outcomes('UNWOUND'),
      unwindFailures: outcomes('UNWIND_FAILED'),
      timeouts: this.ordersArray().filter((order) => order.state === 'TIMED_OUT')
        .length,
      averageBuyFillLatencyMs: average(buyLatencies),
      p50BuyFillLatencyMs: percentile(buyLatencies, 50),
      p95BuyFillLatencyMs: percentile(buyLatencies, 95),
      p99BuyFillLatencyMs: percentile(buyLatencies, 99),
      averageSellFillLatencyMs: average(sellLatencies),
      p50SellFillLatencyMs: percentile(sellLatencies, 50),
      p95SellFillLatencyMs: percentile(sellLatencies, 95),
      p99SellFillLatencyMs: percentile(sellLatencies, 99),
      averageUnwindFillLatencyMs: average(unwindLatencies),
      p50UnwindFillLatencyMs: percentile(unwindLatencies, 50),
      p95UnwindFillLatencyMs: percentile(unwindLatencies, 95),
      p99UnwindFillLatencyMs: percentile(unwindLatencies, 99),
      averageUnhedgedDurationMs: average(unhedgedDurations),
      p50UnhedgedDurationMs: percentile(unhedgedDurations, 50),
      p95UnhedgedDurationMs: percentile(unhedgedDurations, 95),
      p99UnhedgedDurationMs: percentile(unhedgedDurations, 99),
      averageAbsoluteResidualBtc: average(residuals),
      maxAbsoluteResidualBtc:
        residuals.length === 0 ? null : Math.max(...residuals),
      paperEntryPnl: this.trades.reduce(
        (sum, trade) => sum + this.calculateMatchedEntryPnl(trade),
        0,
      ),
      paperUnwindCost: this.trades.reduce(
        (sum, trade) =>
          sum +
          (this.calculateMatchedEntryPnl(trade) -
            this.calculateRealizedPaperPnl(trade)),
        0,
      ),
      paperFinalTradePnl: this.trades.reduce(
        (sum, trade) => sum + trade.realizedPaperPnl,
        0,
      ),
    };
  }

  private createTrade(
    event: OpportunityEvent,
    timestamp: number,
  ): LatencyPaperTrade {
    return {
      id: this.idGenerator(),
      opportunityEventId: event.id,
      symbol: event.symbol,
      buyExchange: event.buyExchange,
      sellExchange: event.sellExchange,
      requestedBaseSize: event.targetBaseSize,
      state: 'PENDING',
      createdAt: timestamp,
      filledAt: null,
      buyAveragePrice: null,
      sellAveragePrice: null,
      buyNotional: null,
      sellNotional: null,
      buyFee: null,
      sellFee: null,
      totalFee: null,
      grossPnl: null,
      netPnl: null,
      buyFilledSize: 0,
      sellFilledSize: 0,
      rejectionReason: null,
      riskReasons: [],
      qualifiedAt: event.qualifiedAt ?? event.updatedAt,
      decisionAt: timestamp,
      buySubmittedAt: timestamp,
      sellSubmittedAt: timestamp,
      buyArrivalAt: timestamp + this.config.buyOrderLatencyMs,
      sellArrivalAt: timestamp + this.config.sellOrderLatencyMs,
      buyCompletedAt: null,
      sellCompletedAt: null,
      closedAt: null,
      buyLatencyMs: null,
      sellLatencyMs: null,
      unhedgedSince: null,
      unhedgedDurationMs: 0,
      residualBaseExposure: 0,
      entryGrossPnl: 0,
      entryFees: 0,
      unwindCashFlow: 0,
      unwindFees: 0,
      realizedPaperPnl: 0,
      buyOrderId: '',
      sellOrderId: '',
      unwindOrderId: null,
      outcome: null,
    };
  }

  private createOrder(
    trade: LatencyPaperTrade,
    exchange: PaperOrder['exchange'],
    side: PaperOrderSide,
    size: number,
    submittedAt: number,
    arrivalAt: number,
    reservedQuoteRemaining: number,
    reservedBaseRemaining: number,
    isUnwind: boolean,
  ): InternalOrder {
    return {
      id: this.idGenerator(),
      tradeId: trade.id,
      exchange,
      side,
      requestedSize: size,
      filledSize: 0,
      remainingSize: size,
      state: 'SUBMITTED',
      submittedAt,
      arrivalAt,
      firstFillAt: null,
      completedAt: null,
      averageFillPrice: null,
      notional: 0,
      fee: 0,
      isUnwind,
      deadlineAt: submittedAt + this.config.orderTimeoutMs,
      reservedQuoteRemaining,
      reservedBaseRemaining,
    };
  }

  private reject(
    trade: LatencyPaperTrade,
    reason: PaperTradeRejectionReason,
    timestamp: number,
  ): LatencyPaperTrade {
    trade.state = 'REJECTED';
    trade.rejectionReason = reason;
    trade.outcome = 'REJECTED_PRETRADE';
    trade.closedAt = timestamp;
    this.trades.push(trade);
    this.emitTrade(trade, timestamp);
    return cloneTrade(trade);
  }

  private attemptEntryFill(
    order: InternalOrder,
    book: NormalizedOrderBook,
    timestamp: number,
  ): void {
    const feeRate = this.fees[order.exchange].takerRate;
    const simulation = simulateExecution(book, order.side, order.remainingSize);
    if (!this.config.allowPartialFill && !simulation.fullyFilled) {
      return;
    }
    let result: FillResult | null;
    if (order.side === 'BUY') {
      if (
        simulation.filledSize > PAPER_BALANCE_EPSILON &&
        simulation.notional * (1 + feeRate) <=
          order.reservedQuoteRemaining + PAPER_BALANCE_EPSILON
      ) {
        result = {
          size: simulation.filledSize,
          notional: simulation.notional,
          averagePrice: simulation.averageExecutionPrice ?? 0,
        };
      } else {
        result = fillWithinBudget(
          book,
          order.remainingSize,
          order.reservedQuoteRemaining,
          feeRate,
        );
      }
      if (
        !this.config.allowPartialFill &&
        (result === null ||
          result.size + PAPER_BALANCE_EPSILON < order.remainingSize)
      ) {
        return;
      }
    } else {
      result =
        simulation.filledSize <= PAPER_BALANCE_EPSILON ||
        simulation.averageExecutionPrice === null
          ? null
          : {
              size: simulation.filledSize,
              notional: simulation.notional,
              averagePrice: simulation.averageExecutionPrice,
            };
    }
    if (result === null || result.averagePrice <= 0) {
      return;
    }
    this.applyEntryFill(order, result, feeRate, timestamp);
  }

  private applyEntryFill(
    order: InternalOrder,
    result: FillResult,
    feeRate: number,
    timestamp: number,
  ): void {
    const fee = result.notional * feeRate;
    if (order.side === 'BUY') {
      this.balances[order.exchange] = consumeReservedPaperBuy(
        this.balances[order.exchange],
        result.notional,
        fee,
        result.size,
      );
      order.reservedQuoteRemaining = Math.max(
        0,
        order.reservedQuoteRemaining - result.notional - fee,
      );
    } else {
      this.balances[order.exchange] = consumeReservedPaperSell(
        this.balances[order.exchange],
        result.notional,
        fee,
        result.size,
      );
      order.reservedBaseRemaining = Math.max(
        0,
        order.reservedBaseRemaining - result.size,
      );
    }
    this.recordFill(order, result, fee, timestamp);
    if (order.remainingSize <= PAPER_BALANCE_EPSILON) {
      order.remainingSize = 0;
      order.state = 'FILLED';
      order.completedAt = timestamp;
      this.releaseOrderReservation(order);
    } else {
      order.state = 'PARTIALLY_FILLED';
    }
    this.emitOrder(order, timestamp);
  }

  private recordFill(
    order: InternalOrder,
    result: FillResult,
    fee: number,
    timestamp: number,
  ): void {
    order.firstFillAt ??= timestamp;
    order.filledSize += result.size;
    order.remainingSize = Math.max(0, order.requestedSize - order.filledSize);
    order.notional += result.notional;
    order.fee += fee;
    order.averageFillPrice = order.notional / order.filledSize;
    const fill: PaperFill = {
      id: this.idGenerator(),
      orderId: order.id,
      tradeId: order.tradeId,
      exchange: order.exchange,
      side: order.side,
      timestamp,
      size: result.size,
      averagePrice: result.averagePrice,
      notional: result.notional,
      fee,
      isUnwind: order.isUnwind,
    };
    this.fills.push(fill);
    this.onExecutionEvent?.({ type: 'FILL', recordedAt: timestamp, fill: { ...fill } });
  }

  private expireOrders(timestamp: number): void {
    for (const order of this.orders.values()) {
      if (terminal(order) || timestamp < order.deadlineAt) {
        continue;
      }
      order.state = 'TIMED_OUT';
      order.completedAt = timestamp;
      this.releaseOrderReservation(order);
      this.emitOrder(order, timestamp);
    }
  }

  private releaseOrderReservation(order: InternalOrder): void {
    if (order.reservedQuoteRemaining > PAPER_BALANCE_EPSILON) {
      this.balances[order.exchange] = releasePaperUsdt(
        this.balances[order.exchange],
        order.reservedQuoteRemaining,
      );
      order.reservedQuoteRemaining = 0;
    }
    if (order.reservedBaseRemaining > PAPER_BALANCE_EPSILON) {
      this.balances[order.exchange] = releasePaperBtc(
        this.balances[order.exchange],
        order.reservedBaseRemaining,
      );
      order.reservedBaseRemaining = 0;
    }
  }

  private refreshAndMaybeUnwind(timestamp: number): void {
    for (const trade of this.trades) {
      if (trade.closedAt !== null || trade.state === 'REJECTED') {
        continue;
      }
      if (trade.unwindOrderId !== null) {
        this.refreshTradeAfterUnwind(trade, timestamp);
        continue;
      }
      this.refreshTrade(trade, timestamp);
      if (trade.closedAt !== null) {
        continue;
      }
      if (
        trade.unhedgedSince !== null &&
        timestamp - trade.unhedgedSince >= this.config.maxUnhedgedDurationMs
      ) {
        this.attemptUnwind(trade, timestamp);
      }
    }
  }

  private refreshTrade(trade: LatencyPaperTrade, timestamp: number): void {
    const buy = this.requireOrder(trade.buyOrderId);
    const sell = this.requireOrder(trade.sellOrderId);
    trade.buyFilledSize = buy.filledSize;
    trade.sellFilledSize = sell.filledSize;
    trade.buyAveragePrice = buy.averageFillPrice;
    trade.sellAveragePrice = sell.averageFillPrice;
    trade.buyNotional = buy.notional;
    trade.sellNotional = sell.notional;
    trade.buyFee = buy.fee;
    trade.sellFee = sell.fee;
    trade.totalFee = buy.fee + sell.fee + trade.unwindFees;
    trade.entryGrossPnl = sell.notional - buy.notional;
    trade.entryFees = buy.fee + sell.fee;
    trade.grossPnl = trade.entryGrossPnl + trade.unwindCashFlow;
    trade.realizedPaperPnl = this.calculateRealizedPaperPnl(trade);
    trade.netPnl = trade.realizedPaperPnl;
    trade.buyCompletedAt = buy.completedAt;
    trade.sellCompletedAt = sell.completedAt;
    trade.buyLatencyMs =
      buy.firstFillAt === null ? null : buy.firstFillAt - buy.submittedAt;
    trade.sellLatencyMs =
      sell.firstFillAt === null ? null : sell.firstFillAt - sell.submittedAt;
    trade.residualBaseExposure =
      buy.filledSize - sell.filledSize + this.unwindBaseEffect(trade);

    if (Math.abs(trade.residualBaseExposure) > PAPER_BALANCE_EPSILON) {
      if (trade.unhedgedSince === null) {
        trade.unhedgedSince = timestamp;
        this.everUnhedged.add(trade.id);
        this.unhedgedAccumulatedMs.set(
          trade.id,
          this.unhedgedAccumulatedMs.get(trade.id) ?? 0,
        );
      }
      trade.unhedgedDurationMs =
        (this.unhedgedAccumulatedMs.get(trade.id) ?? 0) +
        (timestamp - trade.unhedgedSince);
    } else if (trade.unhedgedSince !== null) {
      const accumulated =
        (this.unhedgedAccumulatedMs.get(trade.id) ?? 0) +
        (timestamp - trade.unhedgedSince);
      this.unhedgedAccumulatedMs.set(trade.id, accumulated);
      trade.unhedgedDurationMs = accumulated;
      trade.unhedgedSince = null;
    }

    if (buy.state === 'FILLED' && sell.state === 'FILLED') {
      trade.state = 'FILLED';
      trade.outcome = 'CLEAN_FILL';
      trade.filledAt = Math.max(buy.completedAt ?? 0, sell.completedAt ?? 0);
      trade.closedAt = trade.filledAt;
      this.emitTrade(trade, timestamp);
      this.riskManager.observeTerminalTrade(trade);
      return;
    }
    if (terminal(buy) && terminal(sell)) {
      if (buy.filledSize === 0 && sell.filledSize === 0) {
        this.closeTrade(trade, 'TIMEOUT_NO_FILL', 'CLOSED', timestamp);
      } else if (
        Math.abs(trade.residualBaseExposure) <= PAPER_BALANCE_EPSILON
      ) {
        this.closeTrade(trade, 'PARTIAL_BOTH', 'CLOSED', timestamp);
      } else {
        trade.state = 'UNHEDGED';
        this.emitTrade(trade, timestamp);
      }
      return;
    }
    if (buy.filledSize > 0 && sell.filledSize === 0) {
      trade.state = 'ONE_LEG_FILLED';
      this.everBuyOnly.add(trade.id);
    } else if (sell.filledSize > 0 && buy.filledSize === 0) {
      trade.state = 'ONE_LEG_FILLED';
      this.everSellOnly.add(trade.id);
    } else if (
      Math.abs(trade.residualBaseExposure) > PAPER_BALANCE_EPSILON
    ) {
      trade.state = 'UNHEDGED';
    } else if (buy.filledSize > 0 || sell.filledSize > 0) {
      trade.state = 'PARTIALLY_FILLED';
    } else {
      trade.state = 'SUBMITTING';
    }
    this.emitTrade(trade, timestamp);
  }

  private attemptUnwind(trade: LatencyPaperTrade, timestamp: number): void {
    if (trade.unwindOrderId !== null) {
      return;
    }
    const exposure = trade.residualBaseExposure;
    if (Math.abs(exposure) <= PAPER_BALANCE_EPSILON) {
      return;
    }
    this.cancelOpenEntryOrders(trade, timestamp);
    trade.state = 'UNWINDING';
    const side: PaperOrderSide = exposure > 0 ? 'SELL' : 'BUY';
    const exchange = exposure > 0 ? trade.buyExchange : trade.sellExchange;
    const requestedSize = Math.abs(exposure);
    let reservedQuote = 0;
    let reservedBase = 0;
    let insufficientFunds = false;

    if (side === 'BUY') {
      reservedQuote = this.balances[exchange].usdtAvailable;
      insufficientFunds = reservedQuote <= PAPER_BALANCE_EPSILON;
      if (!insufficientFunds) {
        this.balances[exchange] = reservePaperUsdt(
          this.balances[exchange],
          reservedQuote,
        );
      }
    } else {
      insufficientFunds =
        this.balances[exchange].btcAvailable + PAPER_BALANCE_EPSILON <
        requestedSize;
      if (!insufficientFunds) {
        reservedBase = requestedSize;
        this.balances[exchange] = reservePaperBtc(
          this.balances[exchange],
          reservedBase,
        );
      }
    }

    const order = this.createOrder(
      trade,
      exchange,
      side,
      requestedSize,
      timestamp,
      timestamp + this.config.unwindOrderLatencyMs,
      reservedQuote,
      reservedBase,
      true,
    );
    trade.unwindOrderId = order.id;
    this.orders.set(order.id, order);
    this.emitOrder(order, timestamp);
    this.emitTrade(trade, timestamp);
    if (insufficientFunds) {
      order.state = 'CANCELLED';
      order.completedAt = timestamp;
      this.emitOrder(order, timestamp);
      this.closeTrade(trade, 'UNWIND_FAILED', 'FAILED', timestamp);
    }
  }

  private attemptUnwindFill(
    order: InternalOrder,
    book: NormalizedOrderBook,
    timestamp: number,
  ): void {
    const feeRate = this.fees[order.exchange].takerRate;
    let result: FillResult | null = null;
    if (order.side === 'BUY') {
      result = fillWithinBudget(
        book,
        order.remainingSize,
        order.reservedQuoteRemaining,
        feeRate,
      );
    } else {
      const simulation = simulateExecution(book, order.side, order.remainingSize);
      if (
        simulation.filledSize > PAPER_BALANCE_EPSILON &&
        simulation.averageExecutionPrice !== null
      ) {
        result = {
          size: simulation.filledSize,
          notional: simulation.notional,
          averagePrice: simulation.averageExecutionPrice,
        };
      }
    }
    if (result === null || result.size <= PAPER_BALANCE_EPSILON) {
      return;
    }

    const fee = result.notional * feeRate;
    if (order.side === 'BUY') {
      this.balances[order.exchange] = consumeReservedPaperBuy(
        this.balances[order.exchange],
        result.notional,
        fee,
        result.size,
      );
      order.reservedQuoteRemaining = Math.max(
        0,
        order.reservedQuoteRemaining - result.notional - fee,
      );
    } else {
      this.balances[order.exchange] = consumeReservedPaperSell(
        this.balances[order.exchange],
        result.notional,
        fee,
        result.size,
      );
      order.reservedBaseRemaining = Math.max(
        0,
        order.reservedBaseRemaining - result.size,
      );
    }

    this.recordFill(order, result, fee, timestamp);
    const trade = this.trades.find((candidate) => candidate.id === order.tradeId);
    if (trade === undefined) {
      throw new Error(`Missing paper trade ${order.tradeId}.`);
    }
    trade.unwindCashFlow +=
      order.side === 'SELL' ? result.notional : -result.notional;
    trade.unwindFees += fee;
    if (order.remainingSize <= PAPER_BALANCE_EPSILON) {
      order.remainingSize = 0;
      order.state = 'FILLED';
      order.completedAt = timestamp;
      this.releaseOrderReservation(order);
    } else {
      order.state = 'PARTIALLY_FILLED';
    }
    this.emitOrder(order, timestamp);
    this.refreshTradeAfterUnwind(trade, timestamp);
  }

  private refreshTradeAfterUnwind(
    trade: LatencyPaperTrade,
    timestamp: number,
  ): void {
    trade.residualBaseExposure =
      this.requireOrder(trade.buyOrderId).filledSize -
      this.requireOrder(trade.sellOrderId).filledSize +
      this.unwindBaseEffect(trade);
    trade.totalFee = trade.entryFees + trade.unwindFees;
    trade.grossPnl = trade.entryGrossPnl + trade.unwindCashFlow;
    trade.realizedPaperPnl = this.calculateRealizedPaperPnl(trade);
    trade.netPnl = trade.realizedPaperPnl;
    if (trade.unhedgedSince !== null) {
      trade.unhedgedDurationMs =
        (this.unhedgedAccumulatedMs.get(trade.id) ?? 0) +
        (timestamp - trade.unhedgedSince);
    }
    if (Math.abs(trade.residualBaseExposure) <= PAPER_BALANCE_EPSILON) {
      trade.residualBaseExposure = 0;
      this.closeTrade(trade, 'UNWOUND', 'CLOSED', timestamp);
    } else if (
      trade.unwindOrderId !== null &&
      terminal(this.requireOrder(trade.unwindOrderId))
    ) {
      this.closeTrade(trade, 'UNWIND_FAILED', 'FAILED', timestamp);
    } else {
      trade.state = 'UNWINDING';
      this.emitTrade(trade, timestamp);
    }
  }

  private unwindBaseEffect(trade: LatencyPaperTrade): number {
    if (trade.unwindOrderId === null) {
      return 0;
    }
    const order = this.orders.get(trade.unwindOrderId);
    if (order === undefined) {
      return 0;
    }
    return order.side === 'BUY' ? order.filledSize : -order.filledSize;
  }

  private calculateMatchedEntryPnl(trade: LatencyPaperTrade): number {
    const buy = this.orders.get(trade.buyOrderId);
    const sell = this.orders.get(trade.sellOrderId);
    if (buy === undefined || sell === undefined) {
      return 0;
    }
    const matchedSize = Math.min(buy.filledSize, sell.filledSize);
    if (
      matchedSize <= PAPER_BALANCE_EPSILON ||
      buy.averageFillPrice === null ||
      sell.averageFillPrice === null
    ) {
      return 0;
    }
    const allocatedBuyFee = buy.fee * (matchedSize / buy.filledSize);
    const allocatedSellFee = sell.fee * (matchedSize / sell.filledSize);
    return (
      matchedSize * (sell.averageFillPrice - buy.averageFillPrice) -
      allocatedBuyFee -
      allocatedSellFee
    );
  }

  private calculateRealizedPaperPnl(trade: LatencyPaperTrade): number {
    let realized = this.calculateMatchedEntryPnl(trade);
    if (trade.unwindOrderId === null) {
      return realized;
    }
    const unwind = this.orders.get(trade.unwindOrderId);
    const buy = this.requireOrder(trade.buyOrderId);
    const sell = this.requireOrder(trade.sellOrderId);
    if (
      unwind === undefined ||
      unwind.filledSize <= PAPER_BALANCE_EPSILON ||
      unwind.averageFillPrice === null
    ) {
      return realized;
    }
    if (unwind.side === 'SELL' && buy.averageFillPrice !== null) {
      const allocatedEntryFee =
        buy.filledSize <= PAPER_BALANCE_EPSILON
          ? 0
          : buy.fee * (unwind.filledSize / buy.filledSize);
      realized +=
        unwind.filledSize *
          (unwind.averageFillPrice - buy.averageFillPrice) -
        allocatedEntryFee -
        unwind.fee;
    } else if (unwind.side === 'BUY' && sell.averageFillPrice !== null) {
      const allocatedEntryFee =
        sell.filledSize <= PAPER_BALANCE_EPSILON
          ? 0
          : sell.fee * (unwind.filledSize / sell.filledSize);
      realized +=
        unwind.filledSize *
          (sell.averageFillPrice - unwind.averageFillPrice) -
        allocatedEntryFee -
        unwind.fee;
    }
    return realized;
  }

  private cancelOpenEntryOrders(
    trade: LatencyPaperTrade,
    timestamp: number,
  ): void {
    for (const orderId of [trade.buyOrderId, trade.sellOrderId]) {
      const order = this.requireOrder(orderId);
      if (terminal(order)) {
        continue;
      }
      order.state = 'CANCELLED';
      order.completedAt = timestamp;
      this.releaseOrderReservation(order);
      this.emitOrder(order, timestamp);
    }
  }

  private closeTrade(
    trade: LatencyPaperTrade,
    outcome: PaperTradeOutcome,
    state: 'CLOSED' | 'FAILED',
    timestamp: number,
  ): void {
    trade.state = state;
    trade.outcome = outcome;
    trade.closedAt = timestamp;
    trade.filledAt =
      trade.buyFilledSize > 0 || trade.sellFilledSize > 0 ? timestamp : null;
    this.emitTrade(trade, timestamp);
    this.riskManager.observeTerminalTrade(trade);
  }

  private observePortfolioBooks(): void {
    const bybit = this.latestBooks.get('bybit')?.book;
    const okx = this.latestBooks.get('okx')?.book;
    if (bybit === undefined || okx === undefined) {
      return;
    }
    const reference = calculateReferenceBtcPrice(bybit, okx);
    if (reference === null) {
      return;
    }
    this.referenceBtcPrice = reference;
    this.initialPortfolioValueUsdt ??= valuePaperPortfolio(
      this.initialBalances,
      reference,
    );
  }

  private requireOrder(orderId: string): InternalOrder {
    const order = this.orders.get(orderId);
    if (order === undefined) {
      throw new Error(`Missing paper order ${orderId}.`);
    }
    return order;
  }

  private ordersArray(): InternalOrder[] {
    return [...this.orders.values()];
  }

  private ordersBySide(side: PaperOrderSide): InternalOrder[] {
    return this.ordersArray().filter(
      (order) => order.side === side && !order.isUnwind,
    );
  }

  private emitTrade(trade: LatencyPaperTrade, timestamp: number): void {
    this.onExecutionEvent?.({
      type: 'TRADE',
      recordedAt: timestamp,
      trade: cloneTrade(trade),
    });
  }

  private emitOrder(order: InternalOrder, timestamp: number): void {
    this.onExecutionEvent?.({
      type: 'ORDER',
      recordedAt: timestamp,
      order: cloneOrder(order),
    });
  }
}
