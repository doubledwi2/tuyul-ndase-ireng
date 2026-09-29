import { monitorEventLoopDelay } from 'node:perf_hooks';
import { statfs } from 'node:fs/promises';
import { MAX_CHECKPOINT_AGE_MS, MAX_PERSISTENCE_QUEUE_DEPTH, MIN_FREE_DISK_MB } from '../config/runtime.js';
import type { PersistenceHealth } from '../persistence/durable-paper-state.js';

export function delayMilliseconds(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value / 1e6 : null;
}
export class ResourceMonitor {
  private readonly histogram = monitorEventLoopDelay({ resolution: 20 });
  constructor() { this.histogram.enable(); }
  snapshot() {
    const h = this.histogram;
    const memory = process.memoryUsage();
    return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal, externalBytes: memory.external,
      uptimeSec: process.uptime(), eventLoopDelayMs: {
      p50: h.count ? delayMilliseconds(h.percentile(50)) : null,
      p95: h.count ? delayMilliseconds(h.percentile(95)) : null,
      p99: h.count ? delayMilliseconds(h.percentile(99)) : null,
      max: h.count ? delayMilliseconds(h.max) : null,
    } };
  }
  reset(): void { this.histogram.reset(); }
  close(): void { this.histogram.disable(); }
}
export async function freeDiskBytes(path: string): Promise<number | null> {
  try { const fs = await statfs(path); return fs.bavail * fs.bsize; }
  catch (error) {
    if (['ENOSYS', 'ENOTSUP', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}
export function persistenceReady(health: PersistenceHealth, diskBytes: number | null, now: number): boolean {
  return health.checkpointHealthy && health.journalHealthy &&
    health.queueDepth <= MAX_PERSISTENCE_QUEUE_DEPTH &&
    (diskBytes === null || diskBytes >= MIN_FREE_DISK_MB * 1024 * 1024) &&
    (health.dirtySince === null || now - health.dirtySince <= MAX_CHECKPOINT_AGE_MS);
}
