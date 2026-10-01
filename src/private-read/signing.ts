import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import type { SecretString } from '../security/secrets.js';
import { REDACTED } from '../security/secrets.js';
import { READ_PATHS, requestExchange, type BybitRequestKind, type OkxRequestKind } from './config.js';
import { PrivateReadError } from './types.js';

// Headers exist only in a private slot, never enumerable or serializable.
// Short-lived signatures do not grow the process-lifetime secret registry.
export class BalanceAuthHeaders {
  #headers: Readonly<Record<string, string>>;
  constructor(headers: Record<string, string>) { this.#headers = Object.freeze({ ...headers }); Object.freeze(this); }
  use<T>(consumer: (headers: Readonly<Record<string, string>>) => T): T { return consumer(this.#headers); }
  toJSON(): string { return REDACTED; }
  toString(): string { return REDACTED; }
  [inspect.custom](): string { return REDACTED; }
}
function checkedTime(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15) throw new PrivateReadError('CONFIG');
  return now;
}
// Only request kinds are accepted; arbitrary methods/paths cannot be supplied.
export function signBybitRead(kind: BybitRequestKind, key: SecretString, secret: SecretString, now: number): BalanceAuthHeaders {
  if (requestExchange(kind) !== 'bybit') throw new PrivateReadError('CONFIG');
  const timestamp = String(checkedTime(now));
  return key.use(apiKey => secret.use(apiSecret => new BalanceAuthHeaders({
    'X-BAPI-API-KEY': apiKey, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': '5000',
    'X-BAPI-SIGN': createHmac('sha256', apiSecret).update(timestamp + apiKey + '5000' + (READ_PATHS[kind].split('?')[1] ?? '')).digest('hex'),
  })));
}
export function signOkxRead(kind: OkxRequestKind, key: SecretString, secret: SecretString, passphrase: SecretString, now: number): BalanceAuthHeaders {
  if (requestExchange(kind) !== 'okx') throw new PrivateReadError('CONFIG');
  const timestamp = new Date(checkedTime(now)).toISOString();
  return key.use(apiKey => secret.use(apiSecret => passphrase.use(pass => new BalanceAuthHeaders({
    'OK-ACCESS-KEY': apiKey, 'OK-ACCESS-PASSPHRASE': pass, 'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-SIGN': createHmac('sha256', apiSecret).update(timestamp + 'GET' + READ_PATHS[kind]).digest('base64'),
  }))));
}
export function signBybitBalance(key: SecretString, secret: SecretString, now: number): BalanceAuthHeaders {
  return signBybitRead('BYBIT_BALANCE', key, secret, now);
}
export function signOkxBalance(key: SecretString, secret: SecretString, pass: SecretString, now: number): BalanceAuthHeaders {
  return signOkxRead('OKX_BALANCE', key, secret, pass, now);
}
