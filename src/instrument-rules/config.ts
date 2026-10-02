export const MAX_INSTRUMENT_RULE_AGE_MS = 900_000;
export const INSTRUMENT_RULES_POLL_INTERVAL_MS = 300_000;
export const RULE_REQUEST_TIMEOUT_MS = 3_000;
export function instrumentRulesConfig(env: NodeJS.ProcessEnv = process.env) {
  const flag = env.INSTRUMENT_RULES_ENABLED ?? 'true';
  if (flag !== 'true' && flag !== 'false') throw new RangeError('INSTRUMENT_RULES_ENABLED must be true/false.');
  const raw = env.INSTRUMENT_RULES_POLL_INTERVAL_MS;
  const pollIntervalMs = raw === undefined ? INSTRUMENT_RULES_POLL_INTERVAL_MS : Number(raw);
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 30_000 || pollIntervalMs > 900_000) throw new RangeError('Instrument polling interval must be 30000..900000 ms.');
  return { enabled: flag === 'true', pollIntervalMs };
}
