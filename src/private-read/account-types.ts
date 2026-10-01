import type { Exchange, PrivateAccountSnapshot } from './types.js';

export type CredentialSafetyReason = 'BYBIT_KEY_NOT_READ_ONLY' | 'BYBIT_SPOT_TRADE_PERMISSION_PRESENT' |
  'BYBIT_TRANSFER_PERMISSION_PRESENT' | 'BYBIT_WITHDRAW_PERMISSION_PRESENT' | 'BYBIT_OTHER_WRITE_PERMISSION_PRESENT' |
  'OKX_TRADE_PERMISSION_PRESENT' | 'OKX_WITHDRAW_PERMISSION_PRESENT' | 'OKX_READ_PERMISSION_MISSING' | 'PERMISSION_UNAVAILABLE';
export interface CredentialSafetyAssessment {
  exchange: Exchange; status: 'SAFE_READ_ONLY' | 'UNSAFE_WRITE_ENABLED' | 'UNKNOWN';
  reasons: CredentialSafetyReason[]; checkedAt: number | null;
}
export interface BybitApiKeySafety {
  readOnly: boolean; hasSpotTradePermission: boolean; hasWalletTransferPermission: boolean;
  hasWithdrawPermission: boolean; ipBound: boolean | null;
  assessment: CredentialSafetyAssessment;
}
export interface OkxApiKeySafety {
  readPermission: boolean; tradePermission: boolean; withdrawPermission: boolean; ipBound: boolean | null;
  assessment: CredentialSafetyAssessment;
}
export interface BybitAccountConfig {
  unifiedMarginStatus: number; marginMode: 'REGULAR_MARGIN' | 'ISOLATED_MARGIN' | 'PORTFOLIO_MARGIN';
  spotHedgingStatus: 'ON' | 'OFF'; updatedTime: number | null;
}
export interface OkxAccountConfig {
  accountLevel: '1' | '2' | '3' | '4'; positionMode: 'net_mode' | 'long_short_mode';
  autoBorrowEnabled: boolean | null; spotBorrowEnabled: boolean | null;
}
export interface AccountCompatibilityAssessment {
  exchange: Exchange; status: 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNKNOWN'; reasons: string[];
}
export interface FeeRate { rawRate: string; normalizedCostRate: number }
export interface AccountFeeSnapshot {
  exchange: Exchange; symbol: 'BTC/USDT'; source: 'ACCOUNT_PRIVATE_READ';
  makerFeeRate: FeeRate; takerFeeRate: FeeRate; receivedAt: number; sourceUpdatedAt: number | null;
}
export interface ReadResults {
  BYBIT_BALANCE: PrivateAccountSnapshot;
  BYBIT_FEE_RATE: AccountFeeSnapshot;
  BYBIT_ACCOUNT_INFO: BybitAccountConfig;
  BYBIT_API_KEY_INFO: BybitApiKeySafety;
  OKX_BALANCE: PrivateAccountSnapshot;
  OKX_ACCOUNT_CONFIG: { config: OkxAccountConfig; safety: OkxApiKeySafety };
  OKX_TRADE_FEE: AccountFeeSnapshot;
}
export type AccountReadResult = ReadResults[keyof ReadResults];
