import { randomUUID } from 'node:crypto';

import { FEES, type FeeConfig } from '../config/fees.js';
import {
  INITIAL_PAPER_BALANCES,
  MAX_PAPER_TRIGGER_AGE_MS,
  PAPER_BALANCE_EPSILON,
} from '../config/paper.js';
import type { OpportunityEvent } from '../scanner/opportunity.js';
import type { OpportunityQualification } from '../scanner/opportunity-filter.js';
import { simulateExecution } from '../scanner/execution-simulator.js';
import type { SyncAssessment } from '../timing/sync-model.js';
import {
  isValidNormalizedOrderBook,
  type NormalizedOrderBook,
} from '../types/orderbook.js';
import {
  clonePaperBalances,
  createPaperBalances,
  settlePaperTradeAtomically,
  type PaperBalances,
} from './balances.js';
import {
  calculatePaperInventory,
  calculateReferenceBtcPrice,
  valuePaperPortfolio,
} from './portfolio.js';
import type {
  PaperSessionSummary,
  PaperTrade,
  PaperTradeRejectionReason,
} from './types.js';

export interface PaperExecutionInput {
  event: OpportunityEvent;
  bybitBook: NormalizedOrderBook;
  okxBook: NormalizedOrderBook;
  syncAssessment: SyncAssessment;
  timestamp: number;
  latestQualification?: OpportunityQualification;
}

export interface PaperTradingEngineOptions {
  initialBalances?: Readonly<PaperBalances>;
  fees?: FeeConfig;
  maxTriggerAgeMs?: number;
  idGenerator?: () => string;
}

function initialBalancesFromConfig(): PaperBalances {
  return {
    bybit: { ...INITIAL_PAPER_BALANCES.bybit },
    okx: { ...INITIAL_PAPER_BALANCES.okx },
  };
}

export class PaperTradingEngine {
  private balances: PaperBalances;
  private readonly initialBalances: PaperBalances;
  private readonly fees: FeeConfig;
  private readonly maxTriggerAgeMs: number;
  private readonly idGenerator: () => string;
  private readonly seenEventIds = new Set<string>();
  private readonly trades: PaperTrade[] = [];
  private referenceBtcPrice: number | null = null;
  private initialPortfolioValueUsdt: number | null = null;

  constructor(options: PaperTradingEngineOptions = {}) {
    this.balances = createPaperBalances(
      options.initialBalances ?? initialBalancesFromConfig(),
    );
    this.initialBalances = clonePaperBalances(this.balances);
    this.fees = options.fees ?? FEES;
    this.maxTriggerAgeMs = options.maxTriggerAgeMs ?? MAX_PAPER_TRIGGER_AGE_MS;
    this.idGenerator = options.idGenerator ?? randomUUID;
    if (!Number.isFinite(this.maxTriggerAgeMs) || this.maxTriggerAgeMs < 0) {
      throw new RangeError('Paper trigger age must be finite and non-negative.');
    }
  }

  observeBooks(
    bybitBook: NormalizedOrderBook,
    okxBook: NormalizedOrderBook,
  ): number | null {
    const reference = calculateReferenceBtcPrice(bybitBook, okxBook);
    if (reference === null) {
      return null;
    }
    this.referenceBtcPrice = reference;
    this.initialPortfolioValueUsdt ??= valuePaperPortfolio(
      this.initialBalances,
      reference,
    );
    return reference;
  }

  executeQualifiedOpportunity(input: PaperExecutionInput): PaperTrade {
    const { event, bybitBook, okxBook, syncAssessment, timestamp } = input;
    const pending = this.createPendingTrade(event, timestamp);
    if (this.seenEventIds.has(event.id)) {
      return this.reject(pending, 'DUPLICATE_EVENT');
    }
    this.seenEventIds.add(event.id);

    if (event.state !== 'QUALIFIED') {
      return this.reject(pending, 'NOT_QUALIFIED');
    }
    const triggerAgeMs = timestamp - event.updatedAt;
    if (triggerAgeMs < 0 || triggerAgeMs > this.maxTriggerAgeMs) {
      return this.reject(pending, 'STALE_OPPORTUNITY');
    }
    if (syncAssessment.status !== 'SYNC_HEALTHY') {
      return this.reject(pending, 'SYNC_UNHEALTHY');
    }
    if (
      !isValidNormalizedOrderBook(bybitBook) ||
      !isValidNormalizedOrderBook(okxBook)
    ) {
      return this.reject(pending, 'INSUFFICIENT_DEPTH');
    }

    const buyBook = event.buyExchange === 'bybit' ? bybitBook : okxBook;
    const sellBook = event.sellExchange === 'bybit' ? bybitBook : okxBook;
    const buyExecution = simulateExecution(
      buyBook,
      'BUY',
      event.targetBaseSize,
    );
    const sellExecution = simulateExecution(
      sellBook,
      'SELL',
      event.targetBaseSize,
    );
    pending.buyAveragePrice = buyExecution.averageExecutionPrice;
    pending.sellAveragePrice = sellExecution.averageExecutionPrice;
    pending.buyNotional = buyExecution.notional;
    pending.sellNotional = sellExecution.notional;
    pending.buyFilledSize = buyExecution.filledSize;
    pending.sellFilledSize = sellExecution.filledSize;
    if (!buyExecution.fullyFilled || !sellExecution.fullyFilled) {
      return this.reject(pending, 'INSUFFICIENT_DEPTH');
    }

    const buyFee = buyExecution.notional * this.fees[event.buyExchange].takerRate;
    const sellFee =
      sellExecution.notional * this.fees[event.sellExchange].takerRate;
    const totalFee = buyFee + sellFee;
    const grossPnl = sellExecution.notional - buyExecution.notional;
    const netPnl = grossPnl - totalFee;
    pending.buyFee = buyFee;
    pending.sellFee = sellFee;
    pending.totalFee = totalFee;
    pending.grossPnl = grossPnl;
    pending.netPnl = netPnl;

    if (netPnl <= 0) {
      return this.reject(pending, 'NET_NOT_POSITIVE');
    }
    if (
      input.latestQualification !== undefined &&
      !input.latestQualification.qualified
    ) {
      return this.reject(pending, 'NOT_QUALIFIED');
    }

    const requiredUsdt = buyExecution.notional + buyFee;
    if (
      this.balances[event.buyExchange].usdtAvailable +
        PAPER_BALANCE_EPSILON <
      requiredUsdt
    ) {
      return this.reject(pending, 'INSUFFICIENT_BUY_USDT');
    }
    if (
      this.balances[event.sellExchange].btcAvailable +
        PAPER_BALANCE_EPSILON <
      event.targetBaseSize
    ) {
      return this.reject(pending, 'INSUFFICIENT_SELL_BTC');
    }

    this.observeBooks(bybitBook, okxBook);
    const nextBalances = settlePaperTradeAtomically(this.balances, {
      buyExchange: event.buyExchange,
      sellExchange: event.sellExchange,
      buyNotional: buyExecution.notional,
      sellNotional: sellExecution.notional,
      buyFee,
      sellFee,
      buyFilledSize: buyExecution.filledSize,
      sellFilledSize: sellExecution.filledSize,
    });
    this.balances = nextBalances;
    pending.state = 'FILLED';
    pending.filledAt = timestamp;
    this.trades.push(pending);
    return { ...pending };
  }

  getBalances(): PaperBalances {
    return clonePaperBalances(this.balances);
  }

  getTrades(): PaperTrade[] {
    return this.trades.map((trade) => ({ ...trade }));
  }

  getSummary(): PaperSessionSummary {
    const filled = this.trades.filter((trade) => trade.state === 'FILLED');
    const inventory = calculatePaperInventory(this.balances);
    const currentPortfolioValueUsdt =
      this.referenceBtcPrice === null
        ? null
        : valuePaperPortfolio(this.balances, this.referenceBtcPrice);
    return {
      tradesAttempted: this.trades.length,
      tradesFilled: filled.length,
      tradesRejected: this.trades.filter((trade) => trade.state === 'REJECTED')
        .length,
      grossPaperPnl: filled.reduce(
        (sum, trade) => sum + (trade.grossPnl ?? 0),
        0,
      ),
      feesPaid: filled.reduce((sum, trade) => sum + (trade.totalFee ?? 0), 0),
      netTradePnl: filled.reduce((sum, trade) => sum + (trade.netPnl ?? 0), 0),
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

  private createPendingTrade(
    event: OpportunityEvent,
    timestamp: number,
  ): PaperTrade {
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
    };
  }

  private reject(
    trade: PaperTrade,
    rejectionReason: PaperTradeRejectionReason,
  ): PaperTrade {
    trade.state = 'REJECTED';
    trade.rejectionReason = rejectionReason;
    this.trades.push(trade);
    return { ...trade };
  }
}
