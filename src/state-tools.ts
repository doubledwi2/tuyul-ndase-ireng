import { copyFile, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from './config/runtime.js';
import { acquireRuntimeLock } from './persistence/runtime-lock.js';
import { DurablePaperStateStore } from './persistence/durable-paper-state.js';

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'check' && mode !== 'backup') throw new Error('Expected check or backup.');
  const lock = await acquireRuntimeLock(DATA_DIR);
  try {
    const result = await DurablePaperStateStore.open({ dataDir: DATA_DIR });
    if (result.recoveredState === null) throw new Error('EMPTY: no durable state found; refusing to report VALID.');
    console.log(JSON.stringify({ status: 'VALID', journalSeq: result.store.getHealth().lastJournalSeq,
      replayedRecords: result.replayedJournalRecords, riskState: result.recoveredState.riskState.sessionRiskState }));
    if (mode === 'check') return;
    const backupDir = join(DATA_DIR, 'backups');
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(backupDir, '.backup-'));
    try {
      await mkdir(join(staging, 'state'));
      const names = (await readdir(join(DATA_DIR, 'state'))).filter(name =>
        name === 'checkpoint.json' || name === 'journal.jsonl' || /^journal\.\d+\.jsonl$/.test(name));
      for (const name of names) await copyFile(join(DATA_DIR, 'state', name), join(staging, 'state', name));
      const archive = join(backupDir, `state-${Date.now()}-${process.pid}.tar.gz`);
      await promisify(execFile)('tar', ['-czf', `${archive}.tmp`, '-C', staging, 'state']);
      await rename(`${archive}.tmp`, archive);
      console.log(`BACKUP ${archive}`);
    } finally { await rm(staging, { recursive: true, force: true }); }
  } finally { await lock.release(); }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
