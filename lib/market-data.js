const TIMEFRAMES = {
  "1m": { twelveData: "1min", binance: "1m", seconds: 60 },
  "5m": { twelveData: "5min", binance: "5m", seconds: 300 },
  "15m": { twelveData: "15min", binance: "15m", seconds: 900 },
  "1h": { twelveData: "1h", binance: "1h", seconds: 3600 },
  "4h": { twelveData: "4h", binance: "4h", seconds: 14400 },
  "1d": { twelveData: "1day", binance: "1d", seconds: 86400 },
};

const ASSETS = {
  "XAU/USD": { label: "Gold", category: "Metals", provider: "twelvedata", decimals: 2, pipSize: 0.01 },
  "XAG/USD": { label: "Silver", category: "Metals", provider: "twelvedata", decimals: 3, pipSize: 0.001 },
  "EUR/USD": { label: "Euro / US Dollar", category: "Forex", provider: "twelvedata", decimals: 5, pipSize: 0.0001 },
  "GBP/USD": { label: "British Pound / US Dollar", category: "Forex", provider: "twelvedata", decimals: 5, pipSize: 0.0001 },
  "USD/JPY": { label: "US Dollar / Japanese Yen", category: "Forex", provider: "twelvedata", decimals: 3, pipSize: 0.01 },
  "AUD/USD": { label: "Australian Dollar / US Dollar", category: "Forex", provider: "twelvedata", decimals: 5, pipSize: 0.0001 },
  "BTC/USDT": { label: "Bitcoin / Tether", category: "Crypto", provider: "binance", binanceSymbol: "BTCUSDT", decimals: 2, pipSize: 0.01 },
  "ETH/USDT": { label: "Ethereum / Tether", category: "Crypto", provider: "binance", binanceSymbol: "ETHUSDT", decimals: 2, pipSize: 0.01 },
  "SOL/USDT": { label: "Solana / Tether", category: "Crypto", provider: "binance", binanceSymbol: "SOLUSDT", decimals: 3, pipSize: 0.001 },
};

function isValidPair(symbol) {
  return typeof symbol === "string" && /^[A-Z0-9]{2,15}\/[A-Z0-9]{2,15}$/.test(symbol);
}

function getAsset(symbol) {
  if (ASSETS[symbol]) return ASSETS[symbol];
  if (!isValidPair(symbol)) return null;
  const [base, quote] = symbol.split("/");
  return {
    label: `${base} / ${quote}`,
    category: "Forex",
    provider: "twelvedata",
    decimals: quote === "JPY" ? 3 : 5,
    pipSize: quote === "JPY" ? 0.01 : 0.0001,
  };
}

function publicAssets() {
  return Object.entries(ASSETS).map(([symbol, asset]) => ({
    symbol,
    label: asset.label,
    category: asset.category,
  }));
}

async function fetchCandles(symbol, timeframe, apiKey) {
  const asset = getAsset(symbol);
  const interval = TIMEFRAMES[timeframe];
  if (!asset) throw new Error("Unsupported market symbol.");
  if (!interval) throw new Error("Unsupported timeframe.");

  let url;
  if (asset.provider === "binance") {
    url = new URL("https://api.binance.com/api/v3/klines");
    url.search = new URLSearchParams({
      symbol: asset.binanceSymbol,
      interval: interval.binance,
      limit: "300",
    }).toString();
  } else {
    if (!apiKey) throw new Error("Set TWELVEDATA_API_KEY in .env to load metals and Forex markets.");
    url = new URL("https://api.twelvedata.com/time_series");
    url.search = new URLSearchParams({
      symbol,
      interval: interval.twelveData,
      timezone: "UTC",
      outputsize: "300",
      apikey: apiKey,
    }).toString();
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Market data provider returned HTTP ${response.status}.`);
  const payload = await response.json();
  let candles;

  if (asset.provider === "binance") {
    if (!Array.isArray(payload)) {
      throw new Error(payload.msg || "Binance returned no candlesticks.");
    }
    candles = payload.map((item) => ({
      time: Math.floor(Number(item[0]) / 1000),
      open: Number(item[1]),
      high: Number(item[2]),
      low: Number(item[3]),
      close: Number(item[4]),
      volume: Number(item[5]) || 0,
    }));
  } else {
    if (payload.status === "error" || !Array.isArray(payload.values)) {
      throw new Error(payload.message || "Twelve Data returned no candlesticks.");
    }
    candles = payload.values.map((item) => ({
      time: Math.floor(new Date(`${item.datetime.replace(" ", "T")}Z`).getTime() / 1000),
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close),
      volume: Number(item.volume) || 0,
    })).sort((a, b) => a.time - b.time);
  }

  candles = candles.filter((candle) =>
    Number.isFinite(candle.time) &&
    [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
  );
  if (candles.length < 200) {
    throw new Error("At least 200 candles are needed to calculate the requested indicators.");
  }
  return candles;
}

async function searchTwelveDataSymbols(query, apiKey) {
  if (!apiKey) throw new Error("Set TWELVEDATA_API_KEY to search additional market symbols.");
  const url = new URL("https://api.twelvedata.com/symbol_search");
  url.search = new URLSearchParams({ symbol: query, apikey: apiKey }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Symbol search returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload.status === "error") throw new Error(payload.message || "Symbol search failed.");
  return (payload.data || [])
    .map((item) => ({
      symbol: String(item.symbol || "").toUpperCase().replace(/\s/g, ""),
      label: item.instrument_name || item.name || item.symbol,
      category: item.instrument_type || item.exchange || "Market",
    }))
    .filter((item) => isValidPair(item.symbol))
    .slice(0, 12);
}

module.exports = {
  ASSETS,
  TIMEFRAMES,
  fetchCandles,
  getAsset,
  isValidPair,
  publicAssets,
  searchTwelveDataSymbols,
};
