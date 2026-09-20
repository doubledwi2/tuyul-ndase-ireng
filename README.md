# tuyul-ndase-ireng

Clock Offset Baseline & Sync Model Correction v0.2.4 adalah corrective hardening Phase 2.3.1 dari project real-time crypto arbitrage scanner. Aplikasi merekonstruksi multi-level order book BTC/USDT, mensimulasikan hypothetical taker execution, lalu menilai economics, timing health, dan kualitas candidate secara terpisah.

Aplikasi ini tidak memakai API key atau autentikasi dan tidak melakukan trading maupun order execution. Istilah executable dan qualified hanya menggambarkan hasil simulasi serta kualitas observasi, bukan jaminan real fill. Persistence hanya berupa file JSONL lokal; tidak ada database.

## Data source

- Bybit Public WebSocket V5 Spot: `wss://stream.bybit.com/v5/public/spot`
  - Topic: `orderbook.50.BTCUSDT`
- OKX Public WebSocket: `wss://ws.okx.com:8443/ws/v5/public`
  - Channel: `books`, instrument: `BTC-USDT`

Bybit depth 50 menyediakan snapshot awal lalu delta public sekitar setiap 20 ms. OKX `books` menyediakan snapshot 400 level lalu incremental update public sekitar setiap 100 ms tanpa login. Channel OKX `books50-l2-tbt` tidak dipakai karena dokumentasi terbaru mensyaratkan login dan VIP4. State OKX direkonstruksi hingga depth yang diterima, lalu hanya top 50 per sisi dinormalisasi untuk pipeline dan dataset.

Pada kedua adapter, snapshot mengganti local book. Delta mengubah atau menambah price level, sedangkan size nol menghapus level. OKX memverifikasi continuity dengan `seqId/prevSeqId`; sequence gap memicu reconnect agar snapshot baru diperoleh. Checksum OKX tidak digunakan karena sudah deprecated. Hasil normalized selalu memiliki bid descending, ask ascending, nilai finite positif, dan tidak crossed.

Output terminal dibatasi sekitar satu kali setiap 500 ms agar tetap mudah dibaca, tanpa mengubah timestamp asli ketika message diterima.

## Normalized order book, quote, dan timestamp

Model `NormalizedOrderBook` dan `BestQuote` membawa empat timestamp:

- `exchangeTimestamp`: timestamp update yang dikirim exchange.
- `matchingEngineTimestamp`: waktu matching engine menghasilkan order book, jika feed menyediakannya.
- `receivedTimestamp`: `Date.now()` yang diambil segera saat message diterima, sebelum parsing.
- `receivedMonotonicMs`: `performance.now()` yang diambil saat penerimaan untuk interval lokal yang tahan terhadap perubahan wall clock.

Bybit menyediakan `ts` sebagai `exchangeTimestamp` dan `cts` sebagai `matchingEngineTimestamp`. Pada OKX `books`, `ts` dipakai sebagai `exchangeTimestamp`; feed ini tidak mendefinisikannya sebagai matching-engine timestamp yang ekuivalen dengan Bybit `cts`, sehingga `matchingEngineTimestamp` diisi `null`.

`matchingEngineTimestamp` tetap nullable; collector tidak membuat timestamp pengganti. Field `receivedMonotonicMs` juga nullable/optional agar dataset lama tetap dapat direplay tanpa mengarang monotonic timestamp historis.

## Depth simulation dan fee-aware comparison

Pipeline memakai latest valid order book dari kedua exchange dan mensimulasikan dua arah:

- Buy Bybit pada ask, lalu sell OKX pada bid.
- Buy OKX pada ask, lalu sell Bybit pada bid.

Ukuran simulasi baseline disimpan di `src/config/simulation.ts`:

```text
TARGET_BTC_SIZE = 0.01 BTC
```

Nilai tersebut hanya baseline engineering untuk hypothetical execution, bukan rekomendasi ukuran trading. BUY mengonsumsi ask dari harga terendah ke tertinggi; SELL mengonsumsi bid dari harga tertinggi ke terendah. Jika size tersedia, execution price dihitung sebagai volume-weighted average price:

```text
VWAP = sum(fillSize * levelPrice) / sum(fillSize)
slippageAbsolute = VWAP - bestPrice
slippagePercent = (slippageAbsolute / bestPrice) * 100
```

Dengan definisi tersebut, BUY slippage biasanya positif dan SELL slippage biasanya negatif. Best price hanya harga level pertama; VWAP mencerminkan seluruh level yang benar-benar dikonsumsi oleh target size.

Baseline Spot taker fee disimpan eksplisit di `src/config/fees.ts` sebagai decimal fraction:

- Bybit: `0.001` atau 0.10%.
- OKX: `0.001` atau 0.10%.

Fee aktual dapat berbeda menurut VIP tier, region, promotion, dan rate khusus account. Config ini adalah baseline engineering, bukan klaim rate yang berlaku untuk semua account.

Jika kedua leg fully filled, model memakai simulated notional aktual:

```text
simulatedBuyNotional = sum(BUY fillSize * fillPrice)
simulatedSellNotional = sum(SELL fillSize * fillPrice)
estimatedBuyFee = simulatedBuyNotional * buyTakerRate
estimatedSellFee = simulatedSellNotional * sellTakerRate
estimatedTotalFee = estimatedBuyFee + estimatedSellFee
grossPnlAbsolute = simulatedSellNotional - simulatedBuyNotional
estimatedNetPnlAbsolute = grossPnlAbsolute - estimatedTotalFee
estimatedNetSpreadPercent = (estimatedNetPnlAbsolute / simulatedBuyNotional) * 100
```

Status depth comparison:

- `EXECUTABLE_NET_POSITIVE`: kedua leg fully filled dan estimated net PnL positif.
- `EXECUTABLE_NET_ZERO_OR_NEGATIVE`: kedua leg fully filled tetapi estimated net PnL tidak positif.
- `INSUFFICIENT_DEPTH`: salah satu leg tidak dapat memenuhi `TARGET_BTC_SIZE`.

Economics status tidak lagi diubah menjadi `STALE` oleh comparator order-book. Timing validity dinilai secara terpisah oleh `SyncAssessment`. Field/status lama tetap dipertahankan hanya untuk compatibility jalur replay `BestQuote`.

Istilah executable hanya berarti snapshot order book secara teoritis cukup untuk target size. Ini bukan jaminan real fill: market dapat berubah antara observasi dan kedatangan order, dan aplikasi tidak mengirim order apa pun.

## Timing dan synchronization model

Wall clock dan monotonic clock mempunyai fungsi berbeda:

- `Date.now()` kompatibel dengan epoch timestamp exchange dan digunakan untuk source diagnostics/book age.
- `performance.now()` monotonic dan digunakan untuk local processing interval.

`observedIngressMs = receivedTimestamp - exchangeTimestamp` sengaja tidak disebut one-way network latency. Nilai ini juga mengandung clock offset antara host dan exchange, processing/publishing delay exchange, serta transport delay. Nilai raw, termasuk yang negatif, tidak di-clamp. Nilai negatif yang stabil dapat terjadi karena offset antara source clock dan host clock; nilai negatif saja bukan timing error.

Definisi yang tidak dicampur:

- **Receive skew**: selisih wall-clock ketika dua latest book diterima host.
- **Observed ingress delay**: selisih source/exchange timestamp dengan local receive timestamp; bukan pure network latency.
- **Processing duration**: interval monotonic dari message diterima hingga comparison selesai.
- **Book age**: usia latest local book ketika comparison dibuat.

Baseline di `src/config/timing.ts`:

```text
MAX_RECEIVE_SKEW_MS = 100
MAX_BOOK_AGE_MS = 500
MAX_SOURCE_TIMESTAMP_SKEW_MS = 250
CLOCK_JUMP_THRESHOLD_MS = 50
MIN_OFFSET_SAMPLES = 30
OFFSET_WINDOW_SIZE = 200
MAX_OFFSET_DEVIATION_MS = 100
```

Estimator terpisah untuk Bybit dan OKX menyimpan 200 observed-ingress terbaru dan memakai rolling median sebagai baseline setelah warm-up 30 sampel. `observedIngressDeviationMs` adalah raw observed ingress dikurangi baseline tersebut. Sebelum warm-up selesai statusnya `WARMING_UP`; deviasi absolut di atas 100 ms menjadi `DEVIATION_HIGH`. Rolling median ini hanya offset diagnostic yang robust terhadap spike—bukan koreksi network latency, bukan kompensasi timestamp, dan tidak mengubah timestamp exchange.

`SYNC_HEALTHY` memerlukan host clock tidak berstatus `CLOCK_JUMP_DETECTED`, estimator source yang tersedia sudah stable, receive skew dan book age di bawah batas, source timestamp skew di bawah batas jika kedua exchange menyediakannya, tidak ada source-offset deviation tinggi, serta tidak ada self-consistency anomaly seperti negative local book age atau timestamp non-finite. Raw source-vs-host offset negatif tidak termasuk anomaly.

Primary sync status adalah `SYNC_HEALTHY`, `SYNC_WARMING_UP`, `SOURCE_OFFSET_DEVIATION_HIGH`, `RECEIVE_SKEW_HIGH`, `SOURCE_SKEW_HIGH`, `BOOK_TOO_OLD`, `CLOCK_UNHEALTHY`, atau `TIMESTAMP_ANOMALY`. Array `reasons` mempertahankan seluruh kegagalan sekaligus. Jika source timestamp tidak tersedia, estimator melaporkan `UNAVAILABLE` tanpa mengarang nilai. Cross-exchange source skew tetap merupakan sanity check antar-source clock, bukan bukti sinkronisasi absolut. Karena OKX `books` tidak menyediakan matching-engine timestamp ekuivalen Bybit `cts`, `matchingEngineSkewMs` tetap `null`.

`ClockHealthMonitor` membandingkan `wallDelta - monotonicDelta`. Sampel pertama `WARMING_UP`; drift mendadak di atas 50 ms menjadi `CLOCK_JUMP_DETECTED`. Local clock-jump detection ini terpisah dari source-vs-host offset estimator. Keduanya hanya mendeteksi dan melaporkan—tidak mengubah clock OS, exchange timestamp, atau economic ordering. Infrastruktur VPS/NTP/chrony yang lebih ketat berada di roadmap Phase 4.

## Opportunity quality filter

`EXECUTABLE_NET_POSITIVE` tidak sama dengan `QUALIFIED`. Status pertama hanya berarti depth cukup, sync dasar lolos, dan estimated net PnL positif. Satu observation menjadi quality-valid candidate hanya jika seluruh baseline berikut terpenuhi:

```text
MIN_NET_SPREAD_PERCENT = 0.03%
MIN_NET_PNL_USDT = 0.01 USDT
MIN_ACTIVE_DURATION_MS = 100 ms
```

Threshold economics/duration berada di `src/config/opportunity.ts`; timing threshold berada di `src/config/timing.ts`. Semuanya injectable dan merupakan baseline engineering—bukan rekomendasi trading. Field `MAX_SYNC_DIFF_MS_FOR_QUALIFIED` lama dipertahankan untuk compatibility quote replay, tetapi pipeline order-book sekarang wajib memakai `SyncAssessment.status === SYNC_HEALTHY`.

`QUALIFIED` berarti kedua leg fully filled dalam simulasi, estimated net positif, melewati minimum spread dan PnL, mempunyai `SYNC_HEALTHY`, serta mempertahankan seluruh kondisi itu minimal 100 ms. Market tetap dapat berubah sebelum hypothetical order tiba, sehingga status ini bukan jaminan actual execution.

## Opportunity event lifecycle

Mulai Phase 2.2, candidate event hanya dibuat dari observation yang lolos seluruh quality rule statis. Best-price spread yang terlihat positif tetapi gagal setelah VWAP, fee, threshold, atau sync quality tetap ditampilkan dengan rejection reason, tetapi tidak membuat `OpportunityEvent`.

Setiap arah mempunyai event independen dengan key seperti `BTC/USDT:bybit->okx`. Event ID yang sama dipertahankan sepanjang satu lifecycle agar candidate dapat dilacak dari awal sampai berakhir. Setelah event `DISAPPEARED`, kemunculan baru pada arah yang sama mendapat ID baru.

Lifecycle memakai timestamp yang diinjeksi dan tidak memakai sleep/timer di business logic:

```text
observasi quality-valid pertama                DETECTED
observasi berikut sebelum minimum duration     VALIDATING
quality-valid selama minimal 100 ms            QUALIFIED
quality failure biasa                          DISAPPEARED
SyncAssessment tidak healthy                   INVALID_SYNC
```

Data stale tidak membuat event baru. Jika event hidup menjadi stale, state berubah menjadi `INVALID_SYNC`. Saat data pulih dan seluruh rule kembali lolos, validation window dimulai ulang dari `DETECTED` dengan event ID yang sama agar interval stale tidak dihitung sebagai active duration. Jika event belum pernah qualified, `detectedAt` juga di-reset; history qualification pertama pada event yang sudah pernah qualified tetap dipertahankan.

Event menyimpan `qualifiedAt`, `timeToQualifiedMs`, `everQualified`, `currentQualificationReasons`, current receive/source skew, max book age, sync status/reasons, dan peak receive skew. Sync unhealthy bersifat `INVALID_SYNC`, bukan economic disappearance. Recovery me-reset validation duration window.

## Raw market recording

Dalam live mode, setiap normalized top-50 order book state yang benar-benar dipakai pipeline disimpan append-only ke:

```text
data/orderbooks.jsonl
```

Satu baris berisi `{ "recordedAt": number, "orderBook": NormalizedOrderBook }`. Dataset menyimpan state normalized yang sudah sorted, bukan raw WebSocket payload atau internal map. Karena setiap record merupakan state lengkap yang dipakai downstream, replay tidak perlu menebak ulang delta exchange.

Untuk compatibility, derived `BestQuote` juga tetap disimpan ke:

```text
data/market-quotes.jsonl
```

Satu baris berisi satu object JSON dengan format:

```json
{"recordedAt": 1700000000001, "quote": {"exchange": "bybit", "symbol": "BTC/USDT", "bid": 60000, "bidSize": 1.2, "ask": 60001, "askSize": 0.8, "exchangeTimestamp": 1700000000000, "matchingEngineTimestamp": 1699999999999, "receivedTimestamp": 1700000000000, "receivedMonotonicMs": 12345.67}}
```

Format `market-quotes.jsonl` lama tidak berubah. Write kedua recorder diserialisasi untuk menjaga urutan, dan shutdown menunggu seluruh write yang masih pending.

## Event recording

Setiap perubahan state event disimpan secara append-only ke:

```text
data/opportunity-events.jsonl
```

Format yang digunakan adalah JSON Lines: setiap baris merupakan satu object JSON valid berisi `recordedAt` dan snapshot lengkap `OpportunityEvent`. Urutan write diserialisasi agar sama dengan urutan event diterima. Record final `DISAPPEARED` menyimpan `endedAt`, `lifetimeMs`, peak gross dan estimated net values, peak tradable size, serta flag historis.

File runtime JSONL di bawah `data/` diabaikan Git. Jika penulisan gagal, recorder melaporkan error singkat tanpa menghentikan market feed atau comparator. Saat shutdown, aplikasi menunggu seluruh antrean write selesai sebelum keluar.

## Replay

Order book dataset dapat diputar melalui depth pipeline yang sama tanpa membuat koneksi WebSocket:

```bash
npm run replay:book -- --file data/orderbooks.jsonl --speed max
```

Threshold quality dapat di-override untuk scenario testing:

```bash
npm run replay:book -- \
  --file data/orderbooks.jsonl \
  --speed max \
  --min-net-spread 0.02 \
  --min-net-pnl 0.01 \
  --min-duration 50 \
  --max-receive-skew 100 \
  --max-book-age 500 \
  --max-source-skew 250 \
  --min-offset-samples 30 \
  --offset-window-size 200 \
  --max-offset-deviation 100
```

Override tidak mengubah raw dataset dan tidak otomatis diturunkan untuk memaksa munculnya event.

Replay `BestQuote` lama tetap tersedia:

```bash
npm run replay -- --file data/market-quotes.jsonl --speed max
```

Pilihan speed:

- `realtime`: memakai jeda `recordedAt` asli antar-record.
- `fast`: mempercepat jeda sekitar 10x.
- `max`: tanpa artificial delay, tetapi urutan file tetap dipertahankan.

Default speed adalah `max`. Default input `replay:book` adalah `data/orderbooks.jsonl`, sedangkan replay lama memakai `data/market-quotes.jsonl`. Scheduling memakai `recordedAt`, bukan exchange timestamp, agar arrival sequence lokal dapat direproduksi. Blank line dilewati; record malformed atau invalid diberi warning dan dilewati tanpa menghentikan seluruh replay.

Live dan order book replay memanggil `MarketPipeline.processOrderBook()` yang sama. Waktu logis replay menggunakan `recordedAt`, bukan `Date.now()`. Source-offset baseline hanya bergantung pada timestamp dan urutan record. Replay juga menginjeksi deterministic `HEALTHY` clock status dan tidak memakai clock health laptop saat replay, sehingga speed/NTP adjustment tidak mengubah decision. Replay processing duration tidak dicampur dengan live metrics dan bernilai `N/A`. UUID event boleh berbeda antar-run.

Replay tidak menghubungi Bybit/OKX dan tidak menulis kembali ke raw dataset. Setiap run memakai output unik berbentuk `data/replays/<timestamp>-<short-id>/opportunity-events.jsonl`, sehingga hasil antar-run dan live event tidak tercampur. Path aktual dicetak pada akhir replay. Jika tidak ada event, file tersebut tidak perlu dibuat. Event yang masih terbuka dilaporkan jumlahnya dan tidak dipaksa menjadi `DISAPPEARED`.

Raw order book dan quote input tidak pernah ditulis ulang saat replay. Fee, target size, dan economics dihitung downstream, sehingga dataset order book yang sama dapat diuji ulang dengan config berbeda. Replay quote lama tetap top-of-book-only; gunakan `replay:book` untuk hasil Phase 2.1.

## Opportunity metrics

Session metrics comparison depth mencakup:

- Total comparison.
- Count `INSUFFICIENT_DEPTH`.
- Count `EXECUTABLE_NET_POSITIVE`.
- Count `EXECUTABLE_NET_ZERO_OR_NEGATIVE`.
- Average BUY dan SELL slippage percent.
- Total executable net-positive dan quality-qualified comparisons.
- Total rejection serta breakdown `NOT_NET_POSITIVE`, small net spread, small net PnL, wide sync, insufficient depth, dan stale.
- Observed ingress Bybit/OKX: average, P50, P95, P99, maksimum.
- Final rolling-median observed-ingress baseline per exchange.
- Absolute offset deviation Bybit/OKX: P50, P95, P99, maksimum.
- Receive skew: average, P50, P95, P99, maksimum.
- Source timestamp skew: average, P95, P99.
- Max book age: P50, P95, P99.
- Live monotonic processing duration: average, P50, P95, P99, maksimum.
- Count sync healthy, source-clock warm-up/deviation tinggi, receive/source skew high, book too old, clock unhealthy, dan timestamp anomaly.

Metrics hanya menghitung completed event dengan state final `DISAPPEARED`:

- `eventsEverActive`: completed event yang pernah mencapai `ACTIVE`.
- `eventsNeverActive`: completed event yang tidak pernah mencapai `ACTIVE`.
- `invalidSyncEvents`: completed event yang pernah memasuki `INVALID_SYNC`.
- `eventsEverQualified` dan `eventsNeverQualified`.
- Average, P50, dan P95 time-to-qualified.
- Average, minimum, maksimum, P50, P95, dan P99 lifetime.
- Average dan maksimum peak gross spread percent.
- Average dan maksimum peak estimated net spread percent.
- Average dan maksimum peak estimated net PnL absolute.
- Average dan maksimum peak tradable size.

Field `everActive` dan `everInvalidSync` disimpan pada setiap snapshot dan dibawa sampai final event; history tidak ditebak dari final state. Percentile menggunakan metode **nearest-rank** pada lifetime yang diurutkan ascending: rank = `ceil(percentile / 100 * jumlah sample)`.

Summary metrics dicetak setiap 60 detik dan aman saat belum ada completed event. Comparison count tidak dicampur dengan completed-event count. Metrics masih in-memory dan reset saat aplikasi restart. Nilai net berasal dari simulasi multi-level depth dan tetap bukan realized profit.

## Requirements

- Node.js 20 atau lebih baru
- npm
- Koneksi internet yang dapat mengakses endpoint WebSocket Bybit dan OKX

## Install

```bash
npm install
```

## Development

```bash
npm run dev
```

Hentikan aplikasi dengan `Ctrl+C`. Handler `SIGINT` dan `SIGTERM` akan menutup koneksi WebSocket.

Pada live mode:

- Normalized order book states: `data/orderbooks.jsonl`
- Raw normalized quote: `data/market-quotes.jsonl`
- Opportunity state changes: `data/opportunity-events.jsonl`

## Typecheck dan build

```bash
npm run typecheck
npm run build
```

## Unit test

```bash
npm test
```

## Menjalankan hasil build

```bash
npm start
```

File JavaScript hasil build berada di folder `dist/`.

## Roadmap status

- Phase 1: complete.
- Phase 2.0 fee-aware model: complete.
- Phase 2.1 depth/slippage: complete.
- Phase 2.2 opportunity quality: complete.
- Phase 2.3 latency, clock health, dan synchronization: complete.
- Phase 2.3.1 clock-offset baseline correction: complete/current.

## Scope Phase 2.3.1

Scope versi ini terbatas pada timing diagnostics, clock-jump detection, explicit synchronization assessment, public multi-level order book, hypothetical execution, quality filtering, replay, dan metrics. Tidak ada ping/RTT palsu, timestamp compensation, real order execution, balance, transfer, private API, database, dashboard, atau paper trading.
