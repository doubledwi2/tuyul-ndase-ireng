import type { EvidenceRecord, EvidenceManifest } from './types.js';
import { latencyProfiles } from './config.js';
import { fingerprint } from './manifest.js';
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid evidence object.');
  return v as Record<string, unknown>;
}
function version(r: Record<string, unknown>) { if (r.schemaVersion !== 1) throw new Error('Unsupported evidence schemaVersion.'); }
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const member = (v: unknown, values: string[]) => typeof v === 'string' && values.includes(v);
export function parseManifest(value: unknown): EvidenceManifest {
  const r = object(value); version(r);
  if (!member(r.context, ['LIVE_ACCOUNT_CONTEXT','SYNTHETIC_ACCOUNT_CONTEXT'])) throw new Error('Invalid evidence context.');
  if (typeof r.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(r.runId) || !finite(r.startedAt) ||
    !Array.isArray(r.profiles) || !r.profiles.length || r.profiles.length > 8) throw new Error('Invalid manifest.');
  const profiles = latencyProfiles(r.profiles.map(p => object(p).latencyMs).join(','));
  if (JSON.stringify(profiles) !== JSON.stringify(r.profiles)) throw new Error('Invalid profile identity.');
  const config = { targetSize: r.targetSize, profiles, paperExecutionConfig: r.paperExecutionConfig,
    qualityThresholds: r.qualityThresholds, feeBaseline: r.feeBaseline, instrumentRuleMode: r.instrumentRuleMode };
  if (r.configFingerprint !== fingerprint(config)) throw new Error('Manifest config fingerprint mismatch.');
  return value as EvidenceManifest;
}
export function parseRecord(value: unknown, manifest: EvidenceManifest): EvidenceRecord {
  const r = object(value); version(r);
  const fields = ['schemaVersion','runId','evidenceGroupId','scenarioId','triggeredAt','closedAt','direction','configuredTarget','ruleAdjustedTarget',
    'ruleStatus','ruleReasons','ruleFingerprint','feeSources','feeRates','fundingStatus','cohort','triggerNetPnl','finalNetPnl','outcome','entryOutcome',
    'feasibility','buyFillRatio','sellFillRatio','firstFillMs','timeToCompleteMs','unhedgedDurationMs','buyPriceDriftBps','sellPriceDriftBps','residualBtc'];
  if (Object.keys(r).length !== fields.length || Object.keys(r).some(k => !fields.includes(k))) throw new Error('Unexpected evidence fields.');
  if (r.runId !== manifest.runId || !manifest.profiles.some(p => p.id === r.scenarioId) ||
    typeof r.evidenceGroupId !== 'string' || !/^[a-f0-9]{64}$/.test(r.evidenceGroupId) ||
    typeof r.ruleFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(r.ruleFingerprint)) throw new Error('Invalid evidence identity.');
  for (const key of ['triggeredAt','closedAt','configuredTarget','ruleAdjustedTarget','triggerNetPnl','buyFillRatio','sellFillRatio','timeToCompleteMs','unhedgedDurationMs','residualBtc']) {
    if (!finite(r[key])) throw new Error('Non-finite evidence value.');
  }
  for (const key of ['finalNetPnl','firstFillMs','buyPriceDriftBps','sellPriceDriftBps']) if (r[key] !== null && !finite(r[key])) throw new Error('Invalid nullable value.');
  if (!member(r.direction, ['BUY_BYBIT_SELL_OKX','BUY_OKX_SELL_BYBIT']) ||
    !member(r.ruleStatus, ['EXECUTABLE','UNKNOWN','NOT_EXECUTABLE']) || !member(r.cohort, ['ACCOUNT_CALIBRATED','MARKET_ONLY']) ||
    !member(r.fundingStatus, ['FUNDED','UNKNOWN_AVAILABLE_BALANCE','STALE_BALANCE','INSUFFICIENT_FUNDS','ACCOUNT_COMPATIBILITY_UNKNOWN','ACCOUNT_INCOMPATIBLE']) ||
    !member(r.outcome, ['CLEAN_FILL','PARTIAL_BOTH','BUY_ONLY','SELL_ONLY','NO_FILL','UNWOUND','UNWIND_FAILED','TIMED_OUT','ABORTED_SHUTDOWN','ABORTED_DETAIL_LIMIT']) ||
    (r.entryOutcome !== null && !member(r.entryOutcome, ['BUY_ONLY','SELL_ONLY','PARTIAL_BOTH','NO_FILL','CLEAN_FILL'])) ||
    !member(r.feasibility, ['FEASIBLE_CLEAN','FEASIBLE_WITH_PARTIAL_OR_UNWIND','NOT_FEASIBLE','UNCERTAIN'])) throw new Error('Invalid evidence enum.');
  for (const key of ['feeSources','feeRates']) {
    const v = object(r[key]); if (Object.keys(v).sort().join(',') !== 'bybit,okx') throw new Error('Invalid fee projection.');
    for (const ex of ['bybit','okx']) if (key === 'feeSources' ? !member(v[ex], ['ACCOUNT_OBSERVED','SIMULATION_FALLBACK']) : !finite(v[ex])) throw new Error('Invalid fee value.');
  }
  if (!Array.isArray(r.ruleReasons) || r.ruleReasons.length > 32 || r.ruleReasons.some(v => !member(v, ['UNKNOWN_RULES','RULE_STALE','RULE_FUTURE','NOT_TRADABLE',
    'BELOW_MIN_QUANTITY','ABOVE_MAX_QUANTITY','BELOW_MIN_NOTIONAL','ABOVE_MAX_NOTIONAL','STEP_MISMATCH','NOT_EXECUTABLE_RULES','NOTIONAL_UNAVAILABLE','USD_CONVERSION_UNAVAILABLE']))) throw new Error('Invalid rule reasons.');
  const record = value as EvidenceRecord;
  if (record.closedAt < record.triggeredAt || record.configuredTarget <= 0 || record.ruleAdjustedTarget <= 0 || record.ruleAdjustedTarget > record.configuredTarget ||
    record.buyFillRatio < 0 || record.buyFillRatio > 1 + 1e-9 || record.sellFillRatio < 0 || record.sellFillRatio > 1 + 1e-9 || record.timeToCompleteMs < 0) throw new Error('Invalid evidence bounds.');
  return record;
}
