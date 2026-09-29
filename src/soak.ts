import { createHash } from 'node:crypto';

import { runLatencyPaperReplay } from './paper/latency-replay.js';

const dataset = process.env.SOAK_DATASET ?? 'data/orderbooks.jsonl';
const iterations = Number(process.env.SOAK_ITERATIONS ?? 3);

if (!Number.isInteger(iterations) || iterations <= 0) {
  throw new RangeError('SOAK_ITERATIONS must be a positive integer.');
}

let expectedDigest: string | null = null;
globalThis.gc?.();
const startedAt = performance.now();
const startMemory = process.memoryUsage();
let peakRss = startMemory.rss;
let peakHeap = startMemory.heapUsed;
let records = 0;
const heaps: number[] = [];
const sampler = setInterval(() => {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  peakHeap = Math.max(peakHeap, memory.heapUsed);
}, 100);
sampler.unref();
for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const result = await runLatencyPaperReplay({
    filePath: dataset,
    speed: 'max',
  });
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        processedRecords: result.processedRecords,
        trades: result.trades,
        orders: result.orders,
        fills: result.fills,
        summary: result.summary,
        metrics: result.metrics,
        riskSummary: result.riskSummary,
      }),
    )
    .digest('hex');
  expectedDigest ??= digest;
  if (digest !== expectedDigest) {
    throw new Error(`Soak replay became non-deterministic at iteration ${iteration}.`);
  }
  globalThis.gc?.();
  const memory = process.memoryUsage();
  heaps.push(memory.heapUsed);
  records += result.processedRecords;
  peakRss = Math.max(peakRss, memory.rss);
  peakHeap = Math.max(peakHeap, memory.heapUsed);
  const handles = process.getActiveResourcesInfo?.() ?? [];
  console.log(
    JSON.stringify({
      iteration,
      processedRecords: result.processedRecords,
      trades: result.trades.length,
      fills: result.fills.length,
      riskState: result.riskSummary.state,
      rssMb: Number((memory.rss / 1024 / 1024).toFixed(2)),
      heapUsedMb: Number((memory.heapUsed / 1024 / 1024).toFixed(2)),
      activeResources: handles.length,
      digest,
    }),
  );
}
clearInterval(sampler);
const endMemory = process.memoryUsage();
const runtimeSec = (performance.now() - startedAt) / 1000;
console.log(JSON.stringify({ startMemory, endMemory, peakRss, peakHeap,
  deltaRss: endMemory.rss - startMemory.rss, deltaHeap: endMemory.heapUsed - startMemory.heapUsed,
  runtimeSec, recordsPerSecond: records / runtimeSec,
  postGc: typeof globalThis.gc === 'function',
  heapTrendBytesPerIteration: heaps.length < 2 ? null : (heaps.at(-1)! - heaps[0]!) / (heaps.length - 1),
  trend: heaps.length >= 3 && heaps.slice(1).every((value, i) => value > heaps[i]! * 1.1)
    ? 'CONSISTENT_GROWTH_REVIEW' : 'NO_OBVIOUS_SUSTAINED_GROWTH',
}));

console.log(
  `[SOAK] Completed ${iterations} deterministic replay iteration(s). This finite run is not proof that a memory leak is absent.`,
);
