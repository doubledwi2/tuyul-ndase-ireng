import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { SecretString } from './secrets.js';

export const SECRET_NAMES = [
  'BYBIT_API_KEY', 'BYBIT_API_SECRET',
  'OKX_API_KEY', 'OKX_API_SECRET', 'OKX_API_PASSPHRASE',
] as const;
export type SecretName = typeof SECRET_NAMES[number];
export type PrivateConfig = Readonly<Partial<Record<SecretName, SecretString>>>;

function wrap(value: string, name: SecretName): SecretString {
  // Register before validation, so any later diagnostics are also protected.
  const secret = value ? new SecretString(value) : null;
  if (secret === null || value.length > 4096 || /[\s\x00-\x1f\x7f]/u.test(value)) {
    throw new Error(`${name}: secret must be non-empty, at most 4096 characters, without whitespace/control characters.`);
  }
  return secret;
}

async function fromFile(path: string, name: SecretName): Promise<SecretString> {
  if (!path.trim()) throw new Error(`${name}_FILE cannot be empty.`);
  try {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 8192) throw new Error('Invalid secret file.');
      if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0)) {
        throw new Error('Secret file requires owner-read access and no group/other access (0400/0600).');
      }
      const raw = await handle.readFile('utf8');
      // Mounted/systemd credential files commonly end with one line terminator.
      return wrap(raw.replace(/\r?\n$/, ''), name);
    } finally { await handle.close(); }
  } catch {
    // Never include filesystem paths, native error dumps, or file contents.
    throw new Error(`${name}_FILE: cannot load secret; require a regular owner-readable file (0400/0600 on Unix), no symlink, and valid content.`);
  }
}

export async function loadPrivateConfig(env: NodeJS.ProcessEnv = process.env): Promise<PrivateConfig> {
  const result: Partial<Record<SecretName, SecretString>> = {};
  for (const name of SECRET_NAMES) {
    if (env[name]) new SecretString(env[name]);
  }
  for (const name of SECRET_NAMES) {
    const direct = env[name];
    const file = env[`${name}_FILE`];
    if (direct !== undefined && file !== undefined) throw new Error(`${name}: direct and FILE configuration are ambiguous.`);
    if (direct !== undefined) result[name] = wrap(direct, name);
    else if (file !== undefined) result[name] = await fromFile(file, name);
  }
  for (const names of [SECRET_NAMES.slice(0, 2), SECRET_NAMES.slice(2)]) {
    const count = names.filter(name => result[name] !== undefined).length;
    if (count !== 0 && count !== names.length) throw new Error(`${names[0]!.split('_')[0]} private credentials must be complete or entirely absent.`);
  }
  return Object.freeze(result);
}

export function credentialFlags(config: PrivateConfig) {
  return {
    bybitPrivateCredentialsConfigured: config.BYBIT_API_KEY !== undefined,
    okxPrivateCredentialsConfigured: config.OKX_API_KEY !== undefined,
  };
}
