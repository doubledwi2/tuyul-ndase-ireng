# Phase 5.4 — public instrument rules

Observation only. Public metadata is independent of private-read, execution adapters, and WebSocket connectors. The only request kinds are `BYBIT_SPOT_INSTRUMENT` and `OKX_SPOT_INSTRUMENT`. Transport fixes HTTPS hosts, paths, query and GET; no URL override, credentials, signer, or exchange write capability.

## Sources and semantics

Audited against current official documentation and public BTC/USDT responses. Fixed endpoints:

- `https://api.bybit.com/v5/market/instruments-info?category=spot&symbol=BTCUSDT`
- `https://openapi.okx.com/api/v5/public/instruments?instType=SPOT&instId=BTC-USDT`

[Bybit instrument documentation](https://bybit-exchange.github.io/docs/v5/market/instrument): Spot `basePrecision` supplies the BTC increment; `tickSize` supplies price increment. `maxMarketOrderQty` is the market BTC maximum, `minOrderAmt` the active USDT minimum. Deprecated `minOrderQty`, `maxOrderQty`, `maxOrderAmt` are not enforced or used as fallback. Thus minQuantity and maxNotional are null, intentionally. Only `Trading` is tradable.

[OKX public instruments](https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments): `lotSz` and `minSz` are BTC, `tickSz` is price increment; only `live` is tradable. The documented Spot `maxMktSz` unit is **USDT**, so it maps to maxNotional, not maxQuantity. No minimum order-value field is invented: minNotional is null. `maxMktAmt` is **USD**, retained separately in maxNotionalUsd. Without a USD conversion source this constraint yields UNKNOWN / USD_CONVERSION_UNAVAILABLE. Even an apparently small order is not claimed fully verified against that USD constraint. Phase 5.4 does not add a conversion feed or assume USD=USDT. Explicit empty maxMktAmt means no published USD cap; missing/malformed field fails SCHEMA.

Null means a documented non-applicable, deprecated, or unpublished constraint, not that all exchange conditions are unrestricted. Required current schema fields are mandatory; unknown instrument status never becomes tradable. Unknown needed inputs (snapshot, freshness, complete simulated notional, USD conversion) yield UNKNOWN.

Market-style simulations always use **BTC base quantity** on both sides. Actual APIs have different/default quantity units: [Bybit marketUnit](https://bybit-exchange.github.io/docs/v5/order/create-order) distinguishes baseCoin/quoteCoin, while [OKX tgtCcy](https://www.okx.com/docs-v5/en/#order-book-trading-trade-post-place-order) distinguishes base_ccy/quote_ccy. Both default market BUY to quote units; this model corresponds to explicit base units, not an actual request. Exchange price protection, best-effort sizing and account checks remain outside the simulation. No order request is constructed or submitted.

## Exact quantities and price preparation

InstrumentRules contains exchange/symbol, DecimalRule priceTick/quantityStep, min/maxQuantity, min/maxNotional, instrumentStatus and local receivedAt. Each DecimalRule retains raw string, scale and BigInt units. Exact raw-decimal constraints are retained alongside convenience numeric fields. maxNotionalUsd cannot be compared directly to a USDT notional.

Decimal parsing expands scientific notation explicitly and bounds input length/exponents/scale. Invalid/negative/nonfinite rules are rejected; steps must be positive. Integer-scaled division floors quantity. Intersection rescales both steps to the same integer scale, computes `LCM(a,b)=a/GCD(a,b)*b`, and floors the target to that grid. The resulting finite positive number must round-trip onto both exact grids and never exceed target; otherwise reject. For steps .0006 and .0004, target .01057 becomes .0096, not independently rounded unequal legs.

No automatic upsizing, order splitting, or max-size clipping. Configured target exceeding an applicable maximum is rejected even when normalization might reduce it. Common quantity below either minimum is rejected. `normalizeHypotheticalOrder` returns original and normalized values plus exact decimal strings and adjustment reasons; it prepares values, not trading approval. MARKET has no normalized limit price. Optional LIMIT preparation floors BUY price (no increased spend) and ceils SELL price (no reduced minimum proceeds); not a marketability guarantee.

Each direction re-walks the multi-level book **at the common quantity**, then validates its BUY and SELL execution notionals against public limits. No stale ticker, no post-calculation PnL scaling. Book simulator/economics still use existing finite Number arithmetic; exact decimal arithmetic specifically governs rule values and quantity grids, not an arbitrary-precision accounting rewrite.

## Runtime, freshness, safety

`INSTRUMENT_RULES_ENABLED=true` by default. Optional `INSTRUMENT_RULES_POLL_INTERVAL_MS` accepts integer 30000–900000 ms; default 300000. Startup fetch is asynchronous and polling is coalesced. Each exchange is isolated. Timeout 3000 ms, body limit 1 MiB, redirect error, JSON validation; at most one retry after 500 ms for transient HTTP 429/5xx, timeout or network errors. Schema/API rejection is not retried. Errors expose category/status, never arbitrary remote body.

Cache stores only latest normalized snapshot per venue, lastSuccessAt, lastError and consecutiveFailures. On failure the last valid snapshot survives until age >900000 ms; diagnostics expose failures immediately. Future receivedAt is unavailable (no lookahead). Stop prevents further polls/retries and waits for bounded in-flight requests. Replay injects snapshots with logical timestamps; pure evaluators never fetch or consult host time. No raw response history, persistence, fingerprint history or per-candidate request.

`npm run rules:check` forces one public fetch even if runtime polling is disabled. `--refresh` performs a second poll. Output includes public normalized rules, cache health, counts and common target. CLI has no depth input, so it explicitly reports NOTIONAL_UNAVAILABLE rather than claiming executable. Live OKX USD cap also keeps overall status UNKNOWN without conversion.

## Shadow integration and metrics

Phase 5.2 original configured-target economics/funding and metric definitions remain unchanged. Each direction adds ruleAssessment, ruleCalibratedBuyNotional, ruleCalibratedSellNotional and ruleCalibratedNetPnl (null unless fully executable and healthy). Separate ruleCalibrationStatus appears in current-shadow health; original shadow health/economics does not masquerade as rules validation.

Phase 5.3 known EXECUTABLE rules select common quantity **before** trigger depth, fees, funding and fill calculations. Known invalid rules reject the attempt. UNKNOWN uses configured target with degraded RULE_SOURCE_UNAVAILABLE and ruleFreshAtTrigger=false (policy B). Attempts retain configuredTargetBtc, ruleAdjustedTargetBtc and a small derived ruleAssessment including source receipt times—not entire rules or account snapshots. Updates only affect later attempts. ruleFreshAtTrigger means fresh **and verified**; consult ruleAssessment for reasons. Entry rule validation does not imply later residual/unwind orders satisfy filters; those remain unconstrained feasibility simulations from Phase 5.3, not exchange-valid requests.

Paper engine, fees, sizing and persistence/replay digest are unchanged. Public-rule failures do not affect paper readiness. Fixed safety boundary remains EXECUTION_MODE=paper, REAL_EXECUTION_ENABLED=false, privateTrade=false, withdrawal=false; no environment override enables trading.

`/health.instrumentRules` exposes freshness, normalized status, last success and sanitized failures. `/metrics.instrumentRulesMetrics` exposes physical requests/successes/failures and current stale-or-unavailable venue gauge. Current shadow and execution shadow each expose **separate** ruleCalibration metrics: assessments/executable/invalid/unknown, overlapping rejection counters, and 2048-sample bounded averages for target reduction BTC/percent and pre/post PnL. Sign flips are strict positive-to-negative or negative-to-positive. Current counters count directions per evaluation; execution counters count assessed triggers, including rejected ones. Null post-rule PnL is not a zero-profit sample. Terminal summaries include these aggregates; disabled shadows do not evaluate them.

Exchange-rule-valid hypothetical order != accepted real order. Dynamic risk controls, account state, rate limits, maintenance, price protection, changes between polling/arrival, and undocumented runtime conditions can still reject an actual order. Phase 5.4 ends here: no real execution.

## Verification

Offline tests cover exact/scientific decimals, awkward-step LCM, min/max constraints, status/freshness/future guards, sanitized official-schema fixtures, cache/retry/transport isolation, unknown continuity, mid-attempt changes and multi-level recalculation. Phase 5.3 nine outcome fixtures each run twice with synthetic known rules, not live metadata; Phase 5.2 fixture remains deterministic twice. Run npm test, typecheck, build, secret:scan, state:check (on a valid DATA_DIR), soak, rules:check and shadow:check. Short live smoke is not a production-duration endurance proof.

Validation for this patch: 422 tests passed; typecheck/build passed; secret scan 193 files, zero findings (heuristic only). Public CLI fetch plus refresh: 4 successes, zero failures. Separate live paper-runtime smoke: both caches fresh/TRADABLE, scheduled refresh successful, /ready healthy with SYNC_HEALTHY and HEALTHY clock, zero authenticated requests, clean shutdown. Its temporary DATA_DIR passed state:check. No live shadow private-account test was needed or performed.

Soak: three deterministic iterations of 13776 records, unchanged Phase 3 digest `c5bd853aa329c09e6b3fe7d75581ef24c08f086f6bb39130fba76aa7ec827492`. This dataset under default thresholds produced zero trades/fills; the existing synthetic paper/shadow outcome unit fixtures separately verify fill behavior. The finite soak found no obvious sustained heap growth; this is not a long-run production guarantee.
