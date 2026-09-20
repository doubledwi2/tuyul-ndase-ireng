# tuyul-ndase-ireng

Raw Market Recorder + Replay Engine v0.1.5 adalah Phase 1.5 dari project real-time crypto arbitrage scanner. Aplikasi membaca best bid, best ask, dan size BTC/USDT dari Bybit Spot dan OKX Spot, merekam quote normalized, membandingkan top-of-book kedua exchange, melacak lifecycle candidate gross-spread, dan dapat memutar ulang dataset melalui pipeline yang sama.

Aplikasi ini tidak memakai API key atau autentikasi, tidak menentukan peluang yang executable, dan tidak melakukan trading maupun order execution. Persistence hanya berupa file JSONL lokal untuk normalized market quote serta perubahan state opportunity; tidak ada database.

## Data source

- Bybit Public WebSocket V5 Spot: `wss://stream.bybit.com/v5/public/spot`
  - Topic: `orderbook.1.BTCUSDT`
- OKX Public WebSocket: `wss://ws.okx.com:8443/ws/v5/public`
  - Channel: `bbo-tbt`, instrument: `BTC-USDT`

OKX `bbo-tbt` dipilih karena merupakan feed public tick-by-tick depth 1 yang langsung menyediakan best bid/ask beserta size dan tidak memerlukan autentikasi. Kedua feed dinormalisasi ke model `BestQuote` yang sama. Quote dengan price atau size non-positif maupun `ask < bid` diabaikan.

Output terminal dibatasi sekitar satu kali setiap 500 ms agar tetap mudah dibaca, tanpa mengubah timestamp asli ketika message diterima.

## Normalized quote dan timestamp

Setiap quote berisi `bid`, `bidSize`, `ask`, dan `askSize`, ditambah tiga timestamp:

- `exchangeTimestamp`: timestamp update yang dikirim exchange.
- `matchingEngineTimestamp`: waktu matching engine menghasilkan order book, jika feed menyediakannya.
- `receivedTimestamp`: `Date.now()` yang diambil segera saat message diterima, sebelum parsing.

Bybit menyediakan `ts` sebagai `exchangeTimestamp` dan `cts` sebagai `matchingEngineTimestamp`. Pada OKX `bbo-tbt`, dokumentasi exchange menyatakan satu-satunya field `ts` adalah waktu matching engine menghasilkan book. Karena itu nilai sumber yang sama digunakan untuk `exchangeTimestamp` dan `matchingEngineTimestamp`.

`matchingEngineTimestamp` tetap nullable dalam model bersama. Nilainya `null` jika suatu exchange atau message tidak menyediakan timestamp matching-engine yang relevan; collector tidak membuat timestamp pengganti.

## Cross-exchange comparison

Comparator memakai latest valid quote dari kedua exchange dan menghitung dua arah:

- Buy Bybit pada ask, lalu sell OKX pada bid.
- Buy OKX pada ask, lalu sell Bybit pada bid.

Formula yang digunakan:

```text
grossSpreadAbsolute = sellPrice - buyPrice
grossSpreadPercent = ((sellPrice - buyPrice) / buyPrice) * 100
tradableSize = min(buyExchange.askSize, sellExchange.bidSize)
```

`tradableSize` hanya menunjukkan size teoritis yang tersedia pada best level. Belum ada simulasi multi-level order book. Gross spread juga belum memperhitungkan fee atau slippage dan tidak boleh dianggap sebagai profit maupun bukti bahwa opportunity dapat dieksekusi.

### Baseline synchronization

Comparator memakai `receivedTimestamp` sebagai safety check awal:

- Selisih waktu penerimaan maksimum: `250 ms`.
- Usia quote maksimum saat comparison dibuat: `1000 ms`.
- Comparison berstatus `SYNC_OK` hanya jika kedua syarat terpenuhi; selain itu `STALE`.

Threshold tersebut hanya baseline engineering awal untuk mendeteksi quote yang terlalu jauh waktunya. `SYNC_OK` bukan jaminan opportunity valid atau executable dan bukan batas ideal untuk trading.

## Opportunity event lifecycle

Candidate opportunity hanya berarti `grossSpreadPercent > 0`. Ini bukan berarti profitable karena fee dan slippage belum dihitung.

Setiap arah mempunyai event independen dengan key seperti `BTC/USDT:bybit->okx`. Event ID yang sama dipertahankan sepanjang satu lifecycle agar candidate dapat dilacak dari awal sampai berakhir. Setelah event `DISAPPEARED`, kemunculan baru pada arah yang sama mendapat ID baru.

Untuk comparison `SYNC_OK`, state dipromosikan berdasarkan observasi valid berturut-turut tanpa timer tambahan:

```text
observasi valid #1  DETECTED
observasi valid #2  VALIDATING
observasi valid #3+ ACTIVE
spread <= 0         DISAPPEARED
```

`INVALID_SYNC` berarti gross spread positif terlihat, tetapi data tidak memenuhi baseline synchronization. Saat data kembali `SYNC_OK`, urutan observasi valid dimulai lagi dari `DETECTED` dengan event ID yang sama.

Selama event hidup, collector memperbarui current dan peak gross spread serta peak tradable size tanpa menjumlahkan size antar-tick. Lifetime baru dihitung ketika event menjadi `DISAPPEARED`. State `ACTIVE` tetap bukan jaminan bahwa candidate executable atau profitable.

## Raw market recording

Dalam live mode, setiap `BestQuote` valid dari kedua exchange disimpan secara append-only ke:

```text
data/market-quotes.jsonl
```

Satu baris berisi satu object JSON dengan format:

```json
{"recordedAt": 1700000000001, "quote": {"exchange": "bybit", "symbol": "BTC/USDT", "bid": 60000, "bidSize": 1.2, "ask": 60001, "askSize": 0.8, "exchangeTimestamp": 1700000000000, "matchingEngineTimestamp": 1699999999999, "receivedTimestamp": 1700000000000}}
```

Yang direkam adalah quote normalized, bukan raw WebSocket payload. Seluruh field `BestQuote` dipertahankan. `recordedAt` adalah waktu recorder menerima quote di pipeline live. Write diserialisasi untuk menjaga urutan, dan shutdown menunggu write yang masih pending.

## Event recording

Setiap perubahan state event disimpan secara append-only ke:

```text
data/opportunity-events.jsonl
```

Format yang digunakan adalah JSON Lines: setiap baris merupakan satu object JSON valid berisi `recordedAt` dan snapshot lengkap `OpportunityEvent`. Urutan write diserialisasi agar sama dengan urutan event diterima. Record final `DISAPPEARED` menyimpan `endedAt`, `lifetimeMs`, peak spread, peak tradable size, dan flag historis.

File runtime `data/*.jsonl` diabaikan Git. Jika penulisan gagal, recorder melaporkan error singkat tanpa menghentikan market feed atau comparator. Saat shutdown, aplikasi menunggu seluruh antrean write selesai sebelum keluar.

## Replay

Dataset raw dapat diputar ulang tanpa membuat koneksi WebSocket:

```bash
npm run replay -- --file data/market-quotes.jsonl --speed max
```

Pilihan speed:

- `realtime`: memakai jeda `recordedAt` asli antar-record.
- `fast`: mempercepat jeda sekitar 10x.
- `max`: tanpa artificial delay, tetapi urutan file tetap dipertahankan.

Default speed adalah `max`, dan default file adalah `data/market-quotes.jsonl`. Scheduling sengaja memakai `recordedAt`, bukan exchange timestamp, agar arrival sequence lokal dapat direproduksi. Blank line dilewati; record malformed atau invalid diberi warning dan dilewati tanpa menghentikan seluruh replay.

Live dan replay memanggil `MarketPipeline` yang sama untuk update latest quote, comparison, opportunity lifecycle, event recording, dan metrics. Waktu logis pipeline saat replay juga menggunakan `recordedAt`, sehingga pilihan speed tidak mengubah hasil downstream untuk dataset dan konfigurasi yang sama. UUID event boleh berbeda antar-run.

Replay tidak menghubungi Bybit/OKX dan tidak menulis kembali ke raw dataset. Perubahan state hasil replay ditulis terpisah ke `data/replay-opportunity-events.jsonl`, sehingga tidak tercampur diam-diam dengan `data/opportunity-events.jsonl`. Pada akhir file, event yang masih terbuka dilaporkan jumlahnya dan tidak dipaksa menjadi `DISAPPEARED`.

Hasil replay masih berdasarkan gross spread top-of-book saja. Hasil tersebut bukan bukti profitability atau bahwa opportunity dapat dieksekusi; belum ada fee, slippage, maupun depth di luar best level.

## Opportunity metrics

Metrics hanya menghitung completed event dengan state final `DISAPPEARED`:

- `eventsEverActive`: completed event yang pernah mencapai `ACTIVE`.
- `eventsNeverActive`: completed event yang tidak pernah mencapai `ACTIVE`.
- `invalidSyncEvents`: completed event yang pernah memasuki `INVALID_SYNC`.
- Average, minimum, maksimum, P50, P95, dan P99 lifetime.
- Average dan maksimum peak gross spread percent.
- Average dan maksimum peak tradable size.

Field `everActive` dan `everInvalidSync` disimpan pada setiap snapshot dan dibawa sampai final event; history tidak ditebak dari final state. Percentile menggunakan metode **nearest-rank** pada lifetime yang diurutkan ascending: rank = `ceil(percentile / 100 * jumlah sample)`.

Summary metrics dicetak setiap 60 detik dan aman saat belum ada completed event. Metrics masih bersifat in-memory untuk session berjalan dan reset saat aplikasi restart. Statistik ini hanya menggambarkan gross spread top-of-book dan bukan ukuran profitability.

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

## Scope Phase 1.5

Scope versi ini sengaja terbatas pada penerimaan, validasi, normalisasi, perekaman dan replay quote, perbandingan gross spread top-of-book, observasi lifecycle, persistence JSONL lokal, dan metrics dasar. Belum ada database, REST API, dashboard, fee/slippage/net profit/PnL, paper trading, atau fitur eksekusi order.
