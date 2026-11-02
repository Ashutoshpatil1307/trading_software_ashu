# Forex Market Management

A dark, responsive multi-asset dashboard for metals, Forex, and crypto. The Express backend retrieves market candles, calculates technical and price-action confluence, classifies financial headlines, checks an economic calendar, and persists signals in a local JSON file.

## Features

- **Markets:** XAU/USD, XAG/USD, EUR/USD, GBP/USD, USD/JPY, AUD/USD, BTC/USDT, ETH/USDT, and SOL/USDT. Search Twelve Data instruments and add supported `BASE/QUOTE` pairs to a browser-persisted watchlist.
- **Market data:** Binance public WebSocket kline streams for configured crypto pairs and timeframes. With `TWELVEDATA_API_KEY`, Twelve Data quote WebSockets stream metals/Forex and the server builds live OHLC candles (quote volume is unavailable and reported as zero). REST candles seed charts and provide market analysis.
- **Timeframes:** 1m, 5m, 15m, 1h, 4h, and 1d.
- **Technical analysis:** EMA 20/50/200, RSI 14, MACD 12/26/9, ATR 14, Bollinger Bands, candle patterns, swing structure, fair value gaps, order blocks, BOS/CHoCH, liquidity sweeps, retests, and classic chart formations.
- **News and event risk:** ForexLive RSS headline sentiment uses a small, explainable text lexicon. The Forex Factory weekly calendar is checked for relevant high-impact releases. A high-impact event due within 15 minutes blocks new entries. If the calendar is unavailable, the signal engine fails closed and displays the feed error.
- **Signal rules:** BUY/SELL requires an aligned EMA trend, a directional SMC setup, indicator alignment, relevant directional news sentiment, and a confluence score of at least 75. Targets are 1.5R and 3R; the ATR-based stop is 1R. A signal includes its trigger zone, timestamp, timeframe, news context, and reasons.
- **History/performance:** Signal outcomes are evaluated against later candles, with a background tracker polling open calls every minute (up to three markets concurrently), and saved in `data/signals.json`. TP1 is tracked separately while the remainder stays active; a subsequent stop after TP1 is counted as a partial TP1 result. P/L displays quote pips/points using each configured market's quote increment.
- **Live alerts and charting:** Connected dashboards receive `CANDLE_UPDATE`, new signal, provider-status, and outcome messages over `/ws`. Charts update on incoming quotes; analysis is refreshed when the selected market/timeframe closes a candle. The browser reconnects automatically, and REST market polling is used as a fallback while that market's stream is unavailable. Qualified new calls display an in-app alert and a subtle audio ping after the first user interaction.

## Setup

1. Install Node.js 18+ and dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env`. Add a free Twelve Data API key for metals, Forex, and symbol search:

   ```env
   TWELVEDATA_API_KEY=your_twelve_data_api_key
   ```

   Binance's public spot candle endpoint does not require an API key. The default ForexLive RSS and Forex Factory calendar URLs can be overridden with `NEWS_RSS_URL` and `ECONOMIC_CALENDAR_URL`.

3. Start the server:

   ```sh
   npm start
   ```

4. Open [http://localhost:3000](http://localhost:3000).

Run the automated checks with:

```sh
npm test
```

`.env` is ignored by git. Do not put keys in frontend code or commit them. The server reads environment configuration on startup. Override the listening port with `PORT`.

The service health endpoint is `GET /health` (also available at `/api/health`). For a hosted instance, configure an external availability monitor to request `/health` every 10 minutes. A process cannot reliably keep its own free-tier host awake by pinging itself; host sleep behavior depends on the hosting provider and plan.

## Project structure

```text
.
├── server.js
├── package.json
├── .env.example
├── README.md
├── lib/
│   ├── analysis.js
│   ├── market-data.js
│   ├── news.js
│   ├── signal-tracker.js
│   └── stream-hub.js
├── test/
│   └── app.test.js
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```

## Data, limits, and risk

This is an explainable, rule-based technical/sentiment engine, not a trained predictive model. Its score is a confluence rating, **not** a calibrated 75–80% chance of winning or financial advice. Validate signals through historical backtesting, and account for spreads, slippage, fees, latency, API limits, and the risk of loss. Stream availability and latency depend on the upstream provider, network, account plan, and market session. Twelve Data streaming requires a configured API key; its price quotes do not provide traded candle volume. REST data is used for chart seeding, signal analysis at candle close, and fallback when a WebSocket provider is unavailable. Calendar/news feeds are external services and their availability is shown in the dashboard. The performance total combines quote pips/points across markets with different conventions and should not be interpreted as a common cash return.
