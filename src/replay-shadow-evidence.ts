import { randomUUID } from 'node:crypto';
import { replayEvidence } from './shadow-evidence/replay.js';
import { latencyProfiles } from './shadow-evidence/config.js';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--file' || !args[1]) throw new Error('Usage: replay:shadow-evidence -- --file <orderbooks.jsonl>');
const result = await replayEvidence(args[1], { profiles: latencyProfiles(process.env.SHADOW_LATENCY_PROFILES),
  runId: randomUUID(), parent: `${process.env.DATA_DIR ?? './data'}/shadow-evidence` });
console.log(JSON.stringify({ directory: result.directory, context: result.summary.context, recordsProcessed: result.summary.processedRecords,
  groups: result.summary.groups, profiles: result.summary.triggers, evidenceComplete: result.summary.evidenceComplete,
  latencyDecay: result.summary.latencyDecay, caveats: result.summary.caveats }, null, 2));
