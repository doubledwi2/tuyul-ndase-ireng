export interface LatencyProfile { id: string; latencyMs: number; label: 'BASELINE_MODELED' | 'MODELED' | 'ZERO_LATENCY_IDEALIZED' }
export function latencyProfiles(raw = '25,50,100,200'): LatencyProfile[] {
  const parts = raw.split(',');
  if (!parts.length || parts.length > 8 || parts.some(p => !/^\d+$/.test(p))) throw new RangeError('Expected 1..8 integer latency profiles.');
  const values = parts.map(Number);
  if (new Set(values).size !== values.length || values.some(n => !Number.isSafeInteger(n) || n < 0 || n > 2000)) throw new RangeError('Profiles must be unique, 0..2000 ms.');
  return values.sort((a, b) => a - b).map(latencyMs => ({ id: `L${latencyMs}`, latencyMs,
    label: latencyMs === 50 ? 'BASELINE_MODELED' : latencyMs === 0 ? 'ZERO_LATENCY_IDEALIZED' : 'MODELED' }));
}
export interface EvidenceConfig { enabled: boolean; profiles: LatencyProfile[]; retentionDays: number; instrumentRulesEnabled?: boolean }
export function evidenceConfig(env: NodeJS.ProcessEnv = process.env): EvidenceConfig {
  const flag = env.SHADOW_EVIDENCE_ENABLED ?? 'false';
  if (!['true', 'false'].includes(flag)) throw new RangeError('SHADOW_EVIDENCE_ENABLED must be true/false.');
  if (flag === 'true' && [env.SHADOW_EXECUTION_ENABLED, env.SHADOW_MODE_ENABLED, env.PRIVATE_READ_ENABLED].some(v => v !== 'true')) {
    throw new RangeError('Live evidence requires shadow execution, shadow mode and private reads enabled.');
  }
  const days = env.SHADOW_EVIDENCE_RETENTION_DAYS ?? '30';
  if (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > 3650) throw new RangeError('Evidence retention must be 1..3650 days.');
  return { enabled: flag === 'true', profiles: latencyProfiles(env.SHADOW_LATENCY_PROFILES), retentionDays: Number(days), instrumentRulesEnabled: env.INSTRUMENT_RULES_ENABLED !== 'false' };
}
