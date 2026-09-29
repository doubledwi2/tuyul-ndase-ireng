import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretString, safeJson, sanitizeError, assertNoSecrets } from './secrets.js';
import { loadPrivateConfig, credentialFlags } from './private-config.js';
import { loadExecutionBoundary } from '../execution/startup.js';
import { Logger } from '../operations/logger.js';
import { scanSecretText } from './secret-scanner.js';

const fake = (name: string) => ['FAKE', name, 'SECRET', '123456'].join('_');
const env = { BYBIT_API_KEY: fake('BYBIT_KEY'), BYBIT_API_SECRET: fake('BYBIT'),
  OKX_API_KEY: fake('OKX_KEY'), OKX_API_SECRET: fake('OKX'), OKX_API_PASSPHRASE: fake('PASSPHRASE') };

test('complete or absent credentials allowed; partial, empty, whitespace, ambiguous rejected', async () => {
  assert.deepEqual(credentialFlags(await loadPrivateConfig({})), { bybitPrivateCredentialsConfigured: false, okxPrivateCredentialsConfigured: false });
  assert.deepEqual(credentialFlags(await loadPrivateConfig(env)), { bybitPrivateCredentialsConfigured: true, okxPrivateCredentialsConfigured: true });
  for (const invalid of [
    { BYBIT_API_KEY: fake('PARTIAL') }, { OKX_API_KEY: fake('PARTIAL'), OKX_API_SECRET: fake('PARTIAL2') },
    { ...env, BYBIT_API_KEY: '' }, { ...env, BYBIT_API_KEY: ` ${fake('PADDED')}` },
    { ...env, BYBIT_API_KEY_FILE: '/unused' },
  ]) await assert.rejects(loadPrivateConfig(invalid));
});
test('secret wrappers redact strings, JSON, inspect, nested context and errors', async t => {
  const config = await loadPrivateConfig(env);
  for (const value of Object.values(env)) {
    assert.ok(!JSON.stringify(config).includes(value));
    assert.ok(!inspect(config).includes(value));
  }
  assert.equal(String(config.BYBIT_API_SECRET), '[REDACTED]');
  const cyclic: Record<string, unknown> = { secret: env.BYBIT_API_SECRET };
  cyclic.self = cyclic;
  assert.match(safeJson(cyclic), /Circular/);
  const malicious = { toJSON: () => env.BYBIT_API_SECRET, get value() { throw new Error(env.OKX_API_SECRET); } };
  for (const value of Object.values(env)) assert.ok(!safeJson(malicious).includes(value));
  assert.equal(sanitizeError(new Error(`bad ${env.OKX_API_SECRET}`)), 'bad [REDACTED]');
  const error = t.mock.method(console, 'error', () => {});
  for (const format of ['json', 'text'] as const) {
    new Logger('test', 'DEBUG', format).error('fake', `bad secret ${env.BYBIT_API_SECRET}`, {
      value: env.BYBIT_API_SECRET, nested: { value: env.OKX_API_SECRET }, error: new Error(env.OKX_API_PASSPHRASE),
    });
  }
  for (const call of error.mock.calls) {
    const text = String(call.arguments[0]);
    assert.match(text, /\[REDACTED\]/);
    for (const value of Object.values(env)) assert.ok(!text.includes(value));
  }
  assert.throws(() => assertNoSecrets(JSON.stringify({ value: env.BYBIT_API_SECRET })), /Persistence refused/);
  const quoted = new SecretString('quoted"credential_87654321');
  assert.equal(JSON.stringify(quoted), '"[REDACTED]"');
  assert.throws(() => assertNoSecrets(JSON.stringify({ value: 'quoted"credential_87654321' })));
});
test('secret files support a trailing newline and reject broad permissions/symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tuyul-secrets-'));
  try {
    const path = join(dir, 'key.secret');
    await writeFile(path, `${fake('FILE')}\n`, { mode: 0o600 });
    const config = await loadPrivateConfig({ BYBIT_API_KEY_FILE: path, BYBIT_API_SECRET: fake('FILE_PAIR') });
    assert.equal(config.BYBIT_API_KEY?.configured, true);
    await chmod(path, 0o644);
    if (process.platform !== 'win32') await assert.rejects(loadPrivateConfig({ BYBIT_API_KEY_FILE: path }), /0400\/0600/);
    await chmod(path, 0o600);
    await symlink(path, join(dir, 'link.secret'));
    await assert.rejects(loadPrivateConfig({ BYBIT_API_KEY_FILE: join(dir, 'link.secret') }));
    await writeFile(path, '\n', { mode: 0o600 });
    await assert.rejects(loadPrivateConfig({ BYBIT_API_KEY_FILE: path }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('startup snapshot contains only mode, gates and credential booleans', async () => {
  const snapshot = await loadExecutionBoundary(env);
  assert.deepEqual(snapshot, { executionMode: 'paper', realExecutionEnabled: false, executionKillSwitch: true,
    bybitPrivateCredentialsConfigured: true, okxPrivateCredentialsConfigured: true });
  for (const value of Object.values(env)) assert.ok(!JSON.stringify(snapshot).includes(value));
});
test('secret scanner catches fake fixture, env assignments and private-key header without reporting values', () => {
  const fixture = `BYBIT_API_SECRET=${fake('SCANNER')}`;
  assert.ok(scanSecretText(fixture, '.env').length > 0);
  assert.ok(scanSecretText(['export BYBIT_API_KEY', 'suspiciousliteral123456789'].join('='), 'deploy.sh').length > 0);
  assert.ok(scanSecretText(['-----BEGIN', 'PRIVATE KEY-----'].join(' ')).length > 0);
  assert.equal(scanSecretText('const name = "BYBIT_API_SECRET";').length, 0);
  assert.equal(scanSecretText('BYBIT_API_SECRET=REPLACE_ME', '.env.example').length, 0);
  assert.ok(!JSON.stringify(scanSecretText(fixture, '.env')).includes(fake('SCANNER')));
});
