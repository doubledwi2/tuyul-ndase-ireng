import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import type { SecretString } from '../security/secrets.js';
import { REDACTED } from '../security/secrets.js';
import { BALANCE_PATHS } from './config.js';
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
// Not generic signing APIs: method, query and balance path cannot be supplied.
export function signBybitBalance(key: SecretString, secret: SecretString, now: number): BalanceAuthHeaders {
  const timestamp = String(checkedTime(now));
  return key.use(apiKey => secret.use(apiSecret => new BalanceAuthHeaders({
    'X-BAPI-API-KEY': apiKey, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': '5000',
    'X-BAPI-SIGN': createHmac('sha256', apiSecret).update(timestamp + apiKey + '5000' + BALANCE_PATHS.bybit.split('?')[1]!).digest('hex'),
  })));
}
export function signOkxBalance(key: SecretString, secret: SecretString, passphrase: SecretString, now: number): BalanceAuthHeaders {
  const timestamp = new Date(checkedTime(now)).toISOString();
  return key.use(apiKey => secret.use(apiSecret => passphrase.use(pass => new BalanceAuthHeaders({
    'OK-ACCESS-KEY': apiKey, 'OK-ACCESS-PASSPHRASE': pass, 'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-SIGN': createHmac('sha256', apiSecret).update(timestamp + 'GET' + BALANCE_PATHS.okx).digest('base64'),
  }))));
}
