import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { evidenceConfig } from './config.js';
import { manifest } from './manifest.js';
import { EvidenceRecorder, pruneEvidence } from './recorder.js';
import { EvidenceScenarios } from './scenarios.js';
import type { OpportunityEvent } from '../scanner/opportunity.js';
import type { ShadowInput } from '../shadow/shadow-types.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
export class ShadowEvidenceRuntime {
  private recorder: EvidenceRecorder | null = null;
  private scenarios: EvidenceScenarios | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushTask: Promise<void> | null = null;
  private startupErrors = 0;
  private runId: string | null = null;
  private startedAt: number | null = null;
  private endedAt: number | null = null;
  private constructor(readonly enabled: boolean) {}
  static async create(dataDir: string, config = evidenceConfig()) {
    const runtime = new ShadowEvidenceRuntime(config.enabled);
    if (!config.enabled) return runtime;
    runtime.runId = randomUUID(); runtime.startedAt = Date.now();
    try {
      const m = manifest(runtime.runId, runtime.startedAt, config.profiles, false, config.instrumentRulesEnabled ?? true);
      runtime.recorder = await EvidenceRecorder.create(join(dataDir, 'shadow-evidence'), m);
      const removed = await pruneEvidence(join(dataDir, 'shadow-evidence'), m.runId, m.startedAt, config.retentionDays);
      if (removed) console.log(`[SHADOW EVIDENCE] Removed ${removed} expired finished run(s); not recoverable from this recorder.`);
      runtime.scenarios = new EvidenceScenarios(m, r => runtime.recorder!.append(r));
      runtime.timer = setInterval(() => {
        if (!runtime.flushTask) runtime.flushTask = runtime.recorder!.flush(runtime.summary()).finally(() => { runtime.flushTask = null; });
      }, 5000);
    } catch { runtime.startupErrors++; }
    return runtime;
  }
  onOpportunity(event: OpportunityEvent, input: () => ShadowInput) { this.scenarios?.trigger(event, input); }
  onBook(book: NormalizedOrderBook, at: number) { this.scenarios?.onBook(book, at); }
  tick(at: number) { this.scenarios?.tick(at); }
  getHealth() {
    const r = this.recorder?.health();
    const complete = this.startupErrors === 0 && (r?.evidenceComplete ?? !this.enabled) && (this.scenarios?.getHealth().evidenceComplete ?? !this.enabled);
    return { enabled: this.enabled, runId: this.runId, healthy: complete, evidenceComplete: complete,
      lastRecordAt: r?.lastRecordAt ?? null, recorderErrors: this.startupErrors + (r?.recorderErrors ?? 0) };
  }
  summary() { return { schemaVersion: 1, startedAt: this.startedAt, endedAt: this.endedAt,
    ...this.scenarios?.summary(), ...this.recorder?.health(), ...this.getHealth() }; }
  async shutdown(at: number) {
    if (this.timer) clearInterval(this.timer); this.timer = null;
    this.scenarios?.shutdown(at); this.endedAt = at;
    await this.flushTask;
    if (this.recorder) { await this.recorder.flush(); await this.recorder.close(this.summary()); }
  }
}
