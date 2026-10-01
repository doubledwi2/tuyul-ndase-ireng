import type { RequestKind } from './config.js';
// Synthetic offline fixtures, never an exchange response captured from an account.
export function bybitFixture() {
  return { retCode: 0, time: 1700000000000, result: { list: [{ accountType: 'UNIFIED', coin: [
    { coin: 'BTC', walletBalance: '1.25', availableToWithdraw: '1' },
    { coin: 'USDT', walletBalance: '2500' },
  ] }] } };
}
export function bybitInfoFixture() { return { retCode: 0, result: { unifiedMarginStatus: 5, marginMode: 'REGULAR_MARGIN', spotHedgingStatus: 'OFF', updatedTime: '1700000000000' } }; }
export function bybitPermissionFixture() { return { retCode: 0, result: { readOnly: 1, permissions: { Spot: [] as string[], Wallet: [] as string[] }, ips: [] as string[] } }; }
export function bybitFeeFixture() { return { retCode: 0, result: { category: 'spot', list: [{ symbol: 'BTCUSDT', makerFeeRate: '0.001', takerFeeRate: '0.001' }] } }; }
export function okxConfigFixture() { return { code: '0', data: [{ acctLv: '1', posMode: 'net_mode', autoLoan: false, enableSpotBorrow: false, perm: 'read_only', ip: '' }] }; }
export function okxFeeFixture() { return { code: '0', data: [{ instType: 'SPOT', ts: '1700000000000', feeGroup: [{ groupId: '1', maker: '-0.0008', taker: '-0.001' }] }] }; }
export function fixtureForKind(kind: RequestKind) {
  return { BYBIT_BALANCE: bybitFixture, BYBIT_ACCOUNT_INFO: bybitInfoFixture, BYBIT_API_KEY_INFO: bybitPermissionFixture,
    BYBIT_FEE_RATE: bybitFeeFixture, OKX_BALANCE: okxFixture, OKX_ACCOUNT_CONFIG: okxConfigFixture, OKX_TRADE_FEE: okxFeeFixture }[kind]();
}
export function okxFixture() {
  return { code: '0', data: [{ uTime: '1700000000000', details: [
    { ccy: 'BTC', cashBal: '1.25', availBal: '1' },
    { ccy: 'USDT', cashBal: '2500', availBal: '2300' },
  ] }] };
}
