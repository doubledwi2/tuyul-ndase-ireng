# tuyul-ndase-ireng

Market Data Collector v0.1.1 adalah Phase 1.1 dari project real-time crypto arbitrage scanner. Pada fase ini aplikasi **hanya membaca public market data** untuk best bid, best ask, dan size pada masing-masing level BTC/USDT dari Bybit Spot dan OKX Spot.

Aplikasi ini tidak memakai API key atau autentikasi, tidak menyimpan data, tidak menghitung peluang arbitrase, dan tidak melakukan trading maupun order execution.

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

## Scope Phase 1.1

Scope versi ini sengaja terbatas pada penerimaan, validasi, dan normalisasi best bid/ask beserta size. Belum ada database, REST API, dashboard, kalkulasi arbitrase/profit/fee/slippage, paper trading, atau fitur eksekusi order.
