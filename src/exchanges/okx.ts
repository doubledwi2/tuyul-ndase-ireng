import WebSocket, { type RawData } from 'ws';

import type { BestQuote, ExchangeConnection, QuoteHandler } from '../types/market.js';

const URL = 'wss://ws.okx.com:8443/ws/v5/public';
const CHANNEL = 'tickers';
const INSTRUMENT = 'BTC-USDT';
const RECONNECT_DELAY_MS = 3_000;
const IDLE_BEFORE_PING_MS = 20_000;
const HEARTBEAT_CHECK_MS = 5_000;

interface OkxTickerMessage {
  arg: {
    channel: string;
    instId: string;
  };
  data: Array<{
    instId: string;
    bidPx: unknown;
    askPx: unknown;
    ts?: unknown;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTickerMessage(value: unknown): value is OkxTickerMessage {
  if (!isRecord(value) || !isRecord(value.arg) || !Array.isArray(value.data)) {
    return false;
  }

  return value.arg.channel === CHANNEL && value.arg.instId === INSTRUMENT;
}

function positiveNumber(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseQuote(data: RawData, receivedTimestamp: number): BestQuote | null {
  let message: unknown;

  try {
    message = JSON.parse(data.toString());
  } catch {
    return null;
  }

  if (isRecord(message) && message.event === 'error') {
    const code = typeof message.code === 'string' ? message.code : 'unknown';
    const reason = typeof message.msg === 'string' ? message.msg : 'unknown reason';
    console.error(`[OKX] Subscription error ${code}: ${reason}`);
    return null;
  }

  if (!isTickerMessage(message) || !isRecord(message.data[0])) {
    return null;
  }

  const ticker = message.data[0];
  if (ticker.instId !== INSTRUMENT) {
    return null;
  }

  const bid = positiveNumber(ticker.bidPx);
  const ask = positiveNumber(ticker.askPx);
  if (bid === null || ask === null) {
    return null;
  }

  return {
    exchange: 'okx',
    symbol: 'BTC/USDT',
    bid,
    ask,
    exchangeTimestamp: positiveNumber(ticker.ts),
    receivedTimestamp,
  };
}

export function connectOkx(onQuote: QuoteHandler): ExchangeConnection {
  let socket: WebSocket | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let lastMessageAt = Date.now();
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
        socket?.send(
          JSON.stringify({
            op: 'subscribe',
            args: [{ channel: CHANNEL, instId: INSTRUMENT }],
          }),
        );
        heartbeat = setInterval(() => {
          if (
            socket?.readyState === WebSocket.OPEN &&
            Date.now() - lastMessageAt >= IDLE_BEFORE_PING_MS
          ) {
            socket.send('ping');
          }
        }, HEARTBEAT_CHECK_MS);
      });

      socket.on('message', (data) => {
        const receivedTimestamp = Date.now();
        lastMessageAt = receivedTimestamp;
        const quote = parseQuote(data, receivedTimestamp);
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
