import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadPrivateConfig } from '../security/private-config.js';
import { safeJson } from '../security/secrets.js';
import { Logger } from '../operations/logger.js';
import { OperationalStateManager } from '../operations/operational-state.js';
import { getHealthHttpResponse } from '../operations/health-server.js';
import { LatencyPaperTradingEngine } from '../paper/latency-engine.js';
import { DurablePaperStateStore } from '../persistence/durable-paper-state.js';
import type { PaperExecutionEvent } from '../paper/types.js';
import { BybitReadOnlyClient } from './bybit.js';
import { OkxReadOnlyClient } from './okx.js';
import { PrivateAccountCollector } from './collector.js';
import { balanceUrl } from './config.js';
import { fixtureForKind } from './fixtures.js';
import type { ReadOnlyHttpTransport } from './transport.js';
import { accountCheckSummary } from './check-summary.js';

test('fake authenticated reads: logs/health/metrics/state/backup never contain secrets, signatures or raw account data', async () => {
  const fake = (part: string) => ['FAKE', part, 'SECRET', '987654321'].join('_');
  const credentials = await loadPrivateConfig({ BYBIT_API_KEY: fake('KEYB'), BYBIT_API_SECRET: fake('SECB'),
    OKX_API_KEY: fake('KEYO'), OKX_API_SECRET: fake('SECO'), OKX_API_PASSPHRASE: fake('PASS') });
  const forbidden = ['KEYB', 'SECB', 'KEYO', 'SECO', 'PASS'].map(fake);
  const outputs: string[] = [];
  let now = 1700000000000, failure = false;
  const transport: ReadOnlyHttpTransport = { get: async request => {
    request.headers.use(headers => {
      forbidden.push(headers['X-BAPI-SIGN'] ?? headers['OK-ACCESS-SIGN']!);
      if (failure) throw new Error(JSON.stringify(headers));
    });
    const payload = fixtureForKind(request.kind!);
    const metadata = { apiKey: fake('KEYB'), userID: 'user-marker-8765123', uid: 'uid-marker-8765123',
      ips: ['198.51.100.82'], ip: '198.51.100.82', kycRegion: 'region-marker-8765123', note: 'note-marker-8765123', label: 'label-marker-8765123' };
    forbidden.push(metadata.userID, metadata.uid, metadata.ip, metadata.kycRegion, metadata.note, metadata.label);
    if ('result' in payload) Object.assign(payload.result, metadata);
    if ('data' in payload) Object.assign(payload.data[0]!, metadata);
    return { receivedAt: now, payload };
  } };
  const bybit = new BybitReadOnlyClient(credentials.BYBIT_API_KEY!, credentials.BYBIT_API_SECRET!,
    { enabled: true, url: balanceUrl('bybit', 'https://api.bybit.com'), transport, monotonicNow: () => now, sleep: async () => {} });
  const okx = new OkxReadOnlyClient(credentials.OKX_API_KEY!, credentials.OKX_API_SECRET!, credentials.OKX_API_PASSPHRASE!,
    { enabled: true, url: balanceUrl('okx', 'https://openapi.okx.com'), transport, monotonicNow: () => now, sleep: async () => {} });
  const logger = new Logger('test-private', 'INFO', 'json');
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { outputs.push(args.join(' ')); };
  const collector = new PrivateAccountCollector(true, [bybit, okx], (exchange, error) => {
    logger.warn('private_read_failed', 'Private read failed.', { exchange, category: error.category, status: error.status });
  }, () => now);
  const dataDir = await mkdtemp(join(tmpdir(), 'tuyul-private-boundary-'));
  try {
    const engine = new LatencyPaperTradingEngine(); const before = engine.exportState();
    await collector.pollOnce(); assert.equal(collector.getHealth().bybit.credentialSafety.status, 'SAFE_READ_ONLY');
    assert.equal(collector.getHealth().okx.credentialSafety.status, 'SAFE_READ_ONLY');
    for (const view of [collector.getSafetySummary(), accountCheckSummary(collector, [bybit, okx]), collector.getFeeDiagnostic()]) {
      const text = safeJson(view);
      for (const value of forbidden) assert.ok(!text.includes(value), 'Private metadata escaped normalized projection');
      assert.doesNotMatch(text, /"(?:apiKey|userID|uid|ips|ip|kycRegion|note|label)":/);
    }
    const operational = new OperationalStateManager();
    const base = operational.getHealth(engine.getRiskSummary());
    const healthy = { ...base, privateRead: collector.getHealth() };
    failure = true; now += 10_000; await collector.pollOnce();
    const health = { ...base, privateRead: collector.getHealth() };
    assert.deepEqual(getHealthHttpResponse('GET', '/ready', healthy), getHealthHttpResponse('GET', '/ready', health));
    for (const path of ['/health', '/metrics', '/ready']) outputs.push(safeJson(getHealthHttpResponse('GET', path, health, collector.getMetrics()).body));
    const { store } = await DurablePaperStateStore.open({ dataDir });
    store.attachStateProvider(() => engine.exportState());
    await store.record({ type: 'ORDER', recordedAt: now, order: {} } as unknown as PaperExecutionEvent);
    await store.checkpoint();
    assert.deepEqual(engine.exportState(), before);
    outputs.push(await readFile(store.checkpointPath, 'utf8'), await readFile(store.journalPath, 'utf8'));
    // Even an unrelated operator-created file in DATA_DIR cannot enter backup.
    await writeFile(join(dataDir, 'private-account.json'), JSON.stringify(collector.getInventory()));
    await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/state-tools.ts', 'backup'], {
      env: { PATH: process.env.PATH, DATA_DIR: dataDir, PRIVATE_READ_ENABLED: 'true', BYBIT_API_KEY_FILE: '/nonexistent/never-read' }, timeout: 15000,
    });
    const archive = (await readdir(join(dataDir, 'backups'))).find(name => name.endsWith('.tar.gz'))!;
    const extracted = await promisify(execFile)('tar', ['-xOzf', join(dataDir, 'backups', archive)]);
    outputs.push(extracted.stdout);
    for (const output of outputs) {
      for (const value of forbidden) assert.ok(!output.includes(value), 'Sensitive auth material escaped');
      assert.doesNotMatch(output, /walletBalance|cashBal|sourceUpdatedAt|rawAccountType|private-account/);
    }
  } finally { console.warn = originalWarn; await collector.stop(); await rm(dataDir, { recursive: true, force: true }); }
});
