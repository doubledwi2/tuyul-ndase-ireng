import { PrivateReadError, type PrivateAccountSnapshot } from './types.js';

function invalid(): never { throw new PrivateReadError('SCHEMA'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function single(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) return invalid();
  return object(value[0]);
}
function amount(value: unknown, coin: 'BTC' | 'USDT'): number {
  if (typeof value !== 'string' || value.length > 64 || !/^\d+(?:\.\d+)?$/.test(value)) return invalid();
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > (coin === 'BTC' ? 21_000_000 : 1_000_000_000_000)) return invalid();
  if (n === 0 && /[1-9]/.test(value)) return invalid();
  return n;
}
function timestamp(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return invalid();
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= 8.64e15 ? n : invalid();
}
function localTime(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15 ? value : invalid();
}
function currencies(rows: unknown, label: string, total: string, available?: string) {
  if (!Array.isArray(rows)) return invalid();
  const selected = new Map<string, { total: number; available: number | null }>();
  for (const entry of rows) {
    const row = object(entry);
    const coin = row[label];
    if (typeof coin !== 'string') return invalid();
    if (coin !== 'BTC' && coin !== 'USDT') continue;
    if (selected.has(coin)) return invalid();
    const a = available === undefined ? null : row[available];
    selected.set(coin, { total: amount(row[total], coin), available: a === null || a === undefined || a === '' ? null : amount(a, coin) });
  }
  const btc = selected.get('BTC'); const usdt = selected.get('USDT');
  // Absence is deliberately not interpreted as a zero holding.
  if (!btc || !usdt) return invalid();
  return { btc, usdt };
}
export function parseBybitBalanceResponse(value: unknown, receivedAt: number): PrivateAccountSnapshot {
  const root = object(value);
  if (root.retCode !== 0) throw new PrivateReadError(root.retCode === 10006 ? 'RATE_LIMIT' : 'EXCHANGE');
  const account = single(object(root.result).list);
  if (account.accountType !== 'UNIFIED') return invalid();
  return { exchange: 'bybit', receivedAt: localTime(receivedAt), sourceUpdatedAt: null,
    rawAccountType: 'UNIFIED', ...currencies(account.coin, 'coin', 'walletBalance') };
  // Bybit envelope time is response/server time, NOT a balance update time.
  // UNIFIED availableToWithdraw is deprecated; do not infer availability.
}
export function parseOkxBalanceResponse(value: unknown, receivedAt: number): PrivateAccountSnapshot {
  const root = object(value);
  if (root.code !== '0') throw new PrivateReadError(root.code === '50011' ? 'RATE_LIMIT' : 'EXCHANGE');
  const account = single(root.data);
  return { exchange: 'okx', receivedAt: localTime(receivedAt), sourceUpdatedAt: timestamp(account.uTime),
    ...currencies(account.details, 'ccy', 'cashBal', 'availBal') };
}
