import { loadExecutionBoundary } from './execution/startup.js';
import { safeJson, sanitizeError } from './security/secrets.js';

try { console.log(safeJson(await loadExecutionBoundary())); }
catch (error) { console.error(sanitizeError(error)); process.exitCode = 1; }
