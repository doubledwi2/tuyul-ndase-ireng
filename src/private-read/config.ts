import { PrivateReadError, type Exchange } from './types.js';

export const PRIVATE_READ_TIMEOUT_MS = 3000;
export const PRIVATE_BALANCE_POLL_INTERVAL_MS = 10_000;
export const PRIVATE_READ_RETRY_DELAY_MS = 500;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const BALANCE_PATHS = Object.freeze({
  bybit: '/v5/account/wallet-balance?accountType=UNIFIED&coin=BTC,USDT',
  okx: '/api/v5/account/balance?ccy=BTC,USDT',
});
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
  if (env.PRIVATE_READ_ENABLED !== undefined && !['true', 'false'].includes(env.PRIVATE_READ_ENABLED)) throw new PrivateReadError('CONFIG');
  return Object.freeze({
    enabled: env.PRIVATE_READ_ENABLED === 'true',
    bybitUrl: balanceUrl('bybit', env.BYBIT_API_BASE_URL ?? 'https://api.bybit.com'),
    okxUrl: balanceUrl('okx', env.OKX_API_BASE_URL ?? 'https://openapi.okx.com'),
  });
}
