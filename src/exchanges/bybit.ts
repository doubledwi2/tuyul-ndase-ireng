import WebSocket from 'ws';

import {
  isValidBestQuote,
  type BestQuote,
  type ExchangeConnection,
  type QuoteHandler,
} from '../types/market.js';

const URL = 'wss://stream.bybit.com/v5/public/spot';
const TOPIC = 'orderbook.1.BTCUSDT';
const RECONNECT_DELAY_MS = 3_000;
const HEARTBEAT_INTERVAL_MS = 20_000;

interface BybitOrderbookMessage {
  topic: string;
  ts?: unknown;
  cts?: unknown;
  data: {
    s: string;
    b: unknown;
    a: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOrderbookMessage(value: unknown): value is BybitOrderbookMessage {
  if (!isRecord(value) || value.topic !== TOPIC || !isRecord(value.data)) {
    return false;
  }

  return value.data.s === 'BTCUSDT';
}

interface PriceLevel {
  price: number;
  size: number;
}

function firstLevel(levels: unknown): PriceLevel | null {
  if (!Array.isArray(levels) || !Array.isArray(levels[0])) {
    return null;
  }

  const priceValue = levels[0][0];
  const sizeValue = levels[0][1];
  if (
    (typeof priceValue !== 'string' && typeof priceValue !== 'number') ||
    (typeof sizeValue !== 'string' && typeof sizeValue !== 'number')
  ) {
    return null;
  }

  return {
    price: Number(priceValue),
    size: Number(sizeValue),
  };
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseBybitMessage(
  payload: string,
  receivedTimestamp: number,
): BestQuote | null {
  let message: unknown;

  try {
    message = JSON.parse(payload);
  } catch {
    return null;
  }

  if (
    isRecord(message) &&
    message.op === 'subscribe' &&
    message.success === false
  ) {
    const reason = typeof message.ret_msg === 'string' ? message.ret_msg : 'unknown reason';
    console.error(`[BYBIT] Subscription rejected: ${reason}`);
    return null;
  }

  if (!isOrderbookMessage(message)) {
    return null;
  }

  const bid = firstLevel(message.data.b);
  const ask = firstLevel(message.data.a);
  if (bid === null || ask === null) {
    return null;
  }

  const quote: BestQuote = {
    exchange: 'bybit',
    symbol: 'BTC/USDT',
    bid: bid.price,
    bidSize: bid.size,
    ask: ask.price,
    askSize: ask.size,
    exchangeTimestamp: timestamp(message.ts),
    matchingEngineTimestamp: timestamp(message.cts),
    receivedTimestamp,
  };

  return isValidBestQuote(quote) ? quote : null;
}

export function connectBybit(onQuote: QuoteHandler): ExchangeConnection {
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

    try {
      socket = new WebSocket(URL);

      socket.on('open', () => {
        console.log('[BYBIT] Connected');
        socket?.send(JSON.stringify({ op: 'subscribe', args: [TOPIC] }));
        heartbeat = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ op: 'ping' }));
          }
        }, HEARTBEAT_INTERVAL_MS);
      });

      socket.on('message', (data) => {
        const receivedTimestamp = Date.now();
        const quote = parseBybitMessage(data.toString(), receivedTimestamp);
        if (quote !== null) {
          onQuote(quote);
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
