export type Exchange = 'bybit' | 'okx';
export interface PrivateAccountSnapshot {
  exchange: Exchange;
  receivedAt: number;
  sourceUpdatedAt: number | null;
  btc: { total: number; available: number | null };
  usdt: { total: number; available: number | null };
  rawAccountType?: string;
}
export type RealInventorySnapshot = Readonly<Partial<Record<Exchange, PrivateAccountSnapshot>>>;
export type ErrorCategory = 'CONFIG' | 'SCHEMA' | 'EXCHANGE' | 'NETWORK' | 'HTTP' | 'RATE_LIMIT' | 'TIMEOUT' | 'CONTENT_TYPE' | 'BODY_SIZE' | 'JSON' | 'POLL_GUARD' | 'STOPPED';
export class PrivateReadError extends Error {
  constructor(readonly category: ErrorCategory, readonly status: number | null = null) {
    super(`Private read failed: ${category}`);
    this.name = 'PrivateReadError';
  }
}
// Never preserve a fetch/native error message, cause, response body or headers.
export function safeFailure(error: unknown): PrivateReadError {
  return error instanceof PrivateReadError ? new PrivateReadError(error.category, error.status) : new PrivateReadError('NETWORK');
}
