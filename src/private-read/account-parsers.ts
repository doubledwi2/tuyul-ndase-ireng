import { isIP } from 'node:net';
import { PrivateReadError } from './types.js';
import type { AccountFeeSnapshot, BybitAccountConfig, BybitApiKeySafety, CredentialSafetyReason, FeeRate, OkxAccountConfig, OkxApiKeySafety, ReadResults } from './account-types.js';
import type { RequestKind } from './config.js';
import { parseBybitBalanceResponse, parseOkxBalanceResponse } from './parsers.js';

function invalid(): never { throw new PrivateReadError('SCHEMA'); }
function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function one(value: unknown): Record<string, unknown> { return Array.isArray(value) && value.length === 1 ? obj(value[0]) : invalid(); }
function bybit(value: unknown) {
  const root = obj(value);
  if (typeof root.retCode !== 'number') return invalid();
  if (root.retCode !== 0) throw new PrivateReadError(root.retCode === 10006 ? 'RATE_LIMIT' : 'EXCHANGE');
  return obj(root.result);
}
function okx(value: unknown) {
  const root = obj(value);
  if (typeof root.code !== 'string') return invalid();
  if (root.code !== '0') throw new PrivateReadError(root.code === '50011' ? 'RATE_LIMIT' : 'EXCHANGE');
  return one(root.data);
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : invalid();
}
function optionalBool(value: unknown): boolean | null { return value === undefined ? null : typeof value === 'boolean' ? value : invalid(); }
function timestamp(value: unknown): number | null {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return invalid();
  const n = Number(value); return Number.isSafeInteger(n) && n > 0 && n <= 8.64e15 ? n : invalid();
}
function localTime(n: number): number { return Number.isSafeInteger(n) && n >= 0 && n <= 8.64e15 ? n : invalid(); }
function ipBound(value: unknown, array: boolean): boolean | null {
  if (value === undefined) return null;
  const entries: unknown = array ? value : typeof value === 'string' ? value.split(',').filter(Boolean) : invalid();
  if (!Array.isArray(entries) || entries.some(x => typeof x !== 'string' || (x !== '*' && isIP(x.trim()) === 0))) return invalid();
  return entries.length > 0 && !entries.includes('*');
}
function rate(value: unknown): number {
  if (typeof value !== 'string' || value.length > 32 || !/^-?\d+(?:\.\d+)?$/.test(value)) return invalid();
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= 0.05 ? n : invalid();
}
export function normalizeOkxFeeRate(value: unknown): FeeRate {
  const n = rate(value);
  // Negative commission -> positive cost. Positive rebate -> negative cost.
  return { rawRate: value as string, normalizedCostRate: n === 0 ? 0 : -n };
}
export function parseBybitFeeResponse(value: unknown, receivedAt: number): AccountFeeSnapshot {
  const result = bybit(value); if (result.category !== 'spot') return invalid();
  const row = one(result.list); if (row.symbol !== 'BTCUSDT') return invalid();
  const normalize = (v: unknown): FeeRate => {
    const n = rate(v); if (n < 0) return invalid();
    return { rawRate: v as string, normalizedCostRate: n === 0 ? 0 : n };
  };
  return { exchange: 'bybit', symbol: 'BTC/USDT', source: 'ACCOUNT_PRIVATE_READ', receivedAt: localTime(receivedAt),
    sourceUpdatedAt: null, makerFeeRate: normalize(row.makerFeeRate), takerFeeRate: normalize(row.takerFeeRate) };
}
export function parseOkxFeeResponse(value: unknown, receivedAt: number): AccountFeeSnapshot {
  const row = okx(value); if (row.instType !== 'SPOT') return invalid();
  // Our fixed instId query must return exactly one applicable group. No guessing
  // group IDs or relying on deprecated top-level maker/taker fields.
  const group = one(row.feeGroup);
  if (typeof group.groupId !== 'string' || !/^\d{1,8}$/.test(group.groupId)) return invalid();
  if (row.instId !== undefined && row.instId !== 'BTC-USDT') return invalid();
  return { exchange: 'okx', symbol: 'BTC/USDT', source: 'ACCOUNT_PRIVATE_READ', receivedAt: localTime(receivedAt),
    sourceUpdatedAt: null, makerFeeRate: normalizeOkxFeeRate(group.maker), takerFeeRate: normalizeOkxFeeRate(group.taker) };
  // ts is data return time, not a documented fee update timestamp.
}
export function parseBybitAccountInfo(value: unknown): BybitAccountConfig {
  const row = bybit(value);
  if (typeof row.unifiedMarginStatus !== 'number' || ![1, 3, 4, 5, 6].includes(row.unifiedMarginStatus)) return invalid();
  return { unifiedMarginStatus: row.unifiedMarginStatus,
    marginMode: enumValue(row.marginMode, ['REGULAR_MARGIN', 'ISOLATED_MARGIN', 'PORTFOLIO_MARGIN']),
    spotHedgingStatus: enumValue(row.spotHedgingStatus, ['ON', 'OFF']), updatedTime: timestamp(row.updatedTime) };
}
const PERMISSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Spot: ['SpotTrade'], Wallet: ['AccountTransfer', 'SubMemberTransfer', 'SubMemberTransferList', 'Withdraw'],
  ContractTrade: ['Order', 'Position'], Options: ['OptionsTrade'], Derivatives: ['DerivativesTrade'],
  Exchange: ['ExchangeHistory'], Earn: ['Earn'], FiatP2P: ['FiatP2POrder', 'Advertising'],
  FiatBitPay: ['FaitPayOrder'], FiatConvertBroker: ['FiatConvertBrokerOrder'], BitCard: ['BitCard'], ByXPost: ['ByXPost'],
  Affiliate: [], BlockTrade: [], NFT: [], CopyTrading: [],
});
export function parseBybitApiKeyInfo(value: unknown, checkedAt: number): BybitApiKeySafety {
  const row = bybit(value);
  if (row.readOnly !== 0 && row.readOnly !== 1) return invalid();
  const permissions = obj(row.permissions);
  if (!Array.isArray(permissions.Spot) || !Array.isArray(permissions.Wallet)) return invalid();
  const all = new Set<string>(); let otherWrite = false;
  for (const [name, values] of Object.entries(permissions)) {
    if (!Object.hasOwn(PERMISSIONS, name) || !Array.isArray(values)) return invalid();
    for (const v of values) {
      if (typeof v !== 'string' || !PERMISSIONS[name]!.includes(v)) return invalid();
      all.add(v);
      if (!['Spot', 'Wallet', 'Exchange'].includes(name)) otherWrite = true;
    }
  }
  const readOnly = row.readOnly === 1;
  const hasSpotTradePermission = all.has('SpotTrade');
  const hasWalletTransferPermission = ['AccountTransfer', 'SubMemberTransfer', 'SubMemberTransferList'].some(p => all.has(p));
  const hasWithdrawPermission = all.has('Withdraw');
  const reasons: CredentialSafetyReason[] = [];
  if (!readOnly) reasons.push('BYBIT_KEY_NOT_READ_ONLY');
  if (hasSpotTradePermission) reasons.push('BYBIT_SPOT_TRADE_PERMISSION_PRESENT');
  if (hasWalletTransferPermission) reasons.push('BYBIT_TRANSFER_PERMISSION_PRESENT');
  if (hasWithdrawPermission) reasons.push('BYBIT_WITHDRAW_PERMISSION_PRESENT');
  if (otherWrite) reasons.push('BYBIT_OTHER_WRITE_PERMISSION_PRESENT');
  return { readOnly, hasSpotTradePermission, hasWalletTransferPermission, hasWithdrawPermission, ipBound: ipBound(row.ips, true),
    assessment: { exchange: 'bybit', status: reasons.length ? 'UNSAFE_WRITE_ENABLED' : 'SAFE_READ_ONLY', reasons, checkedAt: localTime(checkedAt) } };
}
export function parseOkxAccountConfig(value: unknown, checkedAt: number): { config: OkxAccountConfig; safety: OkxApiKeySafety } {
  const row = okx(value);
  if (typeof row.perm !== 'string') return invalid();
  const perms = row.perm.split(',').map(s => s.trim());
  if (!perms.length || perms.some(p => !['read_only', 'trade', 'withdraw'].includes(p)) || new Set(perms).size !== perms.length) return invalid();
  const readPermission = perms.includes('read_only'), tradePermission = perms.includes('trade'), withdrawPermission = perms.includes('withdraw');
  const reasons: CredentialSafetyReason[] = [];
  if (!readPermission) reasons.push('OKX_READ_PERMISSION_MISSING');
  if (tradePermission) reasons.push('OKX_TRADE_PERMISSION_PRESENT');
  if (withdrawPermission) reasons.push('OKX_WITHDRAW_PERMISSION_PRESENT');
  return { config: { accountLevel: enumValue(row.acctLv, ['1', '2', '3', '4']),
    positionMode: enumValue(row.posMode, ['net_mode', 'long_short_mode']), autoBorrowEnabled: optionalBool(row.autoLoan), spotBorrowEnabled: optionalBool(row.enableSpotBorrow) },
    safety: { readPermission, tradePermission, withdrawPermission, ipBound: ipBound(row.ip, false), assessment: {
      exchange: 'okx', status: tradePermission || withdrawPermission ? 'UNSAFE_WRITE_ENABLED' : readPermission ? 'SAFE_READ_ONLY' : 'UNKNOWN',
      reasons, checkedAt: localTime(checkedAt),
    } } };
}
export function parseReadResponse<K extends RequestKind>(kind: K, value: unknown, at: number): ReadResults[K] {
  const parsers: { [P in RequestKind]: (value: unknown, at: number) => ReadResults[P] } = {
    BYBIT_BALANCE: parseBybitBalanceResponse, OKX_BALANCE: parseOkxBalanceResponse,
    BYBIT_FEE_RATE: parseBybitFeeResponse, OKX_TRADE_FEE: parseOkxFeeResponse,
    BYBIT_ACCOUNT_INFO: parseBybitAccountInfo, BYBIT_API_KEY_INFO: parseBybitApiKeyInfo, OKX_ACCOUNT_CONFIG: parseOkxAccountConfig,
  };
  return parsers[kind](value, at);
}
