import type { PaperBalances } from '../paper/balances.js';
import type { RealInventorySnapshot } from './types.js';
import type { Exchange, PrivateAccountSnapshot } from './types.js';
import type { AccountFeeSnapshot } from './account-types.js';
import { FEES } from '../config/fees.js';
import { TARGET_BTC_SIZE } from '../config/simulation.js';
import { MAX_BALANCE_AGE_MS, MAX_DIAGNOSTIC_AGE_MS } from './config.js';
import { isValidNormalizedOrderBook, type NormalizedOrderBook } from '../types/orderbook.js';
import { MAX_QUOTE_AGE_MS } from '../scanner/comparator.js';
import { simulateExecution } from '../scanner/execution-simulator.js';

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

export interface AccountReconciliation {
  exchange: Exchange; realBtc: number | null; realUsdt: number | null; paperBtc: number; paperUsdt: number;
  btcDifference: number | null; usdtDifference: number | null;
  enoughForConfiguredPaperTarget: boolean; enoughBuyUsdt: boolean; enoughSellBtc: boolean;
  requiredBuyUsdt: number | null; targetBtcSize: number; reasons: string[];
}
export function reconcileAccount(exchange: Exchange, real: PrivateAccountSnapshot | null, paper: PaperBalances,
  fee: AccountFeeSnapshot | null, book: NormalizedOrderBook | null, now: number,
  balanceHealthy = true, target = TARGET_BTC_SIZE): AccountReconciliation {
  const reasons: string[] = [];
  const p = paper[exchange], paperBtc = p.btcAvailable + p.btcReserved, paperUsdt = p.usdtAvailable + p.usdtReserved;
  const balanceFresh = real !== null && real.exchange === exchange && balanceHealthy && now >= real.receivedAt && now - real.receivedAt <= MAX_BALANCE_AGE_MS;
  if (!balanceFresh) reasons.push('BALANCE_UNAVAILABLE_OR_STALE');
  const feeFresh = fee !== null && fee.exchange === exchange && now >= fee.receivedAt && now - fee.receivedAt <= MAX_DIAGNOSTIC_AGE_MS;
  const rate = feeFresh ? fee.takerFeeRate.normalizedCostRate : FEES[exchange].takerRate;
  if (!feeFresh) reasons.push('SIMULATED_FEE_ASSUMED');
  let requiredBuyUsdt: number | null = null;
  if (!Number.isFinite(target) || target <= 0) reasons.push('INVALID_TARGET_SIZE');
  else if (!book || book.exchange !== exchange || !isValidNormalizedOrderBook(book) || now < book.receivedTimestamp || now - book.receivedTimestamp > MAX_QUOTE_AGE_MS) {
    reasons.push('MARKET_PRICE_UNAVAILABLE_OR_STALE');
  } else {
    const execution = simulateExecution(book, 'BUY', target);
    // A rebate cannot fund the upfront purchase. Reserve positive cost only;
    // actual fee-currency/account semantics are still not an execution model.
    if (execution.fullyFilled) requiredBuyUsdt = execution.notional * (1 + Math.max(0, rate));
    else reasons.push('INSUFFICIENT_OBSERVED_DEPTH');
  }
  if (real?.btc.available == null || real.usdt.available === null) reasons.push('AVAILABLE_BALANCE_UNKNOWN');
  const enoughBuyUsdt = balanceFresh && requiredBuyUsdt !== null && real.usdt.available !== null && real.usdt.available >= requiredBuyUsdt;
  const enoughSellBtc = balanceFresh && Number.isFinite(target) && target > 0 && real.btc.available !== null && real.btc.available >= target;
  if (balanceFresh && real.btc.available !== null && !enoughSellBtc) reasons.push('INSUFFICIENT_AVAILABLE_BTC');
  if (balanceFresh && real.usdt.available !== null && requiredBuyUsdt !== null && !enoughBuyUsdt) reasons.push('INSUFFICIENT_AVAILABLE_USDT');
  return { exchange, realBtc: real?.btc.total ?? null, realUsdt: real?.usdt.total ?? null, paperBtc, paperUsdt,
    btcDifference: real ? real.btc.total - paperBtc : null, usdtDifference: real ? real.usdt.total - paperUsdt : null,
    targetBtcSize: target, requiredBuyUsdt, enoughBuyUsdt, enoughSellBtc,
    enoughForConfiguredPaperTarget: enoughBuyUsdt && enoughSellBtc, reasons };
}
