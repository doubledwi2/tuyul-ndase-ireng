import { mkdir, open, rename, readdir, readFile, lstat, rm, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { EvidenceManifest, EvidenceRecord } from './types.js';
import { assertNoSecrets } from '../security/secrets.js';
import { parseRecord } from './schema.js';
export const MAX_EVIDENCE_QUEUE = 1000;
export class EvidenceRecorder {
  private queue = Promise.resolve(); private depth = 0; private failed = false; private closed = false;
  private counts = { recordsWritten: 0, recorderErrors: 0, lastRecordAt: null as number | null };
  private constructor(readonly directory: string, private handle: FileHandle, private manifest: EvidenceManifest,
    private write: (handle: FileHandle, line: string) => Promise<void>) {}
  static async create(parent: string, manifest: EvidenceManifest,
    write = async (handle: FileHandle, line: string) => { await handle.writeFile(line, 'utf8'); }) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(manifest.runId)) throw new Error('Invalid run identifier.');
    await mkdir(parent, { recursive: true });
    const directory = join(parent, manifest.runId); await mkdir(directory); // EEXIST refuses session mixing.
    const data = JSON.stringify(manifest); assertNoSecrets(data);
    const mf = await open(join(directory, 'manifest.json'), 'wx', 0o600);
    try { await mf.writeFile(data); await mf.sync(); } finally { await mf.close(); }
    return new EvidenceRecorder(directory, await open(join(directory, 'attempts.jsonl'), 'ax', 0o600), manifest, write);
  }
  private failure() { this.failed = true; this.counts.recorderErrors++; }
  append(record: EvidenceRecord) {
    if (this.closed || this.failed) return;
    if (this.depth >= MAX_EVIDENCE_QUEUE) { this.failure(); return; }
    let line: string;
    try { parseRecord(record, this.manifest); line = `${JSON.stringify(record)}\n`; assertNoSecrets(line); }
    catch { this.failure(); return; }
    this.depth++;
    this.queue = this.queue.then(async () => {
      if (this.failed) return;
      // A partial failed append latches failure: never append after a corrupt tail.
      await this.write(this.handle, line); this.counts.recordsWritten++; this.counts.lastRecordAt = record.closedAt;
    }).catch(() => this.failure()).finally(() => { this.depth--; });
  }
  async flush(summary?: unknown) {
    await this.queue;
    if (this.closed) return;
    try {
      await this.handle.sync();
      if (summary !== undefined) {
        const data = JSON.stringify(summary); assertNoSecrets(data);
        const temp = join(this.directory, 'session-summary.tmp'); const f = await open(temp, 'w', 0o600);
        try { await f.writeFile(data); await f.sync(); } finally { await f.close(); }
        await rename(temp, join(this.directory, 'session-summary.json'));
      }
    } catch { this.failure(); }
  }
  async close(summary: unknown) { await this.flush(summary); this.closed = true; try { await this.handle.close(); } catch { this.failure(); } }
  health() { return { ...this.counts, healthy: !this.failed, evidenceComplete: !this.failed, queueDepth: this.depth }; }
}

// Only recognized finished sessions are eligible; symlinks/unknown/crashed runs
// are retained for manual inspection. Never traverse a candidate link.
export async function pruneEvidence(parent: string, currentRunId: string, at: number, days: number) {
  let removed = 0;
  const root = resolve(parent);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === currentRunId || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.name)) continue;
    const target = join(root, entry.name);
    try {
      if ((await lstat(join(target, 'manifest.json'))).isSymbolicLink() || (await lstat(join(target, 'session-summary.json'))).isSymbolicLink()) continue;
      const m: unknown = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
      const s: unknown = JSON.parse(await readFile(join(target, 'session-summary.json'), 'utf8'));
      if (!m || typeof m !== 'object' || !s || typeof s !== 'object' || !('schemaVersion' in m) || m.schemaVersion !== 1 ||
        ('schemaVersion' in s && s.schemaVersion !== 1) ||
        !('runId' in m) || m.runId !== entry.name || !('endedAt' in s) || typeof s.endedAt !== 'number' || !Number.isFinite(s.endedAt) ||
        s.endedAt > at - days * 86400000) continue;
      await rm(target, { recursive: true }); removed++;
    } catch { /* Unrecognized or incomplete runs are not deletion targets. */ }
  }
  return removed;
}
