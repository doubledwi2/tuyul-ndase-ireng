import { MarketPipeline } from '../app/pipeline.js';
import { replayOrderBooks } from '../replay/orderbook-replay-engine.js';
import { shadowFixture } from '../shadow/fixture.js';
import { ruleFixture } from '../instrument-rules/fixture.js';
import { EvidenceScenarios } from './scenarios.js';
import { manifest } from './manifest.js';
import { latencyProfiles } from './config.js';
import type { EvidenceRecord, EvidenceManifest } from './types.js';
import { EvidenceRecorder } from './recorder.js';
import type { OpportunityEvent } from '../scanner/opportunity.js';

export async function replayEvidence(file: string, options: { runId?: string; profiles?: ReturnType<typeof latencyProfiles>;
  parent?: string; onRecord?: (r: EvidenceRecord) => void } = {}) {
  let scenarios: EvidenceScenarios | null = null, recorder: EvidenceRecorder | null = null, m: EvidenceManifest | null = null;
  let time = 0, eventSequence = 0, nextEvent = '';
  const ids = new Map<string, string>();
  let pipeline: MarketPipeline;
  const onEvent = (event: OpportunityEvent) => {
    if (event.state !== 'QUALIFIED' || !scenarios || !m) return;
    nextEvent = ids.get(event.id) ?? `event-${++eventSequence}`; ids.set(event.id, nextEvent);
    if (ids.size > 10000) ids.delete(ids.keys().next().value!);
    const s = pipeline.getLatestDepthSnapshot(); if (!s) return;
    const fixture = shadowFixture(0.001, 103, event.updatedAt);
    fixture.books = { bybit: s.bybitBook, okx: s.okxBook }; fixture.sync = s.syncAssessment;
    // Fixed historical rules: not refreshed with host/live metadata. They eventually stale.
    fixture.instrumentRules = { bybit: ruleFixture('bybit', m.startedAt), okx: ruleFixture('okx', m.startedAt) };
    scenarios.trigger({ ...event, id: nextEvent }, () => fixture);
  };
  pipeline = new MarketPipeline({ onEvent });
  let replayWarnings = 0;
  const result = await replayOrderBooks({ filePath: file, speed: 'max', onWarning: () => { replayWarnings++; },
    onOrderBook: async (book, at) => {
      if (!scenarios) {
        m = manifest(options.runId ?? 'deterministic-replay', at, options.profiles ?? latencyProfiles(), true);
        if (options.parent) recorder = await EvidenceRecorder.create(options.parent, m);
        scenarios = new EvidenceScenarios(m, r => { recorder?.append(r); options.onRecord?.(r); });
      }
      time = at;
      scenarios.onBook(book, at); // Same order as live: existing legs see input BEFORE new triggers.
      scenarios.tick(at); pipeline.processOrderBook(book, at);
      // Backpressure offline only: never accumulate the dataset in memory.
      if (recorder && recorder.health().queueDepth > 500) await recorder.flush();
    } });
  const engine = scenarios as EvidenceScenarios | null;
  if (!engine) throw new Error('Replay contained no valid books.');
  // Tick outstanding deadlines, never manufacture an additional book/fill.
  engine.tick(time + 250); engine.tick(time + 450); engine.tick(time + 700); engine.shutdown(time + 700);
  const evidence = recorder as EvidenceRecorder | null;
  await evidence?.flush();
  const summary = { schemaVersion: 1, processedRecords: result.processedRecords, context: 'SYNTHETIC_ACCOUNT_CONTEXT', replayWarnings,
    endedAt: time + 700, ...engine.summary(), evidenceComplete: engine.summary().evidenceComplete && replayWarnings === 0 && (evidence?.health().evidenceComplete ?? true) };
  await evidence?.close(summary);
  summary.evidenceComplete &&= evidence?.health().evidenceComplete ?? true;
  return { manifest: m as EvidenceManifest | null, summary, directory: evidence?.directory ?? null };
}
