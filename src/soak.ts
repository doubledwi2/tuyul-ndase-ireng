import { createHash } from 'node:crypto';

import { runLatencyPaperReplay } from './paper/latency-replay.js';

const dataset = process.env.SOAK_DATASET ?? 'data/orderbooks.jsonl';
const iterations = Number(process.env.SOAK_ITERATIONS ?? 3);

if (!Number.isInteger(iterations) || iterations <= 0) {
  throw new RangeError('SOAK_ITERATIONS must be a positive integer.');
}

let expectedDigest: string | null = null;
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

console.log(
  `[SOAK] Completed ${iterations} deterministic replay iteration(s). This finite run is not proof that a memory leak is absent.`,
);
