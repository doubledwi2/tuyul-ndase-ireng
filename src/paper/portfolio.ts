import type { NormalizedOrderBook } from '../types/orderbook.js';
import { isValidNormalizedOrderBook } from '../types/orderbook.js';
import type { PaperBalances } from './balances.js';

export interface PaperInventory {
  totalBTC: number;
  totalUSDT: number;
}

function midPrice(orderBook: NormalizedOrderBook): number | null {
  if (!isValidNormalizedOrderBook(orderBook)) {
    return null;
  }
  const bid = orderBook.bids[0]?.price;
  const ask = orderBook.asks[0]?.price;
  return bid === undefined || ask === undefined ? null : (bid + ask) / 2;
}

export function calculateReferenceBtcPrice(
  bybitBook: NormalizedOrderBook,
  okxBook: NormalizedOrderBook,
): number | null {
  const bybitMid = midPrice(bybitBook);
  const okxMid = midPrice(okxBook);
  if (bybitMid === null || okxMid === null) {
    return null;
  }
  return (bybitMid + okxMid) / 2;
}

export function calculatePaperInventory(
  balances: Readonly<PaperBalances>,
): PaperInventory {
  return {
    totalBTC: balances.bybit.btcAvailable + balances.okx.btcAvailable,
    totalUSDT: balances.bybit.usdtAvailable + balances.okx.usdtAvailable,
  };
}

export function valuePaperPortfolio(
  balances: Readonly<PaperBalances>,
  referenceBtcPrice: number,
): number {
  if (!Number.isFinite(referenceBtcPrice) || referenceBtcPrice <= 0) {
    throw new RangeError('Reference BTC price must be finite and positive.');
  }
  const inventory = calculatePaperInventory(balances);
  return inventory.totalUSDT + inventory.totalBTC * referenceBtcPrice;
}
