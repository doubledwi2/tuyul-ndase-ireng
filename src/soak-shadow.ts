import { createHash } from 'node:crypto';
import { replayEvidence } from './shadow-evidence/replay.js';
import { latencyProfiles } from './shadow-evidence/config.js';
const count = process.env.SHADOW_SOAK_ITERATIONS ?? '3';
if (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 100000) throw new Error('SHADOW_SOAK_ITERATIONS must be 1..100000.');
let expected: string | null = null;
const started = performance.now(); let peakHeap = 0, peakRss = 0;
const sampler = setInterval(() => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); }, 50);
try {
  for (let iteration = 1; iteration <= Number(count); iteration++) {
    const records = createHash('sha256');
    const result = await replayEvidence(process.env.SHADOW_SOAK_DATASET ?? 'fixtures/shadow-evidence/latency.jsonl', {
      profiles: latencyProfiles(process.env.SHADOW_LATENCY_PROFILES), onRecord: r => { records.update(JSON.stringify(r)); } });
    const digest = createHash('sha256').update(records.digest('hex')).update(JSON.stringify(result.summary)).digest('hex');
    expected ??= digest; if (expected !== digest) throw new Error('Non-deterministic shadow replay.');
    globalThis.gc?.();
    console.log(JSON.stringify({ iteration, recordsProcessed: result.summary.processedRecords, groups: result.summary.groups,
      attemptsPerProfile: result.summary.triggers, memory: process.memoryUsage(), digest }));
  }
} finally { clearInterval(sampler); }
console.log(JSON.stringify({ runtimeMs: performance.now() - started, peakHeap, peakRss, note: 'Finite synthetic soak; not long-run production proof.' }));
