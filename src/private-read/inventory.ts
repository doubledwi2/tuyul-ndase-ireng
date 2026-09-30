import type { PaperBalances } from '../paper/balances.js';
import type { RealInventorySnapshot } from './types.js';

// One-way observation, never an input to the paper engine or risk decisions.
export function compareInventory(real: RealInventorySnapshot, paper: PaperBalances) {
  return { label: 'diagnostic only' as const,
    bybitBtcDifference: real.bybit ? real.bybit.btc.total - paper.bybit.btcAvailable - paper.bybit.btcReserved : null,
    bybitUsdtDifference: real.bybit ? real.bybit.usdt.total - paper.bybit.usdtAvailable - paper.bybit.usdtReserved : null,
    okxBtcDifference: real.okx ? real.okx.btc.total - paper.okx.btcAvailable - paper.okx.btcReserved : null,
    okxUsdtDifference: real.okx ? real.okx.usdt.total - paper.okx.usdtAvailable - paper.okx.usdtReserved : null,
    bybitReceivedAt: real.bybit?.receivedAt ?? null, okxReceivedAt: real.okx?.receivedAt ?? null,
  };
}
