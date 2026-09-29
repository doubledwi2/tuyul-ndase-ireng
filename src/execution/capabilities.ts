import { ExecutionSafetyError } from './safety.js';
export type Exchange = 'bybit' | 'okx';
export interface ExchangeCapabilities {
  readonly publicMarketData: true;
  readonly privateRead: false;
  readonly privateTrade: false;
  readonly withdrawal: false;
}
const disabled: ExchangeCapabilities = Object.freeze({
  publicMarketData: true, privateRead: false, privateTrade: false, withdrawal: false,
});
export const EXCHANGE_CAPABILITIES = Object.freeze({ bybit: disabled, okx: disabled });
export function requirePrivateCapability(exchange: Exchange, capability: Exclude<keyof ExchangeCapabilities, 'publicMarketData'>): never {
  // Registry is immutable and cannot be overridden by environment/config.
  if (!EXCHANGE_CAPABILITIES[exchange]?.[capability]) throw new ExecutionSafetyError();
  throw new ExecutionSafetyError();
}
