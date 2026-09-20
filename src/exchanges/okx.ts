import WebSocket from 'ws';

import {
  isValidBestQuote,
  type BestQuote,
  type ExchangeConnection,
  type QuoteHandler,
} from '../types/market.js';

const URL = 'wss://ws.okx.com:8443/ws/v5/public';
const CHANNEL = 'bbo-tbt';
const INSTRUMENT = 'BTC-USDT';
const RECONNECT_DELAY_MS = 3_000;
const IDLE_BEFORE_PING_MS = 20_000;
const PONG_TIMEOUT_MS = 5_000;
const HEARTBEAT_CHECK_MS = 1_000;

interface OkxBboMessage {
  arg: {
    channel: string;
    instId: string;
  };
  data: Array<{
    bids: unknown;
    asks: unknown;
    ts?: unknown;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBboMessage(value: unknown): value is OkxBboMessage {
  if (!isRecord(value) || !isRecord(value.arg) || !Array.isArray(value.data)) {
    return false;
  }

  return value.arg.channel === CHANNEL && value.arg.instId === INSTRUMENT;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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

export function parseOkxMessage(
  payload: string,
  receivedTimestamp: number,
): BestQuote | null {
  let message: unknown;

  try {
    message = JSON.parse(payload);
  } catch {
    return null;
  }

  if (isRecord(message) && message.event === 'error') {
    const code = typeof message.code === 'string' ? message.code : 'unknown';
    const reason = typeof message.msg === 'string' ? message.msg : 'unknown reason';
    console.error(`[OKX] Subscription error ${code}: ${reason}`);
    return null;
  }

  if (!isBboMessage(message) || !isRecord(message.data[0])) {
    return null;
  }

  const book = message.data[0];
  const bid = firstLevel(book.bids);
  const ask = firstLevel(book.asks);
  if (bid === null || ask === null) {
    return null;
  }

  const bookTimestamp = timestamp(book.ts);

  const quote: BestQuote = {
    exchange: 'okx',
    symbol: 'BTC/USDT',
    bid: bid.price,
    bidSize: bid.size,
    ask: ask.price,
    askSize: ask.size,
    exchangeTimestamp: bookTimestamp,
    matchingEngineTimestamp: bookTimestamp,
    receivedTimestamp,
  };

  return isValidBestQuote(quote) ? quote : null;
}

export function connectOkx(onQuote: QuoteHandler): ExchangeConnection {
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

    console.error(`[OKX] Disconnected; reconnecting in ${RECONNECT_DELAY_MS / 1_000}s`);
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
        console.log('[OKX] Connected');
        lastMessageAt = Date.now();
        pingSentAt = null;
        socket?.send(
          JSON.stringify({
            op: 'subscribe',
            args: [{ channel: CHANNEL, instId: INSTRUMENT }],
          }),
        );
        heartbeat = setInterval(() => {
          if (socket?.readyState !== WebSocket.OPEN) {
            return;
          }

          const now = Date.now();
          if (pingSentAt !== null && now - pingSentAt >= PONG_TIMEOUT_MS) {
            console.error('[OKX] Heartbeat timed out; reconnecting');
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
        lastMessageAt = receivedTimestamp;
        pingSentAt = null;
        const quote = parseOkxMessage(data.toString(), receivedTimestamp);
        if (quote !== null) {
          onQuote(quote);
        }
      });

      socket.on('error', (error) => {
        console.error(`[OKX] WebSocket error: ${error.message}`);
      });

      socket.on('close', () => {
        clearHeartbeat();
        socket = null;
        scheduleReconnect();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[OKX] Connection error: ${message}`);
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
