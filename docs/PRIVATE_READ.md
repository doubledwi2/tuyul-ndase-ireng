# Phase 5.1 — read-only account reconciliation and fee diagnostics

Real execution remains disabled. Public market data adapters and paper economics are unchanged. Private reads are opt-in (`PRIVATE_READ_ENABLED=false` by default), memory-only, and never authorize orders. Capabilities remain publicMarketData/privateRead=true, privateTrade/withdrawal=false. The disabled live adapter rejects every operation, including order status. No method other than GET exists in the private-read transport.

## Exact authenticated allowlist

| Typed request kind | Fixed GET path and query |
| --- | --- |
| BYBIT_BALANCE | `/v5/account/wallet-balance?accountType=UNIFIED&coin=BTC,USDT` |
| BYBIT_FEE_RATE | `/v5/account/fee-rate?category=spot&symbol=BTCUSDT` |
| BYBIT_ACCOUNT_INFO | `/v5/account/info` |
| BYBIT_API_KEY_INFO | `/v5/user/query-api` |
| OKX_BALANCE | `/api/v5/account/balance?ccy=BTC,USDT` |
| OKX_ACCOUNT_CONFIG | `/api/v5/account/config` |
| OKX_TRADE_FEE | `/api/v5/account/trade-fee?instType=SPOT&instId=BTC-USDT` |

Signers accept a typed request kind, never a caller-provided path or method. Runtime validation rejects unknown or cross-exchange kinds. Bybit HMAC-SHA256 hex signs timestamp + API key + 5000 receive window + exact query (empty for info/query-api). Thus those two queryless Bybit requests intentionally have the same signature at the same timestamp; the exact path is enforced by the transport. OKX HMAC-SHA256 base64 signs ISO timestamp + GET + exact path/query. Retries re-sign. Bybit RSA keys and OKX simulated-account mode are not supported.

There are no create/cancel/amend/transfer/withdraw requests, configuration setters, permission changes, or private trading WebSockets.

## Domains and transport

Defaults: BYBIT_API_BASE_URL=https://api.bybit.com; OKX_API_BASE_URL=https://openapi.okx.com (global-account assumption).
Bybit supported hosts: api.bybit.com, api.bytick.com, api-testnet.bybit.com. Other Bybit regional accounts are unsupported; do not bypass regional restrictions.
OKX hosts: openapi.okx.com, www.okx.com, us.okx.com, eea.okx.com, tr.okx.com. US/Australia app.okx.com accounts require us.okx.com; EU my.okx.com accounts require eea.okx.com; Türkiye operators must follow matching regional documentation. There is no automatic fallback between domains.

Origins must match exactly, HTTPS only, optional trailing slash; no userinfo, explicit ports, encoded/extra paths, query, fragment, whitespace or localhost. Every final URL is checked against kind + exchange + host + exact path/query. Redirects are rejected. Timeout is 3000 ms per attempt, including body reading; maximum JSON body is 1 MiB including streamed responses without Content-Length. Native errors, headers and bodies never escape as diagnostics.

## Permission introspection

`CredentialSafetyAssessment` contains exchange, SAFE_READ_ONLY / UNSAFE_WRITE_ENABLED / UNKNOWN, fixed diagnostic reasons and checkedAt. Unknown schema throws SCHEMA; the collector presents UNKNOWN, retains the old normalized snapshot, and exposes failed refresh/freshness separately.

Bybit requires readOnly=1 **and** absence of explicit write scopes. SpotTrade, wallet transfer scopes and Withdraw each generate independent reasons; readOnly=0 adds BYBIT_KEY_NOT_READ_ONLY. Other known write scopes are also unsafe. Unknown permission groups/values fail closed. This intentionally conservative policy flags arrays even when readOnly=1 may restrict their effective use: it is a review signal, not proof a write request would succeed. Derived read-only/trade/transfer/withdraw booleans and ipBound are the only retained key metadata.

OKX perm is parsed as a comma-separated set of read_only/trade/withdraw. Trade or withdraw makes the diagnostic unsafe. Unknown tokens fail schema; no permission is inferred from balance success. IP information becomes a boolean (or null if unavailable); addresses are discarded.

An over-permissioned key can continue these allowlisted reads: warn on transitions, show REVIEW_REQUIRED/unsafe, keep paper operational, never attempt to modify permissions. Use minimum-permission read/account-only keys with IP restrictions where supported. No future live approval is granted; real execution stays impossible regardless of diagnostic status.

## Account compatibility

Bybit stores only unifiedMarginStatus, marginMode, spotHedgingStatus, updatedTime. Classic account, portfolio margin or enabled spot hedging is INCOMPATIBLE for the current assumptions. Known UTA regular/isolated modes are **UNKNOWN**, not automatically cash-only: account-info cannot prove absence of spot borrowing/liabilities. This deliberate limitation means current Bybit data cannot produce a fully SAFE overall observation summary, and account:check returns nonzero for this uncertainty. Do not add an unapproved endpoint to work around it.

OKX stores accountLevel, positionMode, autoBorrowEnabled and spotBorrowEnabled. COMPATIBLE requires spot level 1, net_mode, and both borrowing flags explicitly false. Other recognized levels/modes or enabled borrowing are INCOMPATIBLE; missing borrowing flags are UNKNOWN. Unrecognized enums/types fail schema. Compatibility is a narrow diagnostic, not a guarantee of fee-currency behavior, fillability, funding availability or trading readiness.

## Fee model and normalization

`AccountFeeSnapshot` contains exchange, BTC/USDT, ACCOUNT_PRIVATE_READ, maker/taker `{rawRate, normalizedCostRate}`, receivedAt and nullable sourceUpdatedAt. Decimal rates must be finite, at most 32 characters and within a conservative absolute 5% bound. No exponent, NaN, empty string or numeric JSON value is accepted.

Bybit uses positive cost rates directly; negative Bybit values are unsupported/fail closed in this baseline rather than assigned unverified rebate semantics. Exact spot category and BTCUSDT symbol are required.

OKX negative maker/taker means commission, positive means rebate. `normalizeOkxFeeRate()` uses cost = -raw numeric rate; zero remains zero. Example: -0.001 -> +0.001 cost; +0.0002 -> -0.0002 rebate. It does not use absolute value. The exact BTC-USDT request must return one applicable feeGroup with maker/taker. Multiple/absent groups fail closed; deprecated top-level rates are not fallback guesses. No extra instruments endpoint is called. Exchange promotions/zero-fee exceptions may not be reflected in this API, so observed fee is not a guarantee of the eventual charged fee.

Bybit envelope time and OKX fee ts are response/return times, not documented fee update timestamps: sourceUpdatedAt stays null. Local receivedAt is recorded after body receipt before parsing.

ACCOUNT_FEE_MODE=diagnostic is the only allowed value. Existing FEES remains authoritative and unchanged. An immutable ObservedFeeConfig is an observation candidate only, never injected into scanner/paper/replay. Fee delta = observed normalized taker cost - configured taker rate. Absolute delta >0.0002 (2 bps) emits FEE_MODEL_MISMATCH; exact-boundary floating-point noise is tolerated. It does not change trade gating. Periodic logs may show fee-model numbers, never real balance amounts.

## Balance and funding reconciliation

PrivateAccountSnapshot retains the Phase 5.0 model: exchange, receivedAt, nullable sourceUpdatedAt, BTC/USDT total and nullable available. Bybit total is walletBalance, not net equity/liabilities; availability is null because the deprecated UNIFIED availability field is not reliable. Its envelope time is not an account update timestamp. OKX uses cashBal, availBal, and account uTime. Missing coins are not assumed zero; unsupported/negative/invalid amounts fail closed. Number is approximate binary floating point, suitable only for diagnostics, not real accounting.

AccountReconciliation compares real total with paper available + reserved and exposes differences, funding booleans and fixed reasons. For TARGET_BTC_SIZE it checks buy USDT and sell BTC per venue. Buy cost uses the existing depth simulation on a valid book no older than 1000 ms, including positive observed taker cost when fresh/healthy; otherwise explicitly marks SIMULATED_FEE_ASSUMED and uses configured fees. Rebates cannot finance upfront purchases. Incomplete depth, missing/stale data, unknown available balance or insufficient availability prevents the corresponding funding boolean. The combined boolean requires both sides funded; it is not permission to trade.

Balance total is never substituted for spendable availability. In particular, Bybit availability null means funding cannot be confirmed even with a large total. This does not claim the account is unfunded. Target means nominal gross BTC; actual fee currency, borrowed assets, liabilities, fee deductions from received BTC, reservations elsewhere and real settlement require a later model.

PrivateAccountSafetySummary combines credential safety, account compatibility, last normalized fee snapshots and reconciliation. Overall is SAFE_FOR_READ_ONLY_OBSERVATION / REVIEW_REQUIRED / UNKNOWN. `readOnlyObservationSafe` is never a live approval. Critical unknown, stale or failed diagnostic reads cannot yield SAFE. Fee mismatch/known unsafe/incompatible data produces review. Funding remains a separate observation and never mutates paper balances or risk state.

## Scheduler, cache and freshness

One serial queue per exchange, at most one in-flight request, at most one pending request per kind. Balance outranks queued diagnostics; diagnostics are FIFO. Start-to-start minimum cadence: balance 10 seconds, config/permissions 5 minutes, fee 5 minutes. OKX config supplies permission and config together without duplicate requests. A 1-second dispatcher enqueues only due work; 500 ms minimum gap between request jobs prevents a burst. A queued balance waits at most the current bounded request/retry plus the gap, not the entire diagnostic queue.

At most one retry after 500 ms for network/timeout, HTTP 5xx/429, Bybit 10006 or OKX 50011. Other schema/auth failures do not retry. Failures still respect each kind's cadence. Stop rejects queued reads and waits for the bounded in-flight read. Per-kind attempt counters and monotonic round-trip durations are not exchange execution latency.

Each cache retains last successful normalized snapshot, last success, category-only error and consecutive failures. Permission/config/fee failures immediately mark that category degraded; five balance failures retain the existing balance-degraded flag. Error warnings occur on first/fifth failure in a streak. No snapshot is erased on a failed refresh.

Independent lastBalanceSuccessAt/lastConfigSuccessAt/lastFeeSuccessAt/lastPermissionSuccessAt are exposed. Balance freshness <=30 seconds; fee/config/permissions <=15 minutes, with nonnegative age required. A retained snapshot may still be age-fresh but degraded after a failed refresh; healthy requires fresh **and** no failed latest attempt. Raw last snapshots remain inspectable in memory, but stale/degraded fees are excluded from current fee diagnostics/funding.

## Operations and privacy

/health exposes only derived safety/compatibility, freshness booleans/ages, category failures and counters/timestamps; no UID, key ID, API key, IP list, KYC region, note, label or financial balance amounts. /metrics includes request stats by kind, fee/inventory deltas and normalized account reconciliation. It is financially sensitive: keep the default loopback bind and restrict access. Normal periodic/final logs exclude balance reconciliation; only safety/freshness and permitted fee diagnostics are logged.

API-key/config metadata is discarded inside pure parsers. Normalized balance/fee/config/permission snapshots live only in the collector, are not attached to the paper engine DTO, and are re-fetched after restart. Checkpoint, journal, event and backup contain no private account snapshots. Headers use private non-enumerable storage; configured secrets are redacted. Error paths never include raw response/cause/header excerpts. Static/runtime tests enforce exactly seven GET paths and reject write references.

Private-read failures, unsafe keys and fee mismatches never block public collection or paper readiness. PRIVATE_READ_ENABLED=false sends no authenticated requests; paper economic behavior and replay determinism remain unchanged. state:check, backup:state, replay, soak and secret:scan do not load credentials or contact private endpoints, including with unusable _FILE paths or PRIVATE_READ_ENABLED=true. Backup copies only app-generated paper recovery files; it cannot detect arbitrary unloaded secrets manually injected into trusted state by an operator.

## Configuration and CLI

Set PRIVATE_READ_ENABLED=true only deliberately with complete credential sets for both exchanges. ACCOUNT_FEE_MODE defaults to diagnostic. No .env auto-loading. _FILE values require regular non-symlink files, 0400/0600 on Unix, outside checkout, DATA_DIR and backup roots.

```sh
export PRIVATE_READ_ENABLED=true
export ACCOUNT_FEE_MODE=diagnostic
export BYBIT_API_KEY_FILE=/secure/bybit-key
export BYBIT_API_SECRET_FILE=/secure/bybit-secret
export OKX_API_KEY_FILE=/secure/okx-key
export OKX_API_SECRET_FILE=/secure/okx-secret
export OKX_API_PASSPHRASE_FILE=/secure/okx-passphrase
npm run build
npm run account:check
```

Corresponding direct environment names are supported but not alongside _FILE; prefer protected mounted/systemd credentials. Never paste secrets into chat or command arguments. See [deployment](VPS_DEPLOYMENT.md) and [security boundary](SECURITY_BOUNDARY.md).

account:check runs all required reads through the same scheduler and prints only balance OK/FAIL, permission/config status/reasons, fee observed/unavailable, derived IP restriction and request counts. No balances, raw fees, identifiers or addresses. Exit is nonzero for unsafe/unknown permissions, failed reads, incompatible/unknown config, or unavailable/stale fees. Bybit's unresolved cash-only semantics currently causes nonzero even with valid credentials. This operator diagnostic does not stop the paper runtime.

Authenticated smoke is optional and requires explicit local opt-in and credentials; no credentials are needed to build, test or replay. If permission is unsafe, report it and do not treat the result as approval to proceed beyond observation.

## Official references audited 2026-09-30

- [Bybit authentication](https://bybit-exchange.github.io/docs/v5/guide#authentication), [balance](https://bybit-exchange.github.io/docs/v5/account/wallet-balance), [API-key information](https://bybit-exchange.github.io/docs/v5/user/apikey-info), [account info](https://bybit-exchange.github.io/docs/v5/account/account-info), [spot fee rate](https://bybit-exchange.github.io/docs/v5/account/fee-rate).
- [OKX account config](https://www.okx.com/docs-v5/en/#trading-account-rest-api-get-account-configuration), [fee rates and sign semantics](https://www.okx.com/docs-v5/en/#trading-account-rest-api-get-fee-rates), [authentication](https://www.okx.com/docs-v5/en/#overview-rest-authentication), [regional documentation](https://app.okx.com/docs-v5/en), [REST domain change](https://www.okx.com/docs-v5/log_en/#2026-05-20).

Phase 5.1 reconciliation is complete. Phase 5.2 adds a separate cache-only shadow observer; see [SHADOW_MODE.md](SHADOW_MODE.md). Paper fees, private polling and real execution restrictions remain unchanged.

## Release validation

- 319 offline tests pass, including 82 private-read tests (43 added in Phase 5.1). Typecheck/build pass; no dependencies added.
- Secret scan: 150 project files, zero heuristic findings. Fake API-key/UID/IP/KYC/note/label metadata is checked against logs, health, metrics, CLI projection, normalized summaries and extracted paper backup.
- Public-only smoke tested absent and dummy credentials with PRIVATE_READ_ENABLED=false: both feeds reached SYNC_HEALTHY/readiness, authenticated counters stayed zero, shutdown and restart recovery were clean.
- State check and backup succeeded on the temporary smoke state with an unusable credential-file path in the environment. Paper fixture replay processed five records; three soak iterations each processed 13,776 records with the same digest as Phase 5.0. These CLI datasets generated no trades at default thresholds; existing fill/partial/unwind tests cover those paths. This is not a long-run soak guarantee.
- Authenticated live smoke skipped: local opt-in was false and complete credential inputs were absent. Actual account permissions, balances and fees were not verified against a live private endpoint.
