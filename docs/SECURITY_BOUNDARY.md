# Phase 5.1 execution and secret boundary

Phase 5.1 DOES NOT enable real trading. Seven allowlisted authenticated account GETs are opt-in and isolated in `src/private-read/`; see [PRIVATE_READ.md](PRIVATE_READ.md). Default PRIVATE_READ_ENABLED=false makes no authenticated requests. Tests use dummy values only.

## Planes and adapters

Public market data stays in `src/exchanges/` using the existing unauthenticated WebSockets. Scanner/pipeline has no private client or secret configuration. `src/execution/` defines the execution interface; the coordinator uses `PaperExecutionAdapter` around the existing latency engine. Paper submission continues to mean a qualified two-leg opportunity: readiness is checked first and the existing engine owns timing, inventory, risk, duplicate detection and reservations. Risk-rejected trades remain recorded as before. Preliminary approval can reject readiness or a sticky risk halt; approval alone never bypasses the engine checks.

The generic interface has submit, cancel, and status operations. Paper cancellation releases only the remaining reservation, preserves fills and residual, and never consumes a cached book. Exposure handling still follows subsequent genuine book updates. `DisabledLiveExecutionAdapter` throws `ExecutionSafetyError` on every operation, including status and cancel. Its immutable approval is always false. Both exchanges' frozen capabilities are publicMarketData/privateRead=true and privateTrade/withdrawal=false. No environment override can enable trading or withdrawal. The separate read clients only sign the seven typed allowlisted GET requests; privateRead does not authorize order status through the live execution adapter.

`OrderRequest` and immutable `OrderIntent` are preparation DTOs without side effects. They are not translated into private requests. Client IDs use a fixed `tni` prefix plus 28 UUID-derived hex characters (31 characters total), contain no user/secret inputs, and have explicit validation. Intent construction accepts injected IDs/time for deterministic tests. Existing engine IDs and replay results are unchanged; the current pair engine does not accept arbitrary single-leg generic requests.

## Fail-closed startup

| Setting | Default | Phase 5.1 behavior |
| --- | --- | --- |
| EXECUTION_MODE | paper | Only paper accepted; live/real/unknown fail |
| REAL_EXECUTION_ENABLED | false | true fails with “Real execution is not implemented/enabled in Phase 5.1.” |
| EXECUTION_KILL_SWITCH | true | Blocks future private execution; false still cannot enable anything |

Boolean settings accept exactly `true` or `false`. The live paper and public scanner entrypoints validate before acquiring state or starting feeds. A future real-execution phase would need both an explicit enable gate and kill switch off, plus separately implemented/reviewed capabilities. Those conditions do not create an execution path in this version.

The startup banner and operational snapshot report mode, gates and two credential-configured booleans only. `npm run execution:check` validates configuration offline and prints that sanitized summary; it does not authenticate. Build before invoking compiled CLI tools. `state:check`, backup, replay, soak and secret:scan never load or require private credential files; their output/determinism does not depend on private configuration.

## Secret configuration

Supported future names are `BYBIT_API_KEY`, `BYBIT_API_SECRET`, `OKX_API_KEY`, `OKX_API_SECRET`, and `OKX_API_PASSPHRASE`; every name also supports the `_FILE` suffix. A Bybit pair must be fully absent or fully present; OKX requires all three together. Empty values, whitespace/control characters, values longer than 4096 characters, partial sets, and simultaneous direct/FILE values fail. Files allow one final LF/CRLF. File paths and contents never appear in validation errors.

Secret files must be regular files, not symlinks; Unix files require owner-read permission and no group/other permissions (use 0400 or 0600). On Windows the Unix mode check is skipped; operators must enforce ACLs. Parent directories should be private to the service/administrator. Place files outside DATA_DIR, repository, journal and backup roots. There is no .env auto-loader or credential hot reload.

`SecretString` stores a JavaScript-private value and prints/serializes/inspects as `[REDACTED]`. Phase 5.1 adds explicit callback access for the allowlisted read signers only. This is a code boundary, not protection against malicious code inside the process. Loading registers configured values for process-lifetime exact-value redaction. Signed headers use separate private storage and are not logged; transient signatures do not accumulate in the registry. Native transport errors are reduced to safe categories. Logger messages, nested context, field names and errors are sanitized; safe serialization avoids executing getters/custom toJSON. Health/metrics/readiness HTTP output uses the same sanitizer. Native malformed-JSON errors omit persisted payload excerpts.

Secrets/config wrappers and private account snapshots are never part of the engine state DTO. Persistence checks serialized checkpoint/journal/event payloads and refuses known configured secret values instead of redacting accounting state. Offline backup does not load credentials and cannot recognize arbitrary unloaded secret values manually inserted into state; it copies only paper recovery files, never account JSON, credential paths or environment files. Tests exercise these boundaries using generated dummy markers, authenticated mock responses and extracted archives.

This is defense in depth, not encryption or a sandbox against malicious code. Secret values remain in process memory for redaction; JavaScript cannot promise secure zeroization. Redaction covers registered exact strings, not every possible encoding/transformation or unknown secret. Extremely short values can cause broad redaction or persistence rejection; use unmistakable dummy markers for validation. Do not put secrets in identifiers, paths or public data.

## Deployment and scanning

Use EnvironmentFile for non-secret operational configuration. For eventual credential delivery prefer systemd `LoadCredential=` with `_FILE` variables; see [VPS deployment](VPS_DEPLOYMENT.md). A root-owned 0600 environment file is a fallback design, but environment values are inherited by child processes. No real values belong in committed files, command arguments, logs, checkpoints or backups.

`npm run secret:scan` checks tracked and non-ignored untracked project text files. It detects credential assignments, obvious dummy secret markers and private-key headers, reporting only file/line/reason. It excludes node_modules, dist, data, backups, binary files and symlinks. It is a heuristic—not proof of no leak; ignored files and git history require separate review. Tests construct fake fixtures dynamically so production source/examples contain no usable credentials. An optional local pre-commit hook may run build and this scanner; hooks are not installed automatically.

`.env`, `.env.*`, `*.secret`, `secrets/`, and `credentials/` are ignored; committed examples remain available. If a real credential was ever committed, removing it from the latest file does not revoke it or remove history; rotate it through your normal incident process.
