import type { SecretString } from '../security/secrets.js';
import { BalanceReadOnlyClient, type ClientOptions } from './client.js';
import { parseBybitBalanceResponse } from './parsers.js';
import { signBybitBalance } from './signing.js';

export class BybitReadOnlyClient extends BalanceReadOnlyClient {
  constructor(key: SecretString, secret: SecretString, options: ClientOptions) {
    super('bybit', options, now => signBybitBalance(key, secret, now), parseBybitBalanceResponse);
  }
}
