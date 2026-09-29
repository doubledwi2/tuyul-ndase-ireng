import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';
import { Logger } from '../operations/logger.js';
const logger = new Logger('okx');

import type {
  NormalizedOrderBook,
  OrderBookConnection,
  OrderBookHandler,
} from '../types/orderbook.js';
import type { ExchangeStatusHandler } from '../types/market.js';
import {
  applyLevelUpdates,
  isRecord,
  normalizedBookFromMaps,
  parseLevelUpdates,
  sequence,
  timestamp,
} from './orderbook-state.js';

const URL = 'wss://ws.okx.com:8443/ws/v5/public';
export const OKX_ORDERBOOK_CHANNEL = 'books';
const INSTRUMENT = 'BTC-USDT';
const NORMALIZED_DEPTH = 50;
const RECONNECT_DELAY_MS = 3_000;
const IDLE_BEFORE_PING_MS = 20_000;
const PONG_TIMEOUT_MS = 5_000;
const HEARTBEAT_CHECK_MS = 1_000;

export interface OkxBookUpdateResult {
  orderBook: NormalizedOrderBook | null;
  sequenceGap: boolean;
}

export class OkxOrderBookState {
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();
  private initialized = false;
  private lastSequenceId: number | null = null;

  applyMessage(
    payload: string,
    receivedTimestamp: number,
    receivedMonotonicMs: number | null = null,
  ): OkxBookUpdateResult {
    const ignored: OkxBookUpdateResult = {
      orderBook: null,
      sequenceGap: false,
    };
    let message: unknown;
    try {
      message = JSON.parse(payload) as unknown;
    } catch {
      return ignored;
    }
    if (!isRecord(message)) {
      return ignored;
    }
    if (message.event === 'error') {
      const code = typeof message.code === 'string' ? message.code : 'unknown';
      const reason = typeof message.msg === 'string' ? message.msg : 'unknown reason';
      logger.error('subscription_rejected', reason, { code });
      return ignored;
    }
    if (
      !isRecord(message.arg) ||
      message.arg.channel !== OKX_ORDERBOOK_CHANNEL ||
      message.arg.instId !== INSTRUMENT ||
      (message.action !== 'snapshot' && message.action !== 'update') ||
      !Array.isArray(message.data) ||
      !isRecord(message.data[0])
    ) {
      return ignored;
    }
    const data = message.data[0];
    const bidUpdates = parseLevelUpdates(data.bids);
    const askUpdates = parseLevelUpdates(data.asks);
    const sequenceId = sequence(data.seqId);
    const previousSequenceId = sequence(data.prevSeqId);
    if (
      bidUpdates === null ||
      askUpdates === null ||
      sequenceId === null ||
      previousSequenceId === null
    ) {
      return ignored;
    }

    if (message.action === 'snapshot') {
      this.bids.clear();
      this.asks.clear();
      this.initialized = true;
    } else {
      if (!this.initialized || this.lastSequenceId === null) {
        return ignored;
      }
      if (previousSequenceId !== this.lastSequenceId) {
        this.bids.clear();
        this.asks.clear();
        this.initialized = false;
        this.lastSequenceId = null;
        return { orderBook: null, sequenceGap: true };
      }
    }

    applyLevelUpdates(this.bids, bidUpdates);
    applyLevelUpdates(this.asks, askUpdates);
    this.lastSequenceId = sequenceId;
    return {
      orderBook: normalizedBookFromMaps(
        'okx',
        this.bids,
        this.asks,
        NORMALIZED_DEPTH,
        timestamp(data.ts),
        null,
        receivedTimestamp,
        receivedMonotonicMs,
      ),
      sequenceGap: false,
    };
  }
}

export function connectOkx(
  onOrderBook: OrderBookHandler,
  onStatus?: ExchangeStatusHandler,
): OrderBookConnection {
  let socket: WebSocket | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let lastMessageAt = Date.now();
  let pingSentAt: number | null = null;
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
    logger.warn('reconnecting', 'Disconnected; reconnect scheduled.', { delayMs: RECONNECT_DELAY_MS });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  };
  const connect = (): void => {
    if (stopped) {
      return;
    }
    const state = new OkxOrderBookState();
    try {
      socket = new WebSocket(URL);
      socket.on('open', () => {
        logger.info('connected', 'Public WebSocket connected.');
        onStatus?.(true);
        lastMessageAt = Date.now();
        pingSentAt = null;
        socket?.send(
          JSON.stringify({
            op: 'subscribe',
            args: [{ channel: OKX_ORDERBOOK_CHANNEL, instId: INSTRUMENT }],
          }),
        );
        heartbeat = setInterval(() => {
          if (socket?.readyState !== WebSocket.OPEN) {
            return;
          }
          const now = Date.now();
          if (pingSentAt !== null && now - pingSentAt >= PONG_TIMEOUT_MS) {
            logger.warn('heartbeat_timeout', 'Heartbeat timed out; reconnecting.');
            socket.terminate();
            return;
          }
          if (pingSentAt === null && now - lastMessageAt >= IDLE_BEFORE_PING_MS) {
            socket.send('ping');
            pingSentAt = now;
          }
        }, HEARTBEAT_CHECK_MS);
      });
      socket.on('message', (data) => {
        const receivedTimestamp = Date.now();
        const receivedMonotonicMs = performance.now();
        lastMessageAt = receivedTimestamp;
        pingSentAt = null;
        const result = state.applyMessage(
          data.toString(),
          receivedTimestamp,
          receivedMonotonicMs,
        );
        if (result.sequenceGap) {
          logger.warn('sequence_gap', 'Order book sequence gap; reconnecting.');
          socket?.terminate();
        } else if (result.orderBook !== null) {
          onOrderBook(result.orderBook);
        }
      });
      socket.on('error', (error) => {
        logger.error('websocket_error', error.message);
      });
      socket.on('close', () => {
        onStatus?.(false);
        clearHeartbeat();
        socket = null;
        scheduleReconnect();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('connection_error', message);
      scheduleReconnect();
    }
  };
  connect();
  return {
    close: () => {
      stopped = true;
      onStatus?.(false);
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
