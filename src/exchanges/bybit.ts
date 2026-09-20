import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';

import type {
  NormalizedOrderBook,
  OrderBookConnection,
  OrderBookHandler,
} from '../types/orderbook.js';
import {
  applyLevelUpdates,
  isRecord,
  normalizedBookFromMaps,
  parseLevelUpdates,
  sequence,
  timestamp,
} from './orderbook-state.js';

const URL = 'wss://stream.bybit.com/v5/public/spot';
export const BYBIT_ORDERBOOK_TOPIC = 'orderbook.50.BTCUSDT';
const BOOK_DEPTH = 50;
const RECONNECT_DELAY_MS = 3_000;
const HEARTBEAT_INTERVAL_MS = 20_000;

export class BybitOrderBookState {
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();
  private initialized = false;

  applyMessage(
    payload: string,
    receivedTimestamp: number,
    receivedMonotonicMs: number | null = null,
  ): NormalizedOrderBook | null {
    let message: unknown;
    try {
      message = JSON.parse(payload) as unknown;
    } catch {
      return null;
    }
    if (!isRecord(message)) {
      return null;
    }
    if (message.op === 'subscribe' && message.success === false) {
      const reason =
        typeof message.ret_msg === 'string' ? message.ret_msg : 'unknown reason';
      console.error(`[BYBIT] Subscription rejected: ${reason}`);
      return null;
    }
    if (
      message.topic !== BYBIT_ORDERBOOK_TOPIC ||
      (message.type !== 'snapshot' && message.type !== 'delta') ||
      !isRecord(message.data) ||
      message.data.s !== 'BTCUSDT'
    ) {
      return null;
    }
    const bidUpdates = parseLevelUpdates(message.data.b);
    const askUpdates = parseLevelUpdates(message.data.a);
    if (bidUpdates === null || askUpdates === null) {
      return null;
    }
    const updateId = sequence(message.data.u);
    const replaceBook = message.type === 'snapshot' || updateId === 1;
    if (replaceBook) {
      this.bids.clear();
      this.asks.clear();
      this.initialized = true;
    } else if (!this.initialized) {
      return null;
    }
    applyLevelUpdates(this.bids, bidUpdates);
    applyLevelUpdates(this.asks, askUpdates);
    return normalizedBookFromMaps(
      'bybit',
      this.bids,
      this.asks,
      BOOK_DEPTH,
      timestamp(message.ts),
      timestamp(message.cts),
      receivedTimestamp,
      receivedMonotonicMs,
    );
  }
}

export function connectBybit(onOrderBook: OrderBookHandler): OrderBookConnection {
  let socket: WebSocket | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const clearHeartbeat = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };
  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    console.error(`[BYBIT] Disconnected; reconnecting in ${RECONNECT_DELAY_MS / 1_000}s`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  };
  const connect = (): void => {
    if (stopped) {
      return;
    }
    const state = new BybitOrderBookState();
    try {
      socket = new WebSocket(URL);
      socket.on('open', () => {
        console.log('[BYBIT] Connected');
        socket?.send(
          JSON.stringify({ op: 'subscribe', args: [BYBIT_ORDERBOOK_TOPIC] }),
        );
        heartbeat = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ op: 'ping' }));
          }
        }, HEARTBEAT_INTERVAL_MS);
      });
      socket.on('message', (data) => {
        const receivedTimestamp = Date.now();
        const receivedMonotonicMs = performance.now();
        const orderBook = state.applyMessage(
          data.toString(),
          receivedTimestamp,
          receivedMonotonicMs,
        );
        if (orderBook !== null) {
          onOrderBook(orderBook);
        }
      });
      socket.on('error', (error) => {
        console.error(`[BYBIT] WebSocket error: ${error.message}`);
      });
      socket.on('close', () => {
        clearHeartbeat();
        socket = null;
        scheduleReconnect();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[BYBIT] Connection error: ${message}`);
      scheduleReconnect();
    }
  };
  connect();
  return {
    close: () => {
      stopped = true;
      clearHeartbeat();
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket?.readyState === WebSocket.OPEN) {
        socket.close(1000, 'Application shutting down');
      } else if (socket?.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    },
  };
}
