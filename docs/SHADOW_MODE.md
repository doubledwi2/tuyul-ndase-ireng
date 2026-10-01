# Phase 5.2 — real-account shadow observation

Observation/simulation only. Shadow positive != profitable real trade. Shadow funded != approval to trade. No exchange write capability exists. No real order, real fill, private trading stream or real balance mutation is implemented.

## Enable deliberately

Default `SHADOW_MODE_ENABLED=false`. Live market/paper entry points reject shadow=true unless `PRIVATE_READ_ENABLED=true`, before credentials, network, recovery or lock acquisition. Existing `EXECUTION_MODE=paper`, `REAL_EXECUTION_ENABLED=false`, `privateTrade=false` and withdrawal=false remain unchanged. There is no execution mode named shadow.

```sh
npm run build
npm run shadow:check                 # default offline synthetic fixture, twice
npm run shadow:check -- --mock       # same, never reads local credentials
# Only with complete credentials already configured locally; never paste secrets:
PRIVATE_READ_ENABLED=true npm run shadow:check -- --live
PRIVATE_READ_ENABLED=true SHADOW_MODE_ENABLED=true npm run paper
```

`shadow:check --live` performs the existing seven allowlisted GET reads once, then prints fee/balance freshness, account compatibility, permission status and whether funding can be evaluated. It does not subscribe to books, predict a fill or approve trading. Unknown/unsafe diagnostics are printed explicitly; command failure means configuration/read infrastructure failure, not an execution gate. `account:check` retains its stricter safety exit policy.

`ACCOUNT_FEE_MODE=diagnostic` remains the only accepted value. The independent shadow flag opts in to observed-fee economics only in shadow. Paper/scanner/replay FEES and quality thresholds remain authoritative and unchanged. No dependency or endpoint added.

## Data flow and logical time

Public depth pipeline -> comparison + SyncAssessment -> cache-only normalized account projection -> pure shadow evaluator -> bounded metrics/health. Both directional comparisons are evaluated on each depth snapshot, not only baseline QUALIFIED events: this intentionally reveals baseline-negative to shadow-positive fee flips. The paper coordinator finishes its existing work independently before shadow evaluation. Failures are isolated; no private REST request occurs on the candidate path.

The evaluator requires an explicit decision timestamp; it never reads the host clock. Balance, fee, configuration, permission and book receipt timestamps must be <= decision time. Future snapshots are unavailable, not interpolated or borrowed from the future. This is a latest-cache model, not an account-history store: injecting only a future snapshot degrades the assessment rather than reconstructing an earlier one. Synthetic fixture replay uses injected logical timestamps and produces identical assessments/metrics twice. Ordinary historical market replay remains entirely independent of private account APIs.

## Economics and fees

Both BUY Bybit / SELL OKX and BUY OKX / SELL Bybit use the existing multi-level `simulateExecution()` at configured TARGET_BTC_SIZE. Full depth is required. The denominator for spread is buy notional:

```text
netPnl = sellNotional * (1 - sellTakerRate) - buyNotional * (1 + buyTakerRate)
netSpread = netPnl / buyNotional * 100
feeImpactUsdt = shadowNetPnl - baselineNetPnl
```

Baseline uses configured FEES. Shadow uses ACCOUNT_OBSERVED only for a matching normalized, healthy, fresh snapshot with finite rate of magnitude <=0.05. Missing, invalid, failed, stale or future fee uses SIMULATION_FALLBACK for that venue and always marks assessment degraded. Mixed fee sources are explicit. Fallback may still yield SHADOW_POSITIVE if known baseline semantics, depth and sync permit it; it must not be described as fully account-calibrated.

OKX normalization remains negative cost for positive raw rebate and positive cost for negative raw fee. No absolute-value conversion. Original raw rate remains in the collector fee snapshot, not in shadow metrics. Baseline paper is never modified. Economic statuses: SHADOW_POSITIVE, SHADOW_ZERO_OR_NEGATIVE, SHADOW_UNCERTAIN (bad sync, stale/future/invalid books, incomplete depth or invalid arithmetic).

Current-book economics is NOT an expected real fill. It does not model private order latency, future liquidity, fee-currency settlement, net BTC delivery, borrow liabilities or execution guarantees. Phase 3.1 latency/partial-fill simulation stays separate. Quote-currency fee cost is an economic approximation.

## Funding and account interpretation

Funding is independent of economics. Available USDT must cover full buy notional plus nonnegative upfront fee; available BTC must cover sell target. Rebates cannot finance upfront purchases. Actual balances are never reserved, debited, credited or persisted. Repeated observations do not simulate capital depletion.

Bybit available=null NEVER falls back to total. Directional funding statuses/reasons are FUNDED, INSUFFICIENT_FUNDS, UNKNOWN_AVAILABLE_BALANCE, STALE_BALANCE, ACCOUNT_INCOMPATIBLE, ACCOUNT_COMPATIBILITY_UNKNOWN. All blockers are retained. Primary ordering is stale balance, unknown availability, incompatible config, unknown config, insufficient funds. Consequently a normal Bybit observation can show UNKNOWN_AVAILABLE_BALANCE plus ACCOUNT_COMPATIBILITY_UNKNOWN while economics is SHADOW_POSITIVE. Only no blockers yields FUNDED.

Phase 5.1 Bybit UNKNOWN remains UNKNOWN. INCOMPATIBLE blocks usable funding; stale/future config is UNKNOWN. Unsafe permissions add CREDENTIAL_PERMISSION_REVIEW_REQUIRED without stopping GET observation or paper. Missing/stale permissions remain visible separately. There is no combined ready-to-trade field.

Freshness baselines reused: balances <=30 seconds, fee/config/permission <=15 minutes; future timestamps rejected. Public timing thresholds remain Phase 2.3 settings. Poll cadence unchanged: balances 10 seconds, fee/config/permissions 5 minutes, one serial queue per exchange with balance priority and bounded retry. No opportunity-triggered refresh.

## Privacy, metrics and health

Account projection is memory-only, deeply frozen, and passes only required normalized inputs. Assessments contain direction economics, fee-source labels, freshness booleans and fixed reasons—not account amounts, raw responses, API identifiers or config metadata. The optional shadow JSONL recorder is deliberately omitted in this phase: no shadow files, checkpoints or journal records are created. Existing paper state/backup contains no shadow account state.

`/health.shadow`: enabled, DISABLED/WARMING_UP/ACTIVE/DEGRADED, lastEvaluationAt, lastFeeFresh, lastBalanceFresh. Freshness fields describe the last evaluation; stopped evaluations make status DEGRADED after the existing max book age. No financial amounts. Unknown/unsafe account interpretation or fee fallback also degrades health, without changing paper readiness.

`/metrics.shadowMetrics` contains aggregate economics only and exists only when enabled. Existing private inventory endpoint diagnostics remain sensitive: keep the operational server loopback-only. A [SHADOW] summary logs every 60 seconds, not every book tick.

Counters per **evaluation** (two directions): shadowEvaluations, fundedBothDirections, fundingInsufficient, fundingUnknown, feeObservedBoth, feeFallbackCount, credentialReviewCount, compatibilityUnknownCount. Failures may overlap. FundingUnknown includes incompatible/unknown/stale funding interpretation. Counters per **direction**: shadowEconomicPositive, shadowEconomicNegative (includes zero), shadowUncertain, baselinePositiveShadowNegative, baselineNegativeShadowPositive. Flip counters require healthy economic assessment and strict sign changes; zero is not a flip.

Distributions retain at most 2048 directional samples: shadowNetPnl avg/P50/P95/P99/max and feeImpactUsdt avg/P50/P95/P99/max. Nearest-rank percentiles; null for no samples. Lifetime counters are separate from window samples. Finite current-book numeric estimates may be included when synchronization marks economics uncertain; these distributions are diagnostic, not executable outcomes.

Stop at Phase 5.2. No real execution or automatic paper fee calibration.

## Validation (2026-10-01)

- 346 offline tests pass (27 new shadow/integration tests); typecheck and build pass.
- Secret scan: 160 project files, zero findings; heuristic, not a proof of absence.
- Synthetic fixture executed twice identically: one baseline-negative/shadow-positive flip and one baseline-positive/shadow-negative flip. Fixture-compatible accounts and prices are synthetic, not an assertion about real Bybit compatibility.
- Paper soak: three iterations of 13776 records with unchanged Phase 5.1 digest `c5bd853aa329c09e6b3fe7d75581ef24c08f086f6bb39130fba76aa7ec827492`. No trades at default thresholds; existing fill/partial/unwind tests remain green. This finite soak is not long-run proof.
- Built paper replay of clean-fill fixture processed five records, unchanged default behavior. The tsx CLI initially hit sandbox IPC restrictions; the built replay entry succeeded without relaxing network access.
- Public live paper, shadow/private-read disabled: npm development entry and built production entry both reached readiness; zero authenticated requests, clean SIGTERM, checkpoint and subsequent recovery. State check and backup validated that temporary state.
- Authenticated shadow smoke skipped: complete local credential inputs were absent. Actual account-calibrated live shadow results are not claimed.
