const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateAnalysis, detectCandlestickPatterns, detectPriceAction } = require("../lib/analysis");
const { fetchCandles, getAsset, isValidPair, publicAssets } = require("../lib/market-data");
const { classifyImpact, currenciesFor, scoreSentiment } = require("../lib/news");
const { createSignal, updateSignalOutcomes } = require("../lib/signal-tracker");

function makeCandles(length = 260) {
  const candles = [];
  let close = 100;
  for (let index = 0; index < length; index += 1) {
    const change = 0.06 + Math.sin(index * 0.57) * 0.28;
    const open = close;
    close += change;
    candles.push({
      time: 1_800_000_000 + index * 300,
      open,
      close,
      high: Math.max(open, close) + 0.12,
      low: Math.min(open, close) - 0.12,
      volume: 100 + index,
    });
  }
  return candles;
}

test("configured assets and dynamic market symbols are validated", () => {
  const symbols = publicAssets().map((asset) => asset.symbol);
  for (const symbol of [
    "XAU/USD", "XAG/USD", "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD",
    "BTC/USDT", "ETH/USDT", "SOL/USDT",
  ]) {
    assert.ok(symbols.includes(symbol));
  }
  assert.equal(getAsset("BTC/USDT").provider, "binance");
  assert.equal(getAsset("EUR/JPY").provider, "twelvedata");
  assert.equal(isValidPair("ABC/XYZ"), true);
  assert.equal(isValidPair("https://example.com"), false);
  assert.equal(getAsset("BTCUSDT"), null);
});

test("financial news impact and sentiment classification are directional", () => {
  assert.equal(classifyImpact("US CPI and FOMC rate decision"), "High");
  assert.equal(classifyImpact("Eurozone GDP report"), "Medium");
  assert.ok(scoreSentiment("Bullish growth rally") > scoreSentiment("Bearish recession decline"));
  assert.ok(currenciesFor("BTC/USDT").includes("USD"));
});

test("candlestick analysis recognizes hammer and bullish engulfing", () => {
  const hammerCandles = makeCandles(4);
  hammerCandles[3] = { ...hammerCandles[3], open: 100, close: 100.5, high: 100.6, low: 98 };
  assert.ok(detectCandlestickPatterns(hammerCandles).some((item) => item.name === "Hammer / Pinbar"));

  const engulfingCandles = makeCandles(4);
  engulfingCandles[2] = { ...engulfingCandles[2], open: 100, close: 99, high: 100.2, low: 98.8 };
  engulfingCandles[3] = { ...engulfingCandles[3], open: 98.8, close: 100.2, high: 100.4, low: 98.6 };
  assert.ok(detectCandlestickPatterns(engulfingCandles).some((item) => item.name === "Bullish Engulfing"));
});

test("price action analysis detects an unfilled fair value gap", () => {
  const candles = makeCandles(40);
  candles[30] = { time: candles[30].time, open: 100, close: 100.1, high: 100.5, low: 99.8, volume: 100 };
  candles[31] = { time: candles[31].time, open: 100.1, close: 101, high: 101.2, low: 100, volume: 100 };
  candles[32] = { time: candles[32].time, open: 101, close: 101.5, high: 101.8, low: 101, volume: 100 };
  const { smc } = detectPriceAction(candles, 0.5);
  assert.ok(smc.some((item) => item.name === "Bullish FVG"));
});

test("signal engine fails closed when the economic calendar is unavailable", () => {
  const candles = makeCandles();
  const news = {
    sentiment: { score: 0.07, label: "Neutral", articleCount: 3 },
    calendarStatus: "unavailable",
    highImpactWarning: false,
  };
  const analysis = calculateAnalysis(candles, "5m", news);
  assert.equal(analysis.action, "HOLD");
  assert.ok(analysis.indicators.ema200 > 0);
  assert.ok(analysis.indicators.atr > 0);
  assert.equal(analysis.requirements.bullish.sentiment, false);
  assert.equal(analysis.requirements.bearish.sentiment, false);
  const eventBlocked = calculateAnalysis(candles, "5m", {
    sentiment: { score: 0.7, label: "Bullish", articleCount: 3 },
    calendarStatus: "ok",
    highImpactWarning: true,
  });
  assert.equal(eventBlocked.action, "HOLD");
});

test("signal levels use the requested risk ratios and avoid same-candle duplicates", () => {
  const analysis = {
    action: "BUY",
    confidence: 80,
    entry: 100,
    candleTime: 100,
    indicators: { atr: 2 },
    reasons: ["Bullish FVG", "Positive news"],
  };
  const news = { sentiment: { score: 0.6 }, articles: [{ title: "Positive market news" }] };
  const signals = [];
  const signal = createSignal("EUR/USD", "5m", analysis, news, getAsset("EUR/USD"), signals);
  assert.equal(signal.stopLoss, 97);
  assert.equal(signal.target1, 104.5);
  assert.equal(signal.target2, 109);
  assert.equal(createSignal("EUR/USD", "5m", analysis, news, getAsset("EUR/USD"), signals).id, signal.id);
  assert.equal(signals.length, 1);
});

test("signal tracker records TP1, TP2, and conservative stop outcomes", () => {
  const createFixture = () => ({
    asset: "EUR/USD",
    action: "BUY",
    timeframe: "5m",
    entryCandleTime: 10,
    entryPrice: 100,
    stopLoss: 99,
    target1: 101.5,
    target2: 103,
    tp1Hit: false,
    outcome: "Active",
  });
  const firstTarget = { time: 20, open: 100, high: 101.6, low: 100.2, close: 101.2 };
  const secondTarget = { time: 30, open: 101.2, high: 103.2, low: 101, close: 103 };
  const tp2 = createFixture();
  updateSignalOutcomes([tp2], [firstTarget], "EUR/USD", "5m");
  assert.equal(tp2.outcome, "TP1 Hit · Active");
  updateSignalOutcomes([tp2], [firstTarget, secondTarget], "EUR/USD", "5m");
  assert.equal(tp2.outcome, "TP2 Hit");

  const stopAfterTp1 = createFixture();
  updateSignalOutcomes([stopAfterTp1], [firstTarget], "EUR/USD", "5m");
  const stop = { time: 30, open: 101.2, high: 102, low: 98.8, close: 99 };
  updateSignalOutcomes([stopAfterTp1], [firstTarget, stop], "EUR/USD", "5m");
  assert.equal(stopAfterTp1.outcome, "TP1 Hit");
  assert.equal(stopAfterTp1.exitPrice, stopAfterTp1.entryPrice);

  const stopped = createFixture();
  updateSignalOutcomes([stopped], [{ ...stop, time: 20 }], "EUR/USD", "5m");
  assert.equal(stopped.outcome, "SL Hit");
});

test("signal tracker accepts successive live updates to an open candle", () => {
  const signal = {
    asset: "BTC/USDT",
    action: "BUY",
    timeframe: "1m",
    entryCandleTime: 10,
    entryPrice: 100,
    stopLoss: 99,
    target1: 101,
    target2: 102,
    tp1Hit: false,
    outcome: "Active",
  };
  const firstTick = { time: 20, open: 100, high: 101.1, low: 99.8, close: 101, closed: false };
  const finalTick = { ...firstTick, high: 102.2, close: 102, closed: false };
  assert.equal(updateSignalOutcomes([signal], [firstTick], "BTC/USDT", "1m"), true);
  assert.equal(signal.outcome, "TP1 Hit · Active");
  assert.equal(updateSignalOutcomes([signal], [finalTick], "BTC/USDT", "1m"), true);
  assert.equal(signal.outcome, "TP2 Hit");
});

test("market data adapters normalize Binance and Twelve Data candles", async () => {
  const originalFetch = global.fetch;
  try {
    const binanceRows = Array.from({ length: 200 }, (_, index) => {
      const timestamp = 1_800_000_000_000 + index * 60_000;
      return [timestamp, "10", "11", "9", "10.5", "123", timestamp + 60_000, "0", 1];
    });
    global.fetch = async (url) => {
      assert.match(String(url), /api\.binance\.com/);
      return new Response(JSON.stringify(binanceRows), { status: 200 });
    };
    const cryptoCandles = await fetchCandles("BTC/USDT", "1m", undefined);
    assert.equal(cryptoCandles.length, 200);
    assert.equal(cryptoCandles[0].volume, 123);

    const values = Array.from({ length: 200 }, (_, index) => ({
      datetime: new Date((1_800_000_000 + index * 60) * 1000).toISOString().replace("T", " ").slice(0, 19),
      open: "2000",
      high: "2002",
      low: "1998",
      close: "2001",
      volume: "45",
    }));
    global.fetch = async (url) => {
      assert.match(String(url), /api\.twelvedata\.com/);
      return new Response(JSON.stringify({ values }), { status: 200 });
    };
    const goldCandles = await fetchCandles("XAU/USD", "5m", "test-key");
    assert.equal(goldCandles.length, 200);
    assert.equal(goldCandles.at(-1).close, 2001);
    await assert.rejects(fetchCandles("XAU/USD", "5m", ""), /TWELVEDATA_API_KEY/);
  } finally {
    global.fetch = originalFetch;
  }
});
