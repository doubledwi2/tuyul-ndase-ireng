# Phase 5.0: authenticated account reads, never real execution

Public WebSocket adapters are unchanged. The separate `src/private-read/` clients support exactly:

| Exchange | Method and fixed request | Authentication |
| --- | --- | --- |
| Bybit | GET `/v5/account/wallet-balance?accountType=UNIFIED&coin=BTC,USDT` | HMAC-SHA256, lowercase hex; timestamp + API key + receive window 5000 + exact query |
| OKX | GET `/api/v5/account/balance?ccy=BTC,USDT` | HMAC-SHA256, base64; ISO UTC timestamp + GET + exact path/query; key and passphrase headers |

No other path, arbitrary signing input, request body, mutable HTTP method, private WebSocket, real order submission/cancellation/amendment, transfer or withdrawal is implemented. Bybit system-generated HMAC keys only; RSA keys are unsupported. Signing lives separately from the transport. The immutable capability registry permits publicMarketData/privateRead, never privateTrade/withdrawal. The live execution adapter still throws on **every** method, including order status. `REAL_EXECUTION_ENABLED=true` still fails startup; turning the kill switch off cannot enable real execution.

## Official documentation audit

Audited 2026-09-30: [Bybit V5 authentication](https://bybit-exchange.github.io/docs/v5/guide#authentication), [wallet balance](https://bybit-exchange.github.io/docs/v5/account/wallet-balance), [OKX REST authentication](https://www.okx.com/docs-v5/en/#overview-rest-authentication), [OKX account balance](https://www.okx.com/docs-v5/en/#trading-account-rest-api-get-balance), and [OKX REST domain announcement](https://www.okx.com/docs-v5/log_en/#2026-05-20).

`BYBIT_API_BASE_URL` defaults to `https://api.bybit.com`. Supported hosts: `api.bybit.com`, `api.bytick.com`, `api-testnet.bybit.com`. Other Bybit regional domains are deliberately not supported in this release: do not use a global host to circumvent account/geographic restrictions. Testnet needs a matching testnet key; it still only reads balances.

`OKX_API_BASE_URL` defaults to `https://openapi.okx.com` for a **global account assumption**, not for every account. Allowed hosts: `openapi.okx.com`, `www.okx.com`, `us.okx.com`, `eea.okx.com`, `tr.okx.com`. OKX recommends openapi for global REST; www remains supported. US/Australia accounts registered through app.okx.com require us.okx.com; EU accounts registered through my.okx.com require eea.okx.com. Türkiye operators must use the matching regional account documentation/domain. No automatic region fallback or credential forwarding between domains. OKX demo/simulated-account mode is not implemented.

Only exact HTTPS origins (optional trailing slash) are accepted. Credentials/userinfo, explicit ports, extra paths, encoded paths, query, fragment, whitespace, localhost and custom hosts fail closed. The transport checks the final exact URL again before accessing headers. Redirect following is disabled (`redirect: 'error'`).

## Opt in and minimum permission

Default `PRIVATE_READ_ENABLED=false` causes **zero authenticated requests**, even with configured keys. Enable only deliberately with complete credentials for both exchanges. Partial sets, missing sets when enabled, invalid booleans and ambiguous direct/FILE values fail startup. No automatic .env loading; use a protected service environment. This example contains paths only:

```sh
export PRIVATE_READ_ENABLED=true
export BYBIT_API_KEY_FILE=/secure/bybit-key
export BYBIT_API_SECRET_FILE=/secure/bybit-secret
export OKX_API_KEY_FILE=/secure/okx-key
export OKX_API_SECRET_FILE=/secure/okx-secret
export OKX_API_PASSPHRASE_FILE=/secure/okx-passphrase
npm run build
npm run account:check
```

Files must be regular, not symlinks, with 0400/0600 permissions on Unix. Keep files outside checkout, DATA_DIR and backup directories. Direct variables with the corresponding base names are supported but inherited by child processes. Prefer `_FILE`/systemd credentials. See [deployment](VPS_DEPLOYMENT.md).

Create minimum-permission **read/account-access-only** keys; do not grant trade or withdraw. Use exchange IP restrictions when available. Bybit keys must use the read-only setting; OKX requires Read permission. A successful balance response **does not prove** the key lacks trading/withdrawal permission. Operator configuration is still required. Never paste keys into chat, shell arguments, screenshots, source or logs. `account:check` shows currency read status and snapshot age, not amounts, headers or raw account JSON; failures exit nonzero with sanitized categories.

## Normalized memory-only data

`PrivateAccountSnapshot` contains exchange, local `receivedAt`, `sourceUpdatedAt: number|null`, BTC and USDT `{total, available:number|null}`, optional `rawAccountType`. `RealInventorySnapshot` maps these by exchange. No entire raw response enters a business object.

Bybit total is per-coin `walletBalance`, **not net equity after liabilities**; updated UTA borrow semantics apply. Availability is null because UNIFIED `availableToWithdraw` is deprecated and a dependable per-coin spendable value is not provided by this endpoint. Source update time is null: envelope `time` is server response time, not balance update time. OKX total is `cashBal`, availability is `availBal` (null if unavailable/empty), and source update is account `uTime` when present. These are account-scope observations, not funding-wallet inventory, order buying power, or an accounting equivalence across margin modes.

Both requested coins must be explicitly returned. Missing requested coins fail SCHEMA; **absence is not silently zero**, including when the exchange omits empty accounts. Explicit zero is valid. Unrelated coins are ignored; duplicates, wrong success codes, malformed schema, non-string amounts, negative amounts and non-finite values are rejected. Accounts with negative cash balances require a future liability-aware model rather than coercion. Decimal strings have at most 64 characters, no exponent syntax; BTC <=21 million, USDT <=1 trillion. These conservative engineering bounds reject unsupported values. JavaScript Number is approximate binary floating point: this is a diagnostic model, not settlement/real-order accounting. `receivedAt` is captured after body receipt, before JSON parsing, never copied from source time.

## Polling, faults and readiness

One poll per client no more frequently than 10,000 ms, guarded by monotonic time and an in-flight lock. Periodic polls wait 10,000 ms **after** the prior cycle completes. Timeout is 3,000 ms per attempt including body receipt; response body limit is 1 MiB even without Content-Length. Content-Type must be application/json; malformed JSON is rejected without payload excerpts. At most one retry with deterministic 500 ms delay for network/timeout, HTTP 5xx/429 or recognized exchange rate-limit codes (Bybit 10006 / OKX 50011). Other exchange/auth/schema failures do not retry. Each retry gets a fresh signature. Stop prevents new reads/retries and waits for the bounded in-flight request.

Clients are independent. Collector retains last snapshot, last success, categorized last error and consecutive failures in memory. Five consecutive failed poll cycles marks DEGRADED; polling continues, success clears the count. Warn only on first/fifth failure of a streak. Healthy requires the latest poll to succeed and success age <=20 seconds. Separate `privateRead.diagnosticReady` requires both healthy; this is **not** permission to execute. Private failures never gate paper readiness, balances or decisions. Default-disabled paper behavior is unchanged.

`/health` adds privateRead enabled/configured/healthy/last-success/degraded flags without amounts. `/metrics` adds per-exchange request/success/failure/timeout/rate-limit counts and `lastPrivateReadLatencyMs` (monotonic request round-trip, including local parsing; **not one-way exchange latency**). Counts are per attempt; collector failure streaks are per poll. The poll guard is local and does not count as exchange rate limiting.

`/metrics` also exposes **diagnostic only** real-minus-paper inventory differences for each exchange's BTC/USDT, comparing real total against paper available + reserved. Missing snapshots yield null; observed timestamps and health disclose freshness. These differences can reveal financial information: protect the default loopback metrics endpoint and do not publicly expose it. They are excluded from periodic/final log summaries, checkpoint, journal, paper events and backups. Last observed differences can remain visible during failures; consult health/freshness before interpretation. No real value ever overwrites paper inventory.

## Secret and offline boundaries

Secret wrappers redact JSON/inspect; signer access is explicit through a callback. Signed headers have private non-enumerable storage and short lifetimes (no unbounded signature registry). Native transport errors, response bodies and headers never propagate to logs. Failure logs include only exchange, category and HTTP status. No request-id collection or raw response logging.

`state:check`, `backup:state`, replay, soak and secret:scan **never load private credentials or contact authenticated services**, even with unusable `_FILE` paths or PRIVATE_READ_ENABLED=true. Backup copies only paper recovery files, not private account files, arbitrary DATA_DIR files, environment or credentials. Secrets/real balances never enter the engine DTO. Offline backup cannot discover arbitrary secrets manually injected into trusted state files without loading credentials; keep recovery files operator-protected and use only app-generated state.

Tests use fake fixtures/mock transport, fixed fake HMAC vectors, timeout/size/content-type/redirect/URL guards, retry/rate guards, collector degradation/recovery, and inspection of logs/health/metrics/checkpoint/journal/extracted backup. No network is needed. Real authenticated smoke is optional and must be skipped when not explicitly enabled with local credentials; no credentials are required to build, test or replay.

## Validation for this release

- 276 offline tests pass (39 new private-read tests); typecheck and build pass. No dependencies added.
- Secret scan: 144 project text files, zero heuristic findings.
- Public smoke: `npm run paper` and built runtime both reached SYNC_HEALTHY and ready, with clean SIGTERM shutdown/recovery. Tested absent and dummy credentials with PRIVATE_READ_ENABLED=false; authenticated request counts stayed zero.
- State check and backup passed on temporary smoke state while private read was enabled in the environment and a credential file path was deliberately unusable; neither tool loaded it.
- Paper fixture replay processed five records. Three soak iterations each processed 13,776 records with identical digest; default thresholds generated zero trades in these datasets. Fill/partial/unwind scenarios are covered separately by existing unit tests. This short soak is not a long-run guarantee.
- Authenticated live account check skipped: local opt-in was false and complete credential inputs were absent. Disabled CLI correctly refused with exit code 1; no real balance/permission verification is claimed.
