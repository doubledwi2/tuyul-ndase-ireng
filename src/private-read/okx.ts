import type { SecretString } from '../security/secrets.js';
import { BalanceReadOnlyClient, type ClientOptions } from './client.js';
import { signOkxRead } from './signing.js';
import type { OkxRequestKind } from './config.js';

export class OkxReadOnlyClient extends BalanceReadOnlyClient {
  constructor(key: SecretString, secret: SecretString, passphrase: SecretString, options: ClientOptions) {
    super('okx', options, (kind, now) => signOkxRead(kind as OkxRequestKind, key, secret, passphrase, now));
  }
}
