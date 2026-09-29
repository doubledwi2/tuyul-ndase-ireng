import { mkdir, open, readFile, unlink, rmdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { syncDirectory } from './directory-sync.js';

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export async function acquireRuntimeLock(dataDir: string, alive = processAlive): Promise<{ release(): Promise<void> }> {
  const directory = join(dataDir, 'state');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'runtime.lock');
  // A short-lived mutex serializes stale recovery and owner release. A crashed
  // mutex is deliberately fail-closed; operators inspect/remove it offline.
  const guard = join(directory, 'runtime.lock.guard');
  const token = randomUUID();
  async function exclusive(action: () => Promise<void>): Promise<void> {
    try { await mkdir(guard); }
    catch { throw new Error('Runtime lock maintenance in progress; inspect runtime.lock.guard offline if stale.'); }
    try { await action(); } finally { await rmdir(guard); }
  }
  await exclusive(async () => {
    try {
      const prior = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      if (!Number.isSafeInteger(prior.pid) || (prior.pid as number) <= 0 || typeof prior.token !== 'string') {
        throw new Error('Invalid runtime lock; manual inspection required.');
      }
      if (prior.hostname !== hostname() || alive(prior.pid as number)) throw new Error('DATA_DIR is locked by an active or unverifiable instance.');
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now(), hostname: hostname(), token }));
      await handle.sync();
    } finally { await handle.close(); }
    await syncDirectory(directory);
  });
  return { release: () => exclusive(async () => {
    try {
      const current = JSON.parse(await readFile(path, 'utf8')) as { token?: string };
      if (current.token !== token) throw new Error('Runtime lock ownership changed; refusing removal.');
      await unlink(path);
      await syncDirectory(directory);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }) };
}
