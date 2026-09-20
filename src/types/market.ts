export interface BestQuote {
  exchange: 'bybit' | 'okx';
  symbol: 'BTC/USDT';
  bid: number;
  ask: number;
  exchangeTimestamp: number | null;
  receivedTimestamp: number;
}

export type QuoteHandler = (quote: BestQuote) => void;

export interface ExchangeConnection {
  close: () => void;
}
