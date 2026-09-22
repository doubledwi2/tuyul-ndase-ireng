import type { FeeConfig } from '../config/fees.js';
import {
  validatePaperExecutionConfig,
  type PaperExecutionConfig,
} from '../config/paper.js';
import {
  validatePaperRiskConfig,
  type PaperRiskConfig,
} from '../config/risk.js';
import {
  PaperRiskManager,
  type PaperRiskManagerState,
} from '../risk/paper-risk-manager.js';
import { createPaperBalances, type PaperBalances } from './balances.js';
import type {
  LatencyPaperTrade,
  PaperFill,
  PaperOrder,
} from './types.js';

export interface PaperOrderCheckpoint extends PaperOrder {
  deadlineAt: number;
  reservedQuoteRemaining: number;
  reservedBaseRemaining: number;
}

export interface PaperEngineState {
  balances: PaperBalances;
  initialBalances: PaperBalances;
  trades: LatencyPaperTrade[];
  orders: PaperOrderCheckpoint[];
  fills: PaperFill[];
  seenEventIds: string[];
  everUnhedgedTradeIds: string[];
  everBuyOnlyTradeIds: string[];
  everSellOnlyTradeIds: string[];
  recoveryRequiredTradeIds: string[];
  unhedgedAccumulatedMs: Array<[string, number]>;
  referenceBtcPrice: number | null;
  initialPortfolioValueUsdt: number | null;
  lastLogicalTimestamp: number;
  fees: FeeConfig;
  executionConfig: PaperExecutionConfig;
  riskConfig: PaperRiskConfig;
  maxTriggerAgeMs: number;
  maxPaperHistory: number;
  riskState: PaperRiskManagerState;
}

const TRADE_STATES = new Set([
  'PENDING',
  'SUBMITTING',
  'PARTIALLY_FILLED',
  'ONE_LEG_FILLED',
  'FILLED',
  'UNHEDGED',
  'UNWINDING',
  'RECOVERY_REQUIRED',
  'CLOSED',
  'REJECTED',
  'FAILED',
]);
const ORDER_STATES = new Set([
  'PENDING',
  'SUBMITTED',
  'PARTIALLY_FILLED',
  'FILLED',
  'TIMED_OUT',
  'CANCELLED',
]);
const SIDES = new Set(['BUY', 'SELL']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function optionalFinite(value: unknown): boolean {
  return value === null || finite(value);
}

function validExchange(value: unknown): value is 'bybit' | 'okx' {
  return value === 'bybit' || value === 'okx';
}

function validateAllNumbers(value: unknown, path: string): void {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`Invalid engine state: ${path} is not finite.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateAllNumbers(item, `${path}[${index}]`));
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      validateAllNumbers(child, `${path}.${key}`);
    }
  }
}

function requireUniqueIds(
  values: readonly unknown[],
  kind: string,
): Set<string> {
  const ids = values.map((value) => {
    if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) {
      throw new Error(`Invalid engine state: ${kind} ID.`);
    }
    return value.id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Invalid engine state: duplicate ${kind} ID.`);
  }
  return new Set(ids);
}

function validateStringIds(
  value: unknown,
  name: string,
  validIds?: ReadonlySet<string>,
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (id) =>
        typeof id === 'string' &&
        id.length > 0 &&
        (validIds === undefined || validIds.has(id)),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`Invalid engine state: ${name}.`);
  }
}

function approximatelyEqual(left: number, right: number): boolean {
  const tolerance = 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= tolerance;
}

export function validatePaperEngineState(
  value: unknown,
): asserts value is PaperEngineState {
  if (!isRecord(value)) {
    throw new Error('Invalid engine state: expected an object.');
  }
  validateAllNumbers(value, 'engineState');
  const state = value as Partial<PaperEngineState>;
  createPaperBalances(state.balances as PaperBalances);
  createPaperBalances(state.initialBalances as PaperBalances);
  if (
    !Array.isArray(state.trades) ||
    !Array.isArray(state.orders) ||
    !Array.isArray(state.fills)
  ) {
    throw new Error('Invalid engine state: history arrays are missing.');
  }
  const tradeIds = requireUniqueIds(state.trades, 'trade');
  requireUniqueIds(state.orders, 'order');
  requireUniqueIds(state.fills, 'fill');
  const ordersById = new Map(state.orders.map((order) => [order.id, order]));
  const allIds = [
    ...state.trades.map((trade) => trade.id),
    ...state.orders.map((order) => order.id),
    ...state.fills.map((fill) => fill.id),
  ];
  if (new Set(allIds).size !== allIds.length) {
    throw new Error('Invalid engine state: IDs collide across entity types.');
  }

  for (const trade of state.trades) {
    if (
      !TRADE_STATES.has(trade.state) ||
      !validExchange(trade.buyExchange) ||
      !validExchange(trade.sellExchange) ||
      trade.buyExchange === trade.sellExchange ||
      trade.symbol !== 'BTC/USDT' ||
      !nonNegative(trade.requestedBaseSize) ||
      !optionalFinite(trade.closedAt)
    ) {
      throw new Error(`Invalid engine state: trade ${trade.id}.`);
    }
    if (trade.state !== 'REJECTED') {
      const buyOrder = ordersById.get(trade.buyOrderId);
      const sellOrder = ordersById.get(trade.sellOrderId);
      if (
        buyOrder === undefined ||
        sellOrder === undefined ||
        buyOrder.tradeId !== trade.id ||
        sellOrder.tradeId !== trade.id ||
        buyOrder.side !== 'BUY' ||
        sellOrder.side !== 'SELL' ||
        buyOrder.exchange !== trade.buyExchange ||
        sellOrder.exchange !== trade.sellExchange ||
        buyOrder.isUnwind ||
        sellOrder.isUnwind
      ) {
        throw new Error(`Invalid engine state: trade ${trade.id} order reference.`);
      }
    }
    if (trade.unwindOrderId !== null) {
      const unwindOrder = ordersById.get(trade.unwindOrderId);
      if (
        unwindOrder === undefined ||
        unwindOrder.tradeId !== trade.id ||
        !unwindOrder.isUnwind
      ) {
        throw new Error(
          `Invalid engine state: trade ${trade.id} unwind reference.`,
        );
      }
    }
  }

  for (const order of state.orders) {
    if (
      !tradeIds.has(order.tradeId) ||
      !validExchange(order.exchange) ||
      !SIDES.has(order.side) ||
      !ORDER_STATES.has(order.state) ||
      !nonNegative(order.requestedSize) ||
      !nonNegative(order.filledSize) ||
      !nonNegative(order.remainingSize) ||
      !nonNegative(order.notional) ||
      !nonNegative(order.fee) ||
      !nonNegative(order.reservedQuoteRemaining) ||
      !nonNegative(order.reservedBaseRemaining) ||
      !nonNegative(order.deadlineAt) ||
      !approximatelyEqual(
        order.requestedSize,
        order.filledSize + order.remainingSize,
      )
    ) {
      throw new Error(`Invalid engine state: order ${order.id}.`);
    }
    if (
      ['FILLED', 'TIMED_OUT', 'CANCELLED'].includes(order.state) &&
      (order.reservedQuoteRemaining > 1e-9 ||
        order.reservedBaseRemaining > 1e-9)
    ) {
      throw new Error(`Invalid engine state: terminal order ${order.id} reserves funds.`);
    }
  }

  for (const fill of state.fills) {
    const order = ordersById.get(fill.orderId);
    if (
      order === undefined ||
      fill.tradeId !== order.tradeId ||
      !tradeIds.has(fill.tradeId) ||
      !validExchange(fill.exchange) ||
      !SIDES.has(fill.side) ||
      !nonNegative(fill.size) ||
      !nonNegative(fill.averagePrice) ||
      !nonNegative(fill.notional) ||
      !nonNegative(fill.fee)
    ) {
      throw new Error(`Invalid engine state: fill ${fill.id}.`);
    }
  }

  for (const exchange of ['bybit', 'okx'] as const) {
    const expectedUsdt = state.orders
      .filter((order) => order.exchange === exchange)
      .reduce((sum, order) => sum + order.reservedQuoteRemaining, 0);
    const expectedBtc = state.orders
      .filter((order) => order.exchange === exchange)
      .reduce((sum, order) => sum + order.reservedBaseRemaining, 0);
    const balance = state.balances?.[exchange];
    if (
      balance === undefined ||
      !approximatelyEqual(expectedUsdt, balance.usdtReserved) ||
      !approximatelyEqual(expectedBtc, balance.btcReserved)
    ) {
      throw new Error(
        `Invalid engine state: ${exchange} reservation mismatch (orders BTC ${expectedBtc}, balance BTC ${balance?.btcReserved}; orders USDT ${expectedUsdt}, balance USDT ${balance?.usdtReserved}).`,
      );
    }
  }

  validateStringIds(state.seenEventIds, 'seen opportunity IDs');
  validateStringIds(state.everUnhedgedTradeIds, 'unhedged trade IDs', tradeIds);
  validateStringIds(state.everBuyOnlyTradeIds, 'buy-only trade IDs', tradeIds);
  validateStringIds(state.everSellOnlyTradeIds, 'sell-only trade IDs', tradeIds);
  validateStringIds(
    state.recoveryRequiredTradeIds,
    'recovery-required trade IDs',
    tradeIds,
  );
  if (
    !Array.isArray(state.unhedgedAccumulatedMs) ||
    !state.unhedgedAccumulatedMs.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        tradeIds.has(entry[0]) &&
        nonNegative(entry[1]),
    ) ||
    new Set(state.unhedgedAccumulatedMs.map(([id]) => id)).size !==
      state.unhedgedAccumulatedMs.length
  ) {
    throw new Error('Invalid engine state: unhedged duration metadata.');
  }
  if (
    !optionalFinite(state.referenceBtcPrice) ||
    !optionalFinite(state.initialPortfolioValueUsdt) ||
    !nonNegative(state.lastLogicalTimestamp) ||
    !nonNegative(state.maxTriggerAgeMs) ||
    !Number.isInteger(state.maxPaperHistory) ||
    (state.maxPaperHistory ?? 0) <= 0
  ) {
    throw new Error('Invalid engine state: execution metadata.');
  }
  if (!isRecord(state.fees)) {
    throw new Error('Invalid engine state: fee configuration.');
  }
  for (const exchange of ['bybit', 'okx'] as const) {
    const fee = state.fees[exchange];
    if (!isRecord(fee) || !nonNegative(fee.takerRate)) {
      throw new Error(`Invalid engine state: ${exchange} fee configuration.`);
    }
  }
  validatePaperExecutionConfig(state.executionConfig as PaperExecutionConfig);
  validatePaperRiskConfig(state.riskConfig as PaperRiskConfig);
  new PaperRiskManager(state.riskConfig as PaperRiskConfig).restoreState(
    state.riskState,
  );
}
