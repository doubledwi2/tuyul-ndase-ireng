import { createHash } from 'node:crypto';
import { TARGET_BTC_SIZE } from '../config/simulation.js';
import { OPPORTUNITY_QUALITY_CONFIG } from '../config/opportunity.js';
import { PAPER_EXECUTION_CONFIG } from '../config/paper.js';
import { FEES } from '../config/fees.js';
import type { EvidenceManifest } from './types.js';
import type { LatencyProfile } from './config.js';
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function manifest(runId: string, startedAt: number, profiles: LatencyProfile[], synthetic = false, instrumentRulesEnabled = true): EvidenceManifest {
  const config = { targetSize: TARGET_BTC_SIZE, profiles, paperExecutionConfig: { ...PAPER_EXECUTION_CONFIG },
    qualityThresholds: { ...OPPORTUNITY_QUALITY_CONFIG }, feeBaseline: FEES,
    instrumentRuleMode: synthetic ? 'SYNTHETIC_FROZEN' as const : instrumentRulesEnabled ? 'PUBLIC_CACHE' as const : 'DISABLED' as const };
  return { schemaVersion: 1, runId, startedAt, appVersion: '0.5.5', ...config,
    context: synthetic ? 'SYNTHETIC_ACCOUNT_CONTEXT' : 'LIVE_ACCOUNT_CONTEXT',
    flags: { shadow: true, shadowExecution: true, privateRead: !synthetic, instrumentRules: instrumentRulesEnabled }, configFingerprint: fingerprint(config) };
}
