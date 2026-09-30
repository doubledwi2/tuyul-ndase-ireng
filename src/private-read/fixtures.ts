// Synthetic offline fixtures, never an exchange response captured from an account.
export function bybitFixture() {
  return { retCode: 0, time: 1700000000000, result: { list: [{ accountType: 'UNIFIED', coin: [
    { coin: 'BTC', walletBalance: '1.25', availableToWithdraw: '1' },
    { coin: 'USDT', walletBalance: '2500' },
  ] }] } };
}
export function okxFixture() {
  return { code: '0', data: [{ uTime: '1700000000000', details: [
    { ccy: 'BTC', cashBal: '1.25', availBal: '1' },
    { ccy: 'USDT', cashBal: '2500', availBal: '2300' },
  ] }] };
}
