export interface BestQuote {
  exchange: 'bybit' | 'okx';
  symbol: 'BTC/USDT';
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  exchangeTimestamp: number | null;
  matchingEngineTimestamp: number | null;
  receivedTimestamp: number;
  receivedMonotonicMs?: number | null;
}

export function isValidBestQuote(quote: BestQuote): boolean {
  return (
    Number.isFinite(quote.bid) &&
    quote.bid > 0 &&
    Number.isFinite(quote.bidSize) &&
    quote.bidSize > 0 &&
    Number.isFinite(quote.ask) &&
    quote.ask > 0 &&
    Number.isFinite(quote.askSize) &&
    quote.askSize > 0 &&
    quote.ask >= quote.bid &&
    (quote.receivedMonotonicMs === undefined ||
      quote.receivedMonotonicMs === null ||
      (Number.isFinite(quote.receivedMonotonicMs) &&
        quote.receivedMonotonicMs >= 0))
  );
}

export type QuoteHandler = (quote: BestQuote) => void;

export interface ExchangeConnection {
  close: () => void;
}
