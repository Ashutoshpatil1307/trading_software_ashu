require("dotenv").config();

const express = require("express");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { calculateAnalysis } = require("./lib/analysis");
const {
  TIMEFRAMES,
  fetchCandles,
  getAsset,
  isValidPair,
  publicAssets,
  searchTwelveDataSymbols,
} = require("./lib/market-data");
const { getNewsSnapshot } = require("./lib/news");
const { createSignal, updateSignalOutcomes } = require("./lib/signal-tracker");
const { createStreamHub } = require("./lib/stream-hub");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const server = http.createServer(app);
const DATA_DIR = path.join(__dirname, "data");
const SIGNALS_FILE = path.join(DATA_DIR, "signals.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const API_KEY = process.env.TWELVEDATA_API_KEY;
let signalQueue = Promise.resolve();
let trackerRunning = false;
const streams = createStreamHub(server, { onMarket: handleStreamCandle, apiKey: API_KEY });

app.use(express.json({ limit: "16kb" }));
app.use(express.static(PUBLIC_DIR));

async function readSignals() {
  try {
    const contents = await fs.readFile(SIGNALS_FILE, "utf8");
    const signals = JSON.parse(contents);
    if (!Array.isArray(signals)) throw new Error("Signal history file must contain a JSON array.");
    return signals;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeSignals(signals) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporaryFile = `${SIGNALS_FILE}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(signals, null, 2), "utf8");
  await fs.rename(temporaryFile, SIGNALS_FILE);
}

function withSignalLock(operation) {
  const result = signalQueue.then(operation, operation);
  signalQueue = result.catch(() => {});
  return result;
}

async function refreshActiveSignalOutcomes() {
  if (trackerRunning) return;
  trackerRunning = true;
  try {
    const activeCalls = await withSignalLock(async () => (await readSignals())
      .filter((signal) =>
        !signal.closedAt &&
        Object.hasOwn(TIMEFRAMES, signal.timeframe) &&
        Number.isFinite(signal.target1) &&
        Number.isFinite(signal.target2) &&
        !["TP2 Hit", "SL Hit", "TP1 Hit"].includes(signal.outcome)
      )
      .map(({ asset, timeframe }) => ({ asset, timeframe }))
    );
    const uniqueCalls = [...new Map(activeCalls.map((call) => [
      `${call.asset}:${call.timeframe}`,
      call,
    ])).values()];
    const results = [];
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(3, uniqueCalls.length) }, async () => {
      while (nextIndex < uniqueCalls.length) {
        const index = nextIndex;
        nextIndex += 1;
        const call = uniqueCalls[index];
        try {
          const candles = await fetchCandles(call.asset, call.timeframe, API_KEY);
          results.push({ ...call, candles });
        } catch (error) {
          console.error(`Background tracking failed for ${call.asset} ${call.timeframe}:`, error.message);
        }
      }
    });
    await Promise.all(workers);
    if (!results.length) return;

    await withSignalLock(async () => {
      const signals = await readSignals();
      const changed = results.reduce(
        (updated, result) =>
          updateSignalOutcomes(signals, result.candles, result.asset, result.timeframe) || updated,
        false
      );
      if (changed) {
        await writeSignals(signals);
        streams.broadcast({ type: "signals-updated" });
      }
    });
  } catch (error) {
    console.error("Background signal tracker failed:", error.message);
  } finally {
    trackerRunning = false;
  }
}

async function handleStreamCandle(update) {
  if (!update.candle.closed) return;
  try {
    await withSignalLock(async () => {
      const signals = await readSignals();
      const changed = updateSignalOutcomes(
        signals,
        [update.candle],
        update.asset,
        update.timeframe
      );
      if (changed) {
        await writeSignals(signals);
        streams.broadcast({ type: "signals-updated" });
      }
    });
  } catch (error) {
    console.error(`Live signal tracking failed for ${update.asset}:`, error.message);
  }
}

function healthResponse(_request, response) {
  response.set("Cache-Control", "no-store");
  response.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    dataProviders: {
      twelveData: Boolean(API_KEY),
      binance: "public",
      streams: streams.getStatus(),
      news: process.env.NEWS_RSS_URL || "ForexLive RSS",
      economicCalendar: process.env.ECONOMIC_CALENDAR_URL || "Forex Factory calendar feed",
    },
  });
}

app.get("/health", healthResponse);
app.get("/api/health", healthResponse);

app.get("/api/assets", (_request, response) => {
  response.json({ assets: publicAssets() });
});

app.get("/api/assets/search", async (request, response) => {
  const query = typeof request.query.q === "string" ? request.query.q.trim() : "";
  if (query.length < 2 || query.length > 40) {
    return response.status(400).json({ error: "Enter between 2 and 40 characters to search." });
  }
  try {
    const assets = await searchTwelveDataSymbols(query, API_KEY);
    return response.json({ assets });
  } catch (error) {
    console.error("Symbol search failed:", error.message);
    return response.status(API_KEY ? 502 : 503).json({ error: error.message });
  }
});

app.get("/api/news", async (request, response) => {
  const symbol = typeof request.query.symbol === "string" ? request.query.symbol : "";
  if (!getAsset(symbol) || !isValidPair(symbol)) {
    return response.status(400).json({ error: "Select a valid asset before loading news." });
  }
  response.set("Cache-Control", "no-store");
  response.json(await getNewsSnapshot(symbol));
});

app.get("/api/market", async (request, response) => {
  const symbol = typeof request.query.symbol === "string" ? request.query.symbol : "";
  const timeframe = typeof request.query.timeframe === "string" ? request.query.timeframe : "5m";
  const asset = getAsset(symbol);
  if (!asset || !isValidPair(symbol)) {
    return response.status(400).json({ error: "Select a supported asset." });
  }
  if (!Object.hasOwn(TIMEFRAMES, timeframe)) {
    return response.status(400).json({ error: "Select a supported timeframe." });
  }

  try {
    const [candles, news] = await Promise.all([
      fetchCandles(symbol, timeframe, API_KEY),
      getNewsSnapshot(symbol),
    ]);
    const analysis = calculateAnalysis(candles, timeframe, news);
    const signal = await withSignalLock(async () => {
      const signals = await readSignals();
      const previousLength = signals.length;
      const changed = updateSignalOutcomes(signals, candles, symbol, timeframe);
      const created = createSignal(symbol, timeframe, analysis, news, asset, signals);
      if (changed || signals.length !== previousLength) await writeSignals(signals);
      if (signals.length !== previousLength) {
        streams.broadcast({ type: "signal", signal: created });
      } else if (changed) {
        streams.broadcast({ type: "signals-updated" });
      }
      return created;
    });

    streams.broadcast({
      type: "CANDLE_UPDATE",
      asset: symbol,
      timeframe,
      candle: { ...candles.at(-1), closed: false },
      receivedAt: Date.now(),
    });
    return response.json({
      asset: symbol,
      assetName: asset.label,
      timeframe,
      candles,
      analysis,
      news,
      signal,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`Market request failed for ${symbol} ${timeframe}:`, error.message);
    return response.status(502).json({ error: `Unable to load ${symbol}: ${error.message}` });
  }
});

app.get("/api/signals", async (_request, response) => {
  try {
    response.json({ signals: await readSignals() });
  } catch (error) {
    console.error("Signal history read failed:", error.message);
    response.status(500).json({ error: "Unable to read saved signal history." });
  }
});

app.get("*", (_request, response) => {
  response.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

server.listen(PORT, () => {
  console.log(`Forex Market Management running at http://localhost:${PORT}`);
  if (!API_KEY) console.warn("Set TWELVEDATA_API_KEY in .env to enable metals and Forex data.");
  setInterval(refreshActiveSignalOutcomes, 60_000);
});

function shutdown() {
  streams.close();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
