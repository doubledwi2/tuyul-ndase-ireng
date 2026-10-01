import { PrivateReadError, type Exchange } from './types.js';

export const PRIVATE_READ_TIMEOUT_MS = 3000;
export const PRIVATE_BALANCE_POLL_INTERVAL_MS = 10_000;
export const PRIVATE_CONFIG_POLL_INTERVAL_MS = 300_000;
export const PRIVATE_FEE_POLL_INTERVAL_MS = 300_000;
export const MAX_BALANCE_AGE_MS = 30_000;
export const MAX_DIAGNOSTIC_AGE_MS = 900_000;
export const PRIVATE_REQUEST_GAP_MS = 500;
export const MAX_FEE_DELTA = 0.0002;
export const PRIVATE_READ_RETRY_DELAY_MS = 500;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const READ_PATHS = Object.freeze({
  BYBIT_BALANCE: '/v5/account/wallet-balance?accountType=UNIFIED&coin=BTC,USDT',
  BYBIT_FEE_RATE: '/v5/account/fee-rate?category=spot&symbol=BTCUSDT',
  BYBIT_ACCOUNT_INFO: '/v5/account/info',
  BYBIT_API_KEY_INFO: '/v5/user/query-api',
  OKX_BALANCE: '/api/v5/account/balance?ccy=BTC,USDT',
  OKX_ACCOUNT_CONFIG: '/api/v5/account/config',
  OKX_TRADE_FEE: '/api/v5/account/trade-fee?instType=SPOT&instId=BTC-USDT',
});
export type RequestKind = keyof typeof READ_PATHS;
export type BybitRequestKind = Extract<RequestKind, `BYBIT_${string}`>;
export type OkxRequestKind = Extract<RequestKind, `OKX_${string}`>;
export const BALANCE_PATHS = Object.freeze({ bybit: READ_PATHS.BYBIT_BALANCE, okx: READ_PATHS.OKX_BALANCE });
export function requestExchange(kind: RequestKind): Exchange {
  if (!Object.hasOwn(READ_PATHS, kind)) throw new PrivateReadError('CONFIG');
  return kind.startsWith('BYBIT_') ? 'bybit' : 'okx';
}
export function balanceKind(exchange: Exchange): RequestKind { return exchange === 'bybit' ? 'BYBIT_BALANCE' : 'OKX_BALANCE'; }
export function pollInterval(kind: RequestKind): number {
  return kind.endsWith('BALANCE') ? PRIVATE_BALANCE_POLL_INTERVAL_MS : kind.includes('FEE') ? PRIVATE_FEE_POLL_INTERVAL_MS : PRIVATE_CONFIG_POLL_INTERVAL_MS;
}
export function requestUrl(kind: RequestKind, balance: string): string {
  const exchange = requestExchange(kind);
  validateBalanceUrl(exchange, balance);
  return balance.slice(0, -BALANCE_PATHS[exchange].length) + READ_PATHS[kind];
}
export function validateReadUrl(exchange: Exchange, kind: RequestKind, url: string): void {
  if (requestExchange(kind) !== exchange || !HOSTS[exchange].some(host => url === `https://${host}${READ_PATHS[kind]}`)) throw new PrivateReadError('CONFIG');
}
export const HOSTS = Object.freeze({
  bybit: Object.freeze(['api.bybit.com', 'api.bytick.com', 'api-testnet.bybit.com']),
  okx: Object.freeze(['openapi.okx.com', 'www.okx.com', 'us.okx.com', 'eea.okx.com', 'tr.okx.com']),
});
export function balanceUrl(exchange: Exchange, base: string): string {
  // Exact spelling disallows userinfo, ports (even :443), encoded/dot paths,
  // whitespace, fragments and URL-parser normalization surprises.
  if (!HOSTS[exchange].some(host => base === `https://${host}` || base === `https://${host}/`)) {
    throw new PrivateReadError('CONFIG');
  }
  return base.replace(/\/$/, '') + BALANCE_PATHS[exchange];
}
export function validateBalanceUrl(exchange: Exchange, url: string): void {
  if (!HOSTS[exchange].some(host => url === `https://${host}${BALANCE_PATHS[exchange]}`)) throw new PrivateReadError('CONFIG');
}
export function privateReadConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.SHADOW_MODE_ENABLED !== undefined && !['true', 'false'].includes(env.SHADOW_MODE_ENABLED)) throw new PrivateReadError('CONFIG');
  if (env.SHADOW_MODE_ENABLED === 'true' && env.PRIVATE_READ_ENABLED !== 'true') throw new PrivateReadError('CONFIG');
  if (env.ACCOUNT_FEE_MODE !== undefined && env.ACCOUNT_FEE_MODE !== 'diagnostic') throw new PrivateReadError('CONFIG');
  if (env.PRIVATE_READ_ENABLED !== undefined && !['true', 'false'].includes(env.PRIVATE_READ_ENABLED)) throw new PrivateReadError('CONFIG');
  return Object.freeze({
    enabled: env.PRIVATE_READ_ENABLED === 'true',
    bybitUrl: balanceUrl('bybit', env.BYBIT_API_BASE_URL ?? 'https://api.bybit.com'),
    okxUrl: balanceUrl('okx', env.OKX_API_BASE_URL ?? 'https://openapi.okx.com'),
  });
}
