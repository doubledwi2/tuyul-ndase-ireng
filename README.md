# tuyul-ndase-ireng

Opportunity Event Lifecycle v0.1.3 adalah Phase 1.3 dari project real-time crypto arbitrage scanner. Aplikasi membaca best bid, best ask, dan size BTC/USDT dari Bybit Spot dan OKX Spot, membandingkan top-of-book kedua exchange dalam dua arah, lalu melacak lifecycle candidate gross-spread.

Aplikasi ini tidak memakai API key atau autentikasi, tidak menyimpan data, tidak menentukan peluang yang executable, dan tidak melakukan trading maupun order execution.

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

## Scope Phase 1.3

Scope versi ini sengaja terbatas pada penerimaan, validasi, normalisasi, perbandingan gross spread top-of-book, dan observasi lifecycle candidate. Belum ada database, REST API, dashboard, fee/slippage/net profit/PnL, paper trading, atau fitur eksekusi order.
