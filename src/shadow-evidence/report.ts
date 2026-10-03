import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseManifest, parseRecord } from './schema.js';
import { EvidenceStatistics, WARNINGS } from './statistics.js';

async function smallJson(path: string) {
  if ((await stat(path)).size > 2_000_000) throw new Error('Evidence metadata exceeds size limit.');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
// Streaming with a bounded line buffer, including an uncommitted final fragment.
async function* lines(path: string) {
  let pending = '';
  for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 16384 })) {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      if (newline > 65536) throw new Error('Evidence line exceeds size limit.');
      yield { line: pending.slice(0, newline), complete: true }; pending = pending.slice(newline + 1);
    }
    if (pending.length > 65536) throw new Error('Evidence line exceeds size limit.');
  }
  if (pending.length) yield { line: pending, complete: false };
}
export async function reportEvidence(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  const runs = entries.some(e => e.name === 'manifest.json' && e.isFile()) ? [directory] :
    entries.filter(e => e.isDirectory()).map(e => join(directory, e.name)).sort();
  if (!runs.length) throw new Error('No evidence runs found.');
  const groups = new Map<string, { runCount: number; observationDurationMs: number; stats: EvidenceStatistics; records: number; warnings: Set<string>; contexts: Set<string>;
    losses: { capacityRejected: number; diagnosticFailure: number; recorderErrors: number; detailLimitAborted: number } }>();
  for (const run of runs) {
    const m = parseManifest(await smallJson(join(run, 'manifest.json')));
    let group = groups.get(m.configFingerprint);
    if (!group) {
      if (groups.size >= 32) throw new Error('More than 32 configurations; narrow the report directory.');
      group = { runCount: 0, observationDurationMs: 0, records: 0, stats: new EvidenceStatistics(m.profiles), warnings: new Set(), contexts: new Set(),
      losses: { capacityRejected: 0, diagnosticFailure: 0, recorderErrors: 0, detailLimitAborted: 0 } }; groups.set(m.configFingerprint, group); }
    group.runCount++;
    group.contexts.add(m.context);
    const beforeRecords = group.records;
    let lastAt = m.startedAt;
    const parts = (await readdir(run)).filter(n => /^attempts(?:\.\d+)?\.jsonl$/.test(n)).sort();
    if (!parts.length) group.warnings.add('MISSING_ATTEMPTS_FILE');
    const seen = new Set<string>(); // Bounded duplicate-detection window, not all-history storage.
    for (const part of parts) for await (const { line, complete } of lines(join(run, part))) {
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { group.warnings.add(complete ? 'MALFORMED_INTERIOR_RECORD' : 'TRUNCATED_FINAL_LINE'); continue; }
      // Version errors always fail, including a future-schema final fragment.
      if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== 1) throw new Error('Unsupported evidence schemaVersion.');
      if (!complete) { group.warnings.add('UNCOMMITTED_FINAL_LINE'); continue; }
      let r;
      try { r = parseRecord(value, m); } catch { group.warnings.add('INVALID_RECORD'); continue; }
      const key = `${r.evidenceGroupId}:${r.scenarioId}`;
      if (seen.has(key)) { group.warnings.add('DUPLICATE_RECORD'); continue; }
      seen.add(key); if (seen.size > 10000) seen.delete(seen.values().next().value!);
      group.records++; group.stats.add(r); lastAt = Math.max(lastAt, r.closedAt);
    }
    try {
      const summary = await smallJson(join(run, 'session-summary.json'));
      if (summary && typeof summary === 'object' && 'schemaVersion' in summary && summary.schemaVersion !== 1) throw new Error('Unsupported evidence schemaVersion.');
      if (!summary || typeof summary !== 'object' || !('endedAt' in summary) || typeof summary.endedAt !== 'number' || !Number.isFinite(summary.endedAt)) group.warnings.add('UNCLEAN_OR_ACTIVE_RUN');
      else lastAt = Math.max(lastAt, summary.endedAt);
      if (!summary || typeof summary !== 'object' || !('evidenceComplete' in summary) || summary.evidenceComplete !== true) group.warnings.add('INCOMPLETE_EVIDENCE');
      if (summary && typeof summary === 'object') {
        const s = summary as Record<string, unknown>;
        if (typeof s.recordsWritten === 'number' && s.recordsWritten !== group.records - beforeRecords) group.warnings.add('RECORD_COUNT_MISMATCH');
        if (s.triggers && typeof s.triggers === 'object') {
          const triggers = s.triggers as Record<string, unknown>;
          const expected = m.profiles.reduce((sum, p) => sum + (typeof triggers[p.id] === 'number' ? triggers[p.id] as number : 0), 0);
          if (expected !== group.records - beforeRecords) group.warnings.add('TRIGGER_RECORD_COUNT_MISMATCH');
        }
      }
      if (summary && typeof summary === 'object') for (const key of Object.keys(group.losses) as (keyof typeof group.losses)[]) {
        const value = (summary as Record<string, unknown>)[key];
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) group.losses[key] += value;
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Unsupported evidence schemaVersion.') throw error;
      group.warnings.add('MISSING_OR_INVALID_SESSION_SUMMARY');
    }
    group.observationDurationMs += Math.max(0, lastAt - m.startedAt);
  }
  return { runCount: runs.length, warnings: groups.size > 1 ? ['DIFFERENT_CONFIG_FINGERPRINTS_REPORTED_SEPARATELY'] : [], caveats: WARNINGS,
    configurations: [...groups].map(([configFingerprint, g]) => {
      const summary = g.stats.summary();
      if (summary.incompleteGroups || summary.incompleteGroupEvictions) g.warnings.add('INCOMPLETE_GROUP_COMPARISONS');
      return { configFingerprint, runCount: g.runCount, contexts: [...g.contexts].sort(), observationDurationMs: g.observationDurationMs,
        records: g.records, evidenceComplete: g.warnings.size === 0, losses: g.losses,
        dataQualityWarnings: [...g.warnings].sort(), ...summary };
    }) };
}
