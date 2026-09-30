import type { SecretString } from '../security/secrets.js';
import { BalanceReadOnlyClient, type ClientOptions } from './client.js';
import { parseOkxBalanceResponse } from './parsers.js';
import { signOkxBalance } from './signing.js';

export class OkxReadOnlyClient extends BalanceReadOnlyClient {
  constructor(key: SecretString, secret: SecretString, passphrase: SecretString, options: ClientOptions) {
    super('okx', options, now => signOkxBalance(key, secret, passphrase, now), parseOkxBalanceResponse);
  }
}
