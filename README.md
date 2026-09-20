# tuyul-ndase-ireng

Order Book Depth + Slippage Simulation v0.2.1 adalah Phase 2.1 dari project real-time crypto arbitrage scanner. Aplikasi merekonstruksi multi-level order book BTC/USDT dari Bybit Spot dan OKX Spot, mensimulasikan hypothetical taker execution, lalu menghitung estimated net result berdasarkan VWAP dan fee.

Aplikasi ini tidak memakai API key atau autentikasi, tidak menentukan peluang yang executable, dan tidak melakukan trading maupun order execution. Persistence hanya berupa file JSONL lokal untuk normalized market quote serta perubahan state opportunity; tidak ada database.

## Data source

- Bybit Public WebSocket V5 Spot: `wss://stream.bybit.com/v5/public/spot`
  - Topic: `orderbook.50.BTCUSDT`
- OKX Public WebSocket: `wss://ws.okx.com:8443/ws/v5/public`
  - Channel: `books`, instrument: `BTC-USDT`

Bybit depth 50 menyediakan snapshot awal lalu delta public sekitar setiap 20 ms. OKX `books` menyediakan snapshot 400 level lalu incremental update public sekitar setiap 100 ms tanpa login. Channel OKX `books50-l2-tbt` tidak dipakai karena dokumentasi terbaru mensyaratkan login dan VIP4. State OKX direkonstruksi hingga depth yang diterima, lalu hanya top 50 per sisi dinormalisasi untuk pipeline dan dataset.

Pada kedua adapter, snapshot mengganti local book. Delta mengubah atau menambah price level, sedangkan size nol menghapus level. OKX memverifikasi continuity dengan `seqId/prevSeqId`; sequence gap memicu reconnect agar snapshot baru diperoleh. Checksum OKX tidak digunakan karena sudah deprecated. Hasil normalized selalu memiliki bid descending, ask ascending, nilai finite positif, dan tidak crossed.

Output terminal dibatasi sekitar satu kali setiap 500 ms agar tetap mudah dibaca, tanpa mengubah timestamp asli ketika message diterima.

## Normalized order book, quote, dan timestamp

Model `NormalizedOrderBook` berisi array `bids` dan `asks` dengan pasangan numeric `price`/`size`, ditambah tiga timestamp:

- `exchangeTimestamp`: timestamp update yang dikirim exchange.
- `matchingEngineTimestamp`: waktu matching engine menghasilkan order book, jika feed menyediakannya.
- `receivedTimestamp`: `Date.now()` yang diambil segera saat message diterima, sebelum parsing.

Bybit menyediakan `ts` sebagai `exchangeTimestamp` dan `cts` sebagai `matchingEngineTimestamp`. Pada OKX `books`, `ts` dipakai sebagai `exchangeTimestamp`; feed ini tidak mendefinisikannya sebagai matching-engine timestamp yang ekuivalen dengan Bybit `cts`, sehingga `matchingEngineTimestamp` diisi `null`.

`matchingEngineTimestamp` tetap nullable; collector tidak membuat timestamp pengganti. `BestQuote` tetap dipertahankan dan diturunkan dari level pertama normalized book untuk compatibility serta replay dataset lama.

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

- `EXECUTABLE_NET_POSITIVE`: sync valid, kedua leg fully filled, estimated net PnL positif.
- `EXECUTABLE_NET_ZERO_OR_NEGATIVE`: sync valid, kedua leg fully filled, estimated net PnL tidak positif.
- `INSUFFICIENT_DEPTH`: salah satu leg tidak dapat memenuhi `TARGET_BTC_SIZE`.
- `STALE`: comparison tidak memenuhi baseline synchronization.

Istilah executable hanya berarti snapshot order book secara teoritis cukup untuk target size. Ini bukan jaminan real fill: market dapat berubah antara observasi dan kedatangan order, dan aplikasi tidak mengirim order apa pun.

### Baseline synchronization

Comparator memakai `receivedTimestamp` sebagai safety check awal:

- Selisih waktu penerimaan maksimum: `250 ms`.
- Usia quote maksimum saat comparison dibuat: `1000 ms`.
- Comparison berstatus `SYNC_OK` hanya jika kedua syarat terpenuhi; selain itu `STALE`.

Threshold tersebut hanya baseline engineering awal untuk mendeteksi quote yang terlalu jauh waktunya. `SYNC_OK` bukan jaminan opportunity valid atau executable dan bukan batas ideal untuk trading.

## Opportunity event lifecycle

Mulai Phase 2.1, candidate opportunity hanya dibuat untuk status `EXECUTABLE_NET_POSITIVE`. Best-price spread yang terlihat positif tetapi berubah non-positive setelah VWAP dan fee tetap ditampilkan, tetapi tidak membuat `OpportunityEvent`.

Setiap arah mempunyai event independen dengan key seperti `BTC/USDT:bybit->okx`. Event ID yang sama dipertahankan sepanjang satu lifecycle agar candidate dapat dilacak dari awal sampai berakhir. Setelah event `DISAPPEARED`, kemunculan baru pada arah yang sama mendapat ID baru.

Untuk simulated executable net-positive comparison, state dipromosikan berdasarkan observasi valid berturut-turut tanpa timer tambahan:

```text
observasi valid #1  DETECTED
observasi valid #2  VALIDATING
observasi valid #3+ ACTIVE
net <= 0/depth kurang  DISAPPEARED
```

Data stale tidak membuat event baru. Jika event yang sudah hidup kemudian menjadi stale, state berubah menjadi `INVALID_SYNC`. Saat data kembali `SYNC_OK` dan estimated net kembali positif, urutan observasi valid dimulai lagi dari `DETECTED` dengan event ID yang sama.

Selama event hidup, collector memperbarui current dan peak gross spread, estimated net spread, estimated net PnL, estimated total fee, serta peak tradable size. Peak memakai maksimum dan tidak menjumlahkan observasi antar-tick. Lifetime baru dihitung ketika event menjadi `DISAPPEARED`. State `ACTIVE` tetap bukan jaminan bahwa candidate executable atau profitable.

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
{"recordedAt": 1700000000001, "quote": {"exchange": "bybit", "symbol": "BTC/USDT", "bid": 60000, "bidSize": 1.2, "ask": 60001, "askSize": 0.8, "exchangeTimestamp": 1700000000000, "matchingEngineTimestamp": 1699999999999, "receivedTimestamp": 1700000000000}}
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

Replay `BestQuote` lama tetap tersedia:

```bash
npm run replay -- --file data/market-quotes.jsonl --speed max
```

Pilihan speed:

- `realtime`: memakai jeda `recordedAt` asli antar-record.
- `fast`: mempercepat jeda sekitar 10x.
- `max`: tanpa artificial delay, tetapi urutan file tetap dipertahankan.

Default speed adalah `max`. Default input `replay:book` adalah `data/orderbooks.jsonl`, sedangkan replay lama memakai `data/market-quotes.jsonl`. Scheduling memakai `recordedAt`, bukan exchange timestamp, agar arrival sequence lokal dapat direproduksi. Blank line dilewati; record malformed atau invalid diberi warning dan dilewati tanpa menghentikan seluruh replay.

Live dan order book replay memanggil `MarketPipeline.processOrderBook()` yang sama untuk depth simulation, fees, lifecycle, event recording, dan metrics. Waktu logis replay menggunakan `recordedAt`, sehingga speed tidak mengubah fill, VWAP, slippage, fee, net result, atau state transition. UUID event boleh berbeda antar-run.

Replay tidak menghubungi Bybit/OKX dan tidak menulis kembali ke raw dataset. Setiap run memakai output unik berbentuk `data/replays/<timestamp>-<short-id>/opportunity-events.jsonl`, sehingga hasil antar-run dan live event tidak tercampur. Path aktual dicetak pada akhir replay. Jika tidak ada event, file tersebut tidak perlu dibuat. Event yang masih terbuka dilaporkan jumlahnya dan tidak dipaksa menjadi `DISAPPEARED`.

Raw order book dan quote input tidak pernah ditulis ulang saat replay. Fee, target size, dan economics dihitung downstream, sehingga dataset order book yang sama dapat diuji ulang dengan config berbeda. Replay quote lama tetap top-of-book-only; gunakan `replay:book` untuk hasil Phase 2.1.

## Opportunity metrics

Session metrics comparison depth mencakup:

- Total comparison.
- Count `INSUFFICIENT_DEPTH`.
- Count `EXECUTABLE_NET_POSITIVE`.
- Count `EXECUTABLE_NET_ZERO_OR_NEGATIVE`.
- Average BUY dan SELL slippage percent.

Metrics hanya menghitung completed event dengan state final `DISAPPEARED`:

- `eventsEverActive`: completed event yang pernah mencapai `ACTIVE`.
- `eventsNeverActive`: completed event yang tidak pernah mencapai `ACTIVE`.
- `invalidSyncEvents`: completed event yang pernah memasuki `INVALID_SYNC`.
- Average, minimum, maksimum, P50, P95, dan P99 lifetime.
- Average dan maksimum peak gross spread percent.
- Average dan maksimum peak estimated net spread percent.
- Average dan maksimum peak estimated net PnL absolute.
- Average dan maksimum peak tradable size.

Field `everActive` dan `everInvalidSync` disimpan pada setiap snapshot dan dibawa sampai final event; history tidak ditebak dari final state. Percentile menggunakan metode **nearest-rank** pada lifetime yang diurutkan ascending: rank = `ceil(percentile / 100 * jumlah sample)`.

Summary metrics dicetak setiap 60 detik dan aman saat belum ada completed event. Metrics masih bersifat in-memory untuk session berjalan dan reset saat aplikasi restart. Nilai net tetap estimasi top-of-book, bukan realized profit.

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

## Scope Phase 2.1

Scope versi ini terbatas pada public multi-level order book, local reconstruction, hypothetical target-size execution, VWAP/slippage, estimated taker fees, replay, lifecycle, dan metrics. Belum ada real order execution, balance, transfer, private API, database, dashboard, atau paper trading.
