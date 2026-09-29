import { randomUUID } from 'node:crypto';
import type { Exchange } from './capabilities.js';

export interface OrderRequest {
  readonly clientOrderId: string;
  readonly exchange: Exchange;
  readonly symbol: 'BTC/USDT';
  readonly side: 'BUY' | 'SELL';
  readonly type: 'MARKET' | 'LIMIT';
  readonly quantity: number;
  readonly limitPrice?: number;
}
export interface OrderIntent {
  readonly intentId: string;
  readonly tradeId: string;
  readonly exchange: Exchange;
  readonly side: 'BUY' | 'SELL';
  readonly symbol: 'BTC/USDT';
  readonly quantity: number;
  readonly createdAt: number;
}
export function validClientOrderId(id: string): boolean { return /^tni[0-9a-f]{28}$/.test(id); }
export function createClientOrderId(): string { return `tni${randomUUID().replaceAll('-', '').slice(0, 28)}`; }
export function createOrderIntent(request: OrderRequest, tradeId: string, createdAt: number, intentId = createClientOrderId()): Readonly<OrderIntent> {
  if (!validClientOrderId(request.clientOrderId) || !validClientOrderId(intentId) || !tradeId ||
      !['bybit', 'okx'].includes(request.exchange) || request.symbol !== 'BTC/USDT' ||
      !['BUY', 'SELL'].includes(request.side) || !['MARKET', 'LIMIT'].includes(request.type) ||
      !Number.isFinite(request.quantity) || request.quantity <= 0 ||
      !Number.isFinite(createdAt) || createdAt < 0 ||
      (request.type === 'LIMIT' && (!Number.isFinite(request.limitPrice) || request.limitPrice! <= 0)) ||
      (request.type === 'MARKET' && request.limitPrice !== undefined)) throw new Error('Invalid local order intent.');
  return Object.freeze({ intentId, tradeId, exchange: request.exchange, side: request.side,
    symbol: request.symbol, quantity: request.quantity, createdAt });
}
