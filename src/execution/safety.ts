export const REAL_EXECUTION_ENABLED = false as const;
export const REAL_EXECUTION_ERROR = 'Real execution is not implemented/enabled in Phase 5.1.';

export class ExecutionSafetyError extends Error {
  constructor(message = REAL_EXECUTION_ERROR) { super(message); this.name = 'ExecutionSafetyError'; }
}

export interface ExecutionSafetyConfig {
  readonly mode: 'paper';
  readonly realExecutionEnabled: false;
  readonly killSwitch: boolean;
}

function booleanConfig(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ExecutionSafetyError(`${name} must be true or false.`);
}

export function parseExecutionSafety(env: NodeJS.ProcessEnv = process.env): ExecutionSafetyConfig {
  if (booleanConfig('REAL_EXECUTION_ENABLED', env.REAL_EXECUTION_ENABLED, false)) throw new ExecutionSafetyError();
  if (env.EXECUTION_MODE !== undefined && env.EXECUTION_MODE !== 'paper') {
    throw new ExecutionSafetyError('EXECUTION_MODE must be paper in Phase 5.1.');
  }
  return Object.freeze({ mode: 'paper', realExecutionEnabled: REAL_EXECUTION_ENABLED,
    killSwitch: booleanConfig('EXECUTION_KILL_SWITCH', env.EXECUTION_KILL_SWITCH, true) });
}

export interface ExecutionApproval { readonly approved: boolean; readonly reasons: readonly string[] }
export const LIVE_APPROVAL: ExecutionApproval = Object.freeze({
  approved: false, reasons: Object.freeze(['PRIVATE_EXECUTION_DISABLED']),
});
