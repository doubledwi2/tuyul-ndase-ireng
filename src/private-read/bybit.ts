import type { SecretString } from '../security/secrets.js';
import { BalanceReadOnlyClient, type ClientOptions } from './client.js';
import { signBybitRead } from './signing.js';
import type { BybitRequestKind } from './config.js';

export class BybitReadOnlyClient extends BalanceReadOnlyClient {
  constructor(key: SecretString, secret: SecretString, options: ClientOptions) {
    super('bybit', options, (kind, now) => signBybitRead(kind as BybitRequestKind, key, secret, now));
  }
}
