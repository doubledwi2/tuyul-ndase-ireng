import { ExecutionSafetyError } from './safety.js';
export type Exchange = 'bybit' | 'okx';
export interface ExchangeCapabilities {
  readonly publicMarketData: true;
  readonly privateRead: true;
  readonly privateTrade: false;
  readonly withdrawal: false;
}
const readOnly: ExchangeCapabilities = Object.freeze({
  publicMarketData: true, privateRead: true, privateTrade: false, withdrawal: false,
});
export const EXCHANGE_CAPABILITIES = Object.freeze({ bybit: readOnly, okx: readOnly });
export function requirePrivateCapability(exchange: Exchange, capability: Exclude<keyof ExchangeCapabilities, 'publicMarketData'>): void {
  // Registry is immutable and cannot be overridden by environment/config.
  if (!EXCHANGE_CAPABILITIES[exchange]?.[capability]) throw new ExecutionSafetyError();
}
