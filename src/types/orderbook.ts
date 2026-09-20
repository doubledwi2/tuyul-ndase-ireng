import type { BestQuote, ExchangeConnection } from './market.js';

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface NormalizedOrderBook {
  exchange: 'bybit' | 'okx';
  symbol: 'BTC/USDT';
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  exchangeTimestamp: number | null;
  matchingEngineTimestamp: number | null;
  receivedTimestamp: number;
}

function isValidLevel(level: OrderBookLevel): boolean {
  return (
    Number.isFinite(level.price) &&
    level.price > 0 &&
    Number.isFinite(level.size) &&
    level.size > 0
  );
}

function isSorted(
  levels: readonly OrderBookLevel[],
  direction: 'ascending' | 'descending',
): boolean {
  for (let index = 1; index < levels.length; index += 1) {
    const previous = levels[index - 1];
    const current = levels[index];
    if (previous === undefined || current === undefined) {
      return false;
    }
    if (
      (direction === 'ascending' && current.price <= previous.price) ||
      (direction === 'descending' && current.price >= previous.price)
    ) {
      return false;
    }
  }
  return true;
}

export function isValidNormalizedOrderBook(
  orderBook: NormalizedOrderBook,
): boolean {
  const bestBid = orderBook.bids[0];
  const bestAsk = orderBook.asks[0];
  return (
    (orderBook.exchange === 'bybit' || orderBook.exchange === 'okx') &&
    orderBook.symbol === 'BTC/USDT' &&
    Number.isFinite(orderBook.receivedTimestamp) &&
    orderBook.receivedTimestamp > 0 &&
    bestBid !== undefined &&
    bestAsk !== undefined &&
    orderBook.bids.every(isValidLevel) &&
    orderBook.asks.every(isValidLevel) &&
    isSorted(orderBook.bids, 'descending') &&
    isSorted(orderBook.asks, 'ascending') &&
    bestAsk.price >= bestBid.price
  );
}

export function deriveBestQuote(
  orderBook: NormalizedOrderBook,
): BestQuote | null {
  if (!isValidNormalizedOrderBook(orderBook)) {
    return null;
  }
  const bid = orderBook.bids[0];
  const ask = orderBook.asks[0];
  if (bid === undefined || ask === undefined) {
    return null;
  }
  return {
    exchange: orderBook.exchange,
    symbol: orderBook.symbol,
    bid: bid.price,
    bidSize: bid.size,
    ask: ask.price,
    askSize: ask.size,
    exchangeTimestamp: orderBook.exchangeTimestamp,
    matchingEngineTimestamp: orderBook.matchingEngineTimestamp,
    receivedTimestamp: orderBook.receivedTimestamp,
  };
}

export type OrderBookHandler = (orderBook: NormalizedOrderBook) => void;
export type OrderBookConnection = ExchangeConnection;
