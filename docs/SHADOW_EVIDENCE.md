# Phase 5.5 — long-run evidence and latency sensitivity

This phase collects observations. It does not authorize live trading. It adds no exchange endpoint or execution capability. Existing paper sizing, fees and replay semantics stay unchanged. Existing public streams, two public instrument GET kinds and seven opt-in account GET kinds are the only exchange connectivity.

## Profiles and common trigger

Default profiles: L25, L50, L100, L200, with BUY/SELL/UNWIND latency respectively 25, 50, 100, 200 ms. L50 is BASELINE_MODELED, not measured latency. Shared order timeout is 250 ms and max-unhedged duration is 200 ms, inherited from Phase 3 config. Profiles do not change paper defaults.

SHADOW_LATENCY_PROFILES accepts 1–8 unique integers 0–2000, sorted into stable `L<n>` identities. L0 is ZERO_LATENCY_IDEALIZED. Latency at or beyond timeout has no execution window and expires without fill—even if a book arrives exactly at timeout. For ordinary profiles the existing inclusive deadline semantics remain. This boundary guard is shadow-only, not a paper change.

Each fresh-pair QUALIFIED event reads cached account/rule input once for the scenario set. `prepareShadowTrigger` computes/freeze-recurses a derived immutable context: target, fee source/rate, funding, rules, trigger prices and economics. Every profile receives the same prepared context; none fetches or independently evaluates account state. Normalization is performed before fill simulation, following Phase 5.4 policy. UNKNOWN rules continue degraded at configured size; NOT_EXECUTABLE rejects all profiles and is counted in drops, not fabricated into an attempt. Existing single-profile Phase 5.3 diagnostics continue independently alongside the evidence scenario set.

All profiles receive identical ordered book object references, before any new trigger arising from that input. Only engine arrival eligibility differs. No global depth depletion across scenarios or concurrent attempts: each observes liquidity independently (optimistic). Live logical ticks run from the existing 50 ms timer; event-loop delay can delay timeout/unwind observation. No inferred intra-packet fills, queue position, or real acknowledgement latency. Offline replay uses input time and explicit final deadline ticks, never host time for decisions.

Correlation: `evidenceGroupId = SHA256([runId, opportunityEventId])`. Profiles share this ID and frozen rule fingerprint; only latency differs. Source event IDs are not persisted. A rule fingerprint hashes a minimal public normalized-rule projection, excluding receipt time. Active targets/rates/funding never mutate with later cache updates. Groups with capacity or diagnostic drops remain visibly incomplete; partial matched comparisons are not counted as full cross-profile groups.

## Opt-in live operation

Build first. Existing service/secret-file setup remains in effect; examples contain no secret values:

```sh
npm install
npm run build
PRIVATE_READ_ENABLED=true SHADOW_MODE_ENABLED=true SHADOW_EXECUTION_ENABLED=true \
INSTRUMENT_RULES_ENABLED=true SHADOW_EVIDENCE_ENABLED=true \
SHADOW_LATENCY_PROFILES=25,50,100,200 npm run start:paper
```

Configure existing `_FILE` secret settings through the Phase 4.2 deployment environment, not shell history or chat. Keep EXECUTION_MODE=paper and REAL_EXECUTION_ENABLED=false. privateTrade and withdrawal remain false. Evidence defaults to disabled and creates no evidence directory when disabled. Live evidence retains the existing requirement for private-read + shadow + shadow-execution; it does not enable unauthenticated live shadow implicitly. Incomplete local credentials must not be replaced with fabricated live credentials. Offline synthetic context is separate.

For VPS use the existing paper service/runbook. Set DATA_DIR on a monitored persistent volume. Evidence health does not gate paper; monitor it separately. Public metadata failures retain Phase 5.4 stale/unknown semantics. In particular OKX's unresolved USD cap can legitimately keep rule status UNKNOWN; ACCOUNT_CALIBRATED may therefore be empty, which is useful evidence rather than a reason to relax checks.

## Schema v1 and privacy

Each process/session creates a unique `DATA_DIR/shadow-evidence/<run-id>/` using exclusive directory creation. Files:

- manifest.json: schemaVersion=1, run ID/start, app version, target, profiles, paper timing, quality thresholds, baseline fees, rule mode, enabled flags, synthetic/live context and deterministic config fingerprint. No environment dump.
- attempts.jsonl: one sanitized terminal record per accepted profile attempt, including losses, no-fill, shutdown/detail aborts—not only positive observations.
- session-summary.json: periodic aggregate snapshot and final endedAt on graceful shutdown.

Record allowlist: run/group/profile identity; trigger/close time and direction; configured/adjusted BTC target; rule status/reasons/fingerprint; fee source labels and rates used; funding **status only**; cohort; trigger/final hypothetical PnL; outcome/entryOutcome/feasibility; BUY/SELL fill ratios; first-fill and completion delays; unhedged duration; price drift; residual BTC. No balances, available amounts, UID, account IDs, key metadata, permission payloads, IP/KYC or raw private responses. Serialization validates the allowlisted schema and applies the existing secret registry guard. Public rules are hashed, not dumped. Permissions are reflected only through derived cohort classification.

ACCOUNT_CALIBRATED requires live context, both observed fresh fees, fresh EXECUTABLE rules, FUNDED, compatible accounts and safe/available diagnostics (no degraded trigger reasons). It is not trade-ready. Everything else is MARKET_ONLY. Synthetic replay always remains MARKET_ONLY with SYNTHETIC_ACCOUNT_CONTEXT, even when its injected fee labels say ACCOUNT_OBSERVED.

## Durability and failure behavior

Writes are serialized through one append handle. Only terminal records are written, never market ticks. Data is synced every 5 seconds and on graceful shutdown; summaries use write/sync/temp/rename. No fsync per book. This is observational durability, not a transactional ledger or cross-file atomic commit. OS/storage failure can lose records since the last successful sync; analysis checks counts against final summaries and warns about missing evidence.

A partial append failure latches the recorder into failed state: no subsequent record is appended behind a corrupt tail. Earlier complete lines survive. Queue overflow, append/flush failure, startup recorder failure, profile capacity loss or unrecoverable diagnostic errors make evidenceComplete false. Health/metrics expose errors and do not stop paper processing. Graceful shutdown records ABORTED_SHUTDOWN for active observations and waits for flush. A crash does **not** restore attempts or fabricate terminal outcomes; restart gets a new directory. Active/crashed runs with no final endedAt are warned as incomplete.

Retention defaults to 30 days (`SHADOW_EVIDENCE_RETENTION_DAYS`, integer 1–3650). Startup prunes recognized **finished** runs older than the limit using endedAt. Current run, symlinks, unknown directories and incomplete/crashed sessions are never auto-deleted. This conservative safety exception means crashed sessions require manual review/cleanup. Deletions are logged and not recoverable from this recorder. File rotation is not implemented; attempts.jsonl can grow during a long session, so monitor free space and restart sessions periodically if needed.

## Metrics, cohorts and bounded memory

/health.shadowEvidence: enabled, runId, healthy, evidenceComplete, lastRecordAt, recorderErrors; no absolute path. /metrics.shadowEvidenceMetrics and periodic operational summaries include groups, accepted triggers/profile, rejection reasons/profile, capacity/diagnostic/detail-limit counters, recorder writes/failures, outcomes, cross-profile survival and latency decay. File-writing failures are shared recorder counters; engine diagnostic failures are also per profile. Detail-limit abort is a recorded result, not a secretly discarded attempt.

Limits: 8 profiles; 100 active/profile (800 scenario attempts total), one recent terminal attempt/profile, existing 64-fill-detail cap, existing bounded engine metric samples, 10000 recently accepted IDs, and <=800 live correlation groups. Statistics retain at most 1000 unfinished cross-profile groups (evictions explicitly counted), 10000 recent record IDs for duplicate detection during analysis, and latest 2048 samples per metric/bucket. Counts are cumulative; quantiles are rolling-window approximations, **not** exact all-session percentiles. No all-history attempt array or book history. Recorder queue is capped at 1000 serialized records. JSONL reader caps a line at 64 KiB and metadata at 2 MB. Reports allow at most 32 config fingerprints; narrow the input when exceeding this bound.

Reports provide aggregate and per-profile statistics plus direction, rule status, fee-source, funding-status and cohort splits (also profile-within-split in structured report results). Both direction labels are explicit; absent directions have no observed samples, not invented zero-latency results. Cross-profile comparisons use only complete groups, split by direction as well as aggregate. Adjacent configured profiles count positive→negative, clean→no-fill and clean→one-leg/unwind. Default profiles correspond to 25→50→100→200 ms. Clean fill can still lose money. A positive/negative final economics sample requires zero residual, non-null PnL and non-aborted completion; all terminals, including aborts, remain in rate denominators. Partial/one-leg/no-fill classification uses entryOutcome; unwind/timeout classification uses terminal outcome, so counters may overlap. Residual PnL is not marked to an invented exit.

## Offline report and replay

```sh
npm run shadow:report -- --dir data/shadow-evidence
npm run shadow:report -- --dir data/shadow-evidence/<run-id>
npm run replay:shadow-evidence -- --file fixtures/shadow-evidence/latency.jsonl
SHADOW_SOAK_ITERATIONS=500 npm run soak:shadow
# Optional larger dataset and custom profile set:
SHADOW_SOAK_DATASET=data/orderbooks.jsonl SHADOW_LATENCY_PROFILES=25,50,100,200 npm run soak:shadow
```

No network or credential loading in these commands. The replay uses MarketPipeline → source-clock/sync/fresh-pair qualification → shared rule/fee preparation → scenarios. Synthetic diagnostics are created at each logical trigger; rule fixtures are frozen at the first record timestamp and become stale after their normal max age, not refreshed with host/live metadata. The supplied 106-book fixture warms up the actual 30-sample source estimator and passes ordinary quality thresholds before triggering.

CLI replay creates a fresh unique run directory. Programmatic fixture mode defaults to deterministic-replay run ID and substitutes deterministic lifecycle event identities, enabling exact records/group IDs/metrics comparisons across runs. Soak hashes records incrementally plus summary; it never accumulates them in RAM. Iterations accept 1–100000. No optional `--since-hours` filter or internal scheduler is implemented: select a run/parent and use external scheduling if required.

Report reads JSONL incrementally, warns and skips corrupt interior records or truncated/uncommitted final lines, and rejects unknown future schemas. Complete lines are not discarded because the tail is damaged. It reports incomplete groups, missing/unclean summary, duplicate records within its bounded window, and record-count discrepancies. Config fingerprints include target, quality thresholds, profiles, all shared timing/partial-fill settings, rule mode and baseline fees; differing fingerprints are reported separately, never blindly merged. Run count and summed observation duration are explicit (sum is not the wall-clock union for overlapping runs). No profitability threshold or live-trading approval is inferred.

Always interpret results as **observed shadow survival rates**: hypothetical fills, no queue position, no real acknowledgements, modeled latency, independent concurrent liquidity, possibly unknown funding, and no guarantee future books will fill.

## Validation of this patch

445 tests passed; typecheck/build passed; secret scan: 210 project files, zero findings (heuristic, not proof). State check on the temporary public-smoke DATA_DIR was VALID. Privacy tests searched persisted files for injected key/UID/IP/exact-balance sentinels and found none. Two persisted deterministic fixture replays produced identical records and reports; the CLI successfully analyzed the generated evidence.

Synthetic fixture: L25 and L50 clean/positive (+0.02797 USDT), L100 clean/negative (-0.01199 USDT), L200 NO_FILL/TIMED_OUT. A separate fixture verifies L25/L50 clean versus L100/L200 no-fill. These are deliberately constructed fixtures, not market-performance evidence.

Shadow soak: 500 independent deterministic replay iterations, 53000 input records, 500 groups and 2000 scenario attempts total. Digest `46ec2617ded67a89c7e48b1bd22ef66f8bb2f0fac3a16036f0e5e698c9cef238` matched each iteration. That finite run took ~8.8 seconds, observed peak RSS ~55.5 MiB and peak heap ~8.6 MiB; final post-GC heap ~6.7 MiB. It tests repeated replay, not a continuously retained multi-day live session. Capacity tests separately exercise all 800 active scenario slots, and sample/correlation/queue limits are unit-tested.

Existing paper soak: three iterations of 13776 records, unchanged digest `c5bd853aa329c09e6b3fe7d75581ef24c08f086f6bb39130fba76aa7ec827492`. Default dataset yielded zero trades/fills; synthetic outcome fixtures cover actual modeled fills.

Public smoke reached ready/SYNC_HEALTHY with both exchanges, refreshed public metadata successfully, performed zero authenticated requests, created no evidence directory while disabled, and shut down cleanly. Authenticated evidence smoke was skipped because complete local credential inputs were unavailable. No credentials were requested in chat. No hours/days-long live evidence collection or profitability claim is made by this patch.

A repeated final-build smoke also reached ready and refreshed both sources, but its last sampled timing status was RECEIVE_SKEW_HIGH (host clock HEALTHY). This is reported, not filtered out: readiness/synchronization can change between samples, and existing guards remain in effect.
