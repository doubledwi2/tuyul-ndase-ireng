import { credentialFlags, loadPrivateConfig } from '../security/private-config.js';
import { parseExecutionSafety } from './safety.js';

// Explicit startup call only. Replay and state validation do not import this.
export async function loadExecutionBoundary(env: NodeJS.ProcessEnv = process.env) {
  const safety = parseExecutionSafety(env);
  const credentials = await loadPrivateConfig(env);
  return Object.freeze({ executionMode: safety.mode, realExecutionEnabled: safety.realExecutionEnabled,
    executionKillSwitch: safety.killSwitch, ...credentialFlags(credentials) });
}
