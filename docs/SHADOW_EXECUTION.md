# Phase 5.3 — hypothetical execution feasibility

Observation/simulation only. No exchange writes, real orders, account mutation or durable shadow execution. Clean shadow fill != real fill probability. Positive simulated PnL != guaranteed profit. No private trading capability exists.

## Opt-in and architecture

`SHADOW_EXECUTION_ENABLED=false` by default. Enabling it requires `SHADOW_MODE_ENABLED=true` and `PRIVATE_READ_ENABLED=true`; invalid combinations fail startup. Execution mode remains paper and REAL_EXECUTION_ENABLED remains false. There is no new endpoint, connection, auth capability or polling cadence. Existing seven authenticated GET reads populate cache independently.

```sh
npm run build
# Only when read-only inputs have already been configured locally:
PRIVATE_READ_ENABLED=true SHADOW_MODE_ENABLED=true SHADOW_EXECUTION_ENABLED=true npm run paper
# All synthetic execution fixtures run twice, with no account/API access:
node --import tsx --test src/shadow-execution/shadow-execution.test.ts
```

The public depth pipeline emits QUALIFIED only through Phase 5.2.1's fresh-pair guard. Live paper and public collector entry points route that event to a separate shadow execution runtime. DETECTED, VALIDATING and current-book SHADOW_POSITIVE alone never trigger an attempt. The core also checks event age, positive baseline economics, healthy trigger sync and valid current books. If observed fees make the trigger shadow economics negative, the baseline-qualified attempt can still be studied; thresholds are not lowered.

Each accepted event ID creates at most one attempt within retention. Private inputs are projected only at trigger from cache, never requested synchronously. The Phase 5.2 evaluator determines observed/fallback sources and funding. Only derived statuses, used fee rates, trigger prices and economics enter the attempt; no actual balance amount or metadata is retained.

Public updates progress existing shadow attempts before pipeline event callbacks. Thus the update creating a trigger cannot itself fill that new attempt, including a zero-latency test configuration. Subsequent fills use every valid single-venue update, not a fresh pair. Post-trigger cross-venue sync failure does not cancel hypothetical legs: their own venue input and deadlines govern them, just as in Phase 3.1. Public/paper work is isolated from shadow diagnostic exceptions.

## Modeled time and eligible liquidity

Shared PAPER_EXECUTION_CONFIG supplies BUY/SELL/UNWIND latency 50 ms, submission-to-deadline timeout 250 ms and unhedged duration 200 ms. These are simulation parameters, NOT measured exchange order latency. No new env latency overrides are implemented. Injected test configs require bounded finite nonnegative integer milliseconds (<=60000).

Arrival = submission + configured latency; deadline = submission + timeout, not arrival + timeout. Paper and shadow share the pure eligibleOrderBook helper. Eligibility requires matching venue and logical processing/recorded time in [arrival, deadline]. Future-received payloads are ignored. Exchange timestamps are not fill clocks. Core logic has no Date.now; live entry points supply time, replay fixtures inject logical timestamps. Live-only timer ticks every 50 ms advance deadlines/exposure even if feeds go silent; event-loop scheduling can delay timer observations.

Book input is consumed before timeout/unhedged transitions at that logical timestamp. At exact deadline, the current input can fill and then remaining orders expire; later inputs with the same timestamp follow sequence order and cannot revive expired orders. This matches Phase 3.1 ordering. Ticks never fill. A new unwind created while processing one input cannot consume that same input, even with zero unwind latency. Only a subsequent newly processed book at/after unwind arrival is eligible. Cached trigger/pre-arrival books are never used.

Each eligible update uses the existing multi-level simulateExecution helper on remaining quantity. Successive partials can accumulate, never above the target except numerical epsilon handled by the shared tolerance. The same object delivered twice is ignored via a weak identity set; distinct normalized updates sharing timestamps remain distinct. A venue input is consumed at most once within an attempt. Separate attempts independently see the full observed liquidity: there is NO global liquidity depletion across hypothetical attempts. Repeated snapshots can replenish liquidity optimistically, as in Phase 3.1.

No paper or real balance budget/reservation is enforced in this market-feasibility layer. This is a deliberate distinction from the funded virtual paper portfolio, not a prediction that an exchange would accept an order. Fee currency, queue position, other traders' depletion, routing, matching latency and actual borrowing/settlement are not modeled.

## Partial fills, leg risk, terminal policy

States: WAITING_ARRIVAL, FILLING, PARTIALLY_FILLED, UNHEDGED, UNWINDING, COMPLETED, FAILED, EXPIRED. On unequal entry fills the residual timer starts. Residual clearing resets the current timer while accumulated exposure duration is retained. At the unhedged threshold, remaining entry quantities are cancelled *inside the simulation* and a single hypothetical unwind is created. Extra BTC bought -> SELL at buy venue; extra BTC sold -> BUY at sell venue. No account reserves are touched.

Two outcome axes preserve leg risk rather than hiding it:

- `entryOutcome`: CLEAN_FILL, PARTIAL_BOTH, BUY_ONLY, SELL_ONLY or NO_FILL.
- Final `outcome`: CLEAN_FILL, PARTIAL_BOTH (balanced partial quantities at timeout), TIMED_OUT (entryOutcome NO_FILL), UNWOUND, UNWIND_FAILED or ABORTED_SHUTDOWN.

For example BUY_ONLY followed by no new unwind book terminates UNWIND_FAILED with entryOutcome BUY_ONLY and explicit residual. It is not mislabeled a clean hedge. A partial unwind that times out keeps the unclosed residual. Shutdown aborts all active attempts without invented fills. Restart discards this observational state; paper checkpoint/journal/recovery are unchanged. A backward wall-clock step at shutdown uses the last logical engine time to complete diagnostics safely.

## Frozen economics and funding

Observed fee is used only when Phase 5.2 marks it fresh/valid at trigger. Otherwise configured FEES is explicitly SIMULATION_FALLBACK and degraded. Rates/sources remain fixed through entry and unwind even if a private poll later changes them. Signed OKX rebates stay negative costs, never absolute-valued. Paper configured fees remain authoritative and independent.

Funding status/reasons are frozen at trigger, not a live approval. Bybit available=null stays UNKNOWN_AVAILABLE_BALANCE and account UNKNOWN remains visible. Market feasibility can be FEASIBLE_CLEAN while funding is unknown, insufficient or incompatible. No actual balance is reserved, spent, or carried forward as simulated depletion. Repeated attempts each observe their own initial funding diagnostic.

PnL uses actual hypothetical fill notionals/VWAP, not trigger prices. Entry matched quantity is min(buyFilled, sellFilled). Gross matched PnL is matched quantity * (sell VWAP - buy VWAP), with proportional allocation of entry fees. Closed unwind quantity adds its sale/purchase economics against the corresponding entry VWAP and allocated entry fee plus unwind fee. `grossPnl` and `netPnlAfterFees` refer ONLY to closed quantities. No realized result means null, not a made-up full-target result. `buyFee`, `sellFee`, `unwindFee` show total accrued costs/rebates; `unallocatedEntryFees` explicitly identifies the signed part attached to still-open exposure. Therefore on a residual trade, grossPnl minus *all* fees is not the closed-quantity net PnL.

Unwind notional, unwindRealizedPnl, residualBtc, buy/sell price drift in bps versus trigger simulated prices, and first eligible book delay (input time minus modeled arrival) remain explicit. These are model/book observations, not measured exchange execution latency or guaranteed slippage.

Feasibility is a market-only label: CLEAN_FILL -> FEASIBLE_CLEAN; PARTIAL_BOTH/UNWOUND -> FEASIBLE_WITH_PARTIAL_OR_UNWIND; no fill/timeouts/unwind failure -> NOT_FEASIBLE; active/aborted observations -> UNCERTAIN. Separate degraded/funding/review fields are never combined into ready-to-trade approval.

## Bounded memory and retention

At most 100 active attempts; excess triggers are rejected with SHADOW_CAPACITY_LIMIT and a cumulative capacityRejected counter. At most 10000 terminal attempts retained. Active and retained attempts keep their complete fill details (maximum 64), transitions and exact running quantities/notionals/fee totals. If another fill would exceed 64 details, the attempt terminates ABORTED_DETAIL_LIMIT with SHADOW_DETAIL_CAPACITY_LIMIT, degraded/UNCERTAIN and an abortedDetailLimit counter; no fill is fabricated or quietly discarded. Transitions are bounded by the capped fill count plus finite arrival/deadline/unwind steps. Attempt samples retain 4096 values per metric per aggregate/direction bucket. No arrays/maps grow with every book indefinitely.

Seen IDs are retained for active plus recent terminal attempts. When a terminal attempt is evicted, its ID is removed and a conservative retired-trigger-time watermark rejects any later event whose detectedAt is at/before that watermark. This can reject a very old legitimate long-lived event, intentionally preferring missed diagnostics over resurrecting forgotten IDs. Recovery's retained event ID cannot create a second attempt while retained. New cleanly detected events after the watermark remain eligible. No persistence or replay recovery is implied.

## Health, metrics and privacy

`/health.shadowExecution`: enabled, activeAttempts, lastTriggeredAt, lastTerminalAt, capacityHealthy, diagnosticFailures. No amounts. `/health.shadowCurrent` exposes the existing current-book health; legacy `shadow` alias remains. Current economics stay at `/metrics.shadowMetrics`; execution aggregates at `/metrics.shadowExecutionMetrics`. Neither execution health nor execution metrics returns raw private data or exact balances. Existing inventory diagnostics remain sensitive; keep the server loopback-only.

A [SHADOW EXECUTION] summary every 60 seconds reports cumulative triggered/terminal counts, active count, clean/partial/single-leg/unwind/no-fill/timeout/aborted counts, price drift, fill ratios, timing and PnL distributions, and positive-trigger decay counts. No per-book logging. Metrics are aggregate and separately BUY_BYBIT_SELL_OKX / BUY_OKX_SELL_BYBIT.

Counters can overlap: entry BUY_ONLY may later be UNWOUND, noFill includes aborted attempts with no fill, and timeouts include expired partial or unwind attempts. cleanFillRate = cleanFills / terminalAttempts including shutdown aborts in denominator. Strict positive-to-positive/negative counters require an economically closed terminal residual of zero and exclude aborts; positive-to-no-fill excludes aborts. Zero PnL is neither positive nor negative. PnL distributions may include meaningful realized *partial* results with still-open residual, not a complete-portfolio profitability claim. Ratios/timing distributions include terminal aborts. Percentiles use nearest rank; empty statistics are null.

Synthetic fixtures cover clean fill, pre-arrival-only timeout, buy-only, sell-only, balanced partials, successful/failed unwind, positive signal decaying negative, and equal-timestamp input ordering. Every fixture runs twice with deterministic IDs and compares transitions/fills/outcomes/PnL/metrics. Tests also cover fresh-pair trigger integration, frozen fee/rebate/funding, retention/capacity, unchanged paper state and static network isolation.

Stop after Phase 5.3. No real execution.

## Validation (2026-10-02)

- 397 offline tests pass (28 new); typecheck/build pass. All nine execution fixtures run twice with identical results; all existing Phase 3 latency outcomes remain unchanged.
- Paper soak: three iterations, 13776 records each, unchanged digest `c5bd853aa329c09e6b3fe7d75581ef24c08f086f6bb39130fba76aa7ec827492`, no default-threshold trades. Finite regression check, not long-run proof.
- State check validates the existing temporary checkpoint. Built paper replay processes the six-record clean-fill fixture; Phase 5.2 shadow mock still runs twice identically.
- Public live paper with both shadow flags/private-read disabled reaches readiness in development and built entry points, with clean shutdown/recovery and zero authenticated requests. No execution attempt or metrics created in disabled mode.
- Authenticated shadow-execution smoke skipped: complete local credential inputs absent. Synthetic results do not establish actual account or exchange fill behavior.
