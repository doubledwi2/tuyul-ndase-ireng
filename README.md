# tuyul-ndase-ireng

Market Data Collector v0.1 adalah Phase 1 dari project real-time crypto arbitrage scanner. Pada fase ini aplikasi **hanya membaca public market data** untuk best bid dan best ask BTC/USDT dari Bybit Spot dan OKX Spot.

Aplikasi ini tidak memakai API key atau autentikasi, tidak menyimpan data, tidak menghitung peluang arbitrase, dan tidak melakukan trading maupun order execution.

## Data source

- Bybit Public WebSocket V5 Spot: `wss://stream.bybit.com/v5/public/spot`
  - Topic: `orderbook.1.BTCUSDT`
- OKX Public WebSocket: `wss://ws.okx.com:8443/ws/v5/public`
  - Channel: `tickers`, instrument: `BTC-USDT`

Kedua feed dinormalisasi ke model `BestQuote` yang sama. Output terminal dibatasi sekitar satu kali setiap 500 ms agar tetap mudah dibaca, tanpa mengubah timestamp asli ketika message diterima.

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

## Menjalankan hasil build

```bash
npm start
```

File JavaScript hasil build berada di folder `dist/`.

## Scope Phase 1

Scope versi ini sengaja terbatas pada penerimaan dan normalisasi best bid/ask. Belum ada database, REST API, dashboard, kalkulasi arbitrase/profit/fee/slippage, paper trading, atau fitur eksekusi order.
