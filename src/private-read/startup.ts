import { parseExecutionSafety } from '../execution/safety.js';
import { loadPrivateConfig } from '../security/private-config.js';
import { BybitReadOnlyClient } from './bybit.js';
import { OkxReadOnlyClient } from './okx.js';
import type { BalanceReadOnlyClient } from './client.js';
import { privateReadConfig } from './config.js';
import { PrivateReadError } from './types.js';

// Called by live entry points only; offline tools never load this module.
export async function createPrivateReadClients(env: NodeJS.ProcessEnv = process.env) {
  parseExecutionSafety(env);
  const config = privateReadConfig(env);
  const credentials = await loadPrivateConfig(env);
  const clients: BalanceReadOnlyClient[] = [];
  if (credentials.BYBIT_API_KEY && credentials.BYBIT_API_SECRET) clients.push(new BybitReadOnlyClient(
    credentials.BYBIT_API_KEY, credentials.BYBIT_API_SECRET, { enabled: config.enabled, url: config.bybitUrl }));
  if (credentials.OKX_API_KEY && credentials.OKX_API_SECRET && credentials.OKX_API_PASSPHRASE) clients.push(new OkxReadOnlyClient(
    credentials.OKX_API_KEY, credentials.OKX_API_SECRET, credentials.OKX_API_PASSPHRASE, { enabled: config.enabled, url: config.okxUrl }));
  if (config.enabled && clients.length !== 2) throw new PrivateReadError('CONFIG');
  return { enabled: config.enabled, clients };
}
