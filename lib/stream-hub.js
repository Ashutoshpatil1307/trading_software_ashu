const WebSocket = require("ws");
const { ASSETS, TIMEFRAMES } = require("./market-data");

const CRYPTO_SYMBOLS = Object.entries(ASSETS)
  .filter(([, asset]) => asset.provider === "binance")
  .map(([symbol, asset]) => ({ symbol, providerSymbol: asset.binanceSymbol.toLowerCase() }));
const TWELVE_DATA_SYMBOLS = Object.entries(ASSETS)
  .filter(([, asset]) => asset.provider === "twelvedata")
  .map(([symbol]) => symbol);

function createStreamHub(httpServer, { onMarket, apiKey } = {}) {
  const webSocketServer = new WebSocket.Server({ noServer: true, maxPayload: 16 * 1024 });
  const clients = new Set();
  const cache = new Map();
  const providerStatus = { binance: "connecting", twelvedata: apiKey ? "connecting" : "unconfigured" };
  const twelveCandles = new Map();
  const aliveClients = new WeakMap();
  const upstreams = new Map();
  const reconnectTimers = new Map();
  let heartbeatTimer;
  const reconnectDelays = new Map([["binance", 1000], ["twelvedata", 1000]]);
  let closed = false;

  function broadcast(message) {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 1_000_000) {
        client.send(payload);
      }
    }
  }

  function setProviderStatus(provider, status) {
    providerStatus[provider] = status;
    broadcast({ type: "provider", provider, status });
  }

  function emitCandle(asset, timeframe, candle) {
    const update = {
      type: "CANDLE_UPDATE",
      asset,
      timeframe,
      candle,
      receivedAt: Date.now(),
    };
    cache.set(`${asset}:${timeframe}`, update);
    broadcast(update);
    if (onMarket) {
      Promise.resolve(onMarket(update)).catch((error) => {
        console.error(`Live market callback failed for ${asset} ${timeframe}:`, error.message);
      });
    }
  }

  function scheduleReconnect(provider, connect) {
    if (closed) return;
    const delay = reconnectDelays.get(provider) || 1000;
    reconnectTimers.set(provider, setTimeout(connect, delay));
    reconnectDelays.set(provider, Math.min(delay * 2, 30_000));
  }

  function connectBinance() {
    if (closed) return;
    const streams = CRYPTO_SYMBOLS.flatMap(({ providerSymbol }) =>
      Object.values(TIMEFRAMES).map(({ binance }) => `${providerSymbol}@kline_${binance}`)
    );
    const upstream = new WebSocket(
      `wss://stream.binance.com:9443/stream?streams=${streams.join("/")}`
    );
    upstreams.set("binance", upstream);

    upstream.on("open", () => {
      reconnectDelays.set("binance", 1000);
      setProviderStatus("binance", "connected");
      console.log(`Binance WebSocket connected (${streams.length} kline streams).`);
    });

    upstream.on("message", (raw) => {
      try {
        const envelope = JSON.parse(raw.toString());
        const kline = envelope.data?.k;
        if (!kline || !envelope.stream) return;
        const asset = CRYPTO_SYMBOLS.find(
          (item) => item.providerSymbol === kline.s.toLowerCase()
        );
        if (!asset || !Object.hasOwn(TIMEFRAMES, kline.i)) return;
        const candle = {
          time: Math.floor(Number(kline.t) / 1000),
          open: Number(kline.o),
          high: Number(kline.h),
          low: Number(kline.l),
          close: Number(kline.c),
          volume: Number(kline.v),
          closed: Boolean(kline.x),
        };
        emitCandle(asset.symbol, kline.i, candle);
      } catch (error) {
        console.error("Could not decode Binance market message:", error.message);
      }
    });

    upstream.on("error", (error) => {
      console.error("Binance WebSocket error:", error.message);
    });

    upstream.on("close", () => {
      if (upstreams.get("binance") === upstream) upstreams.delete("binance");
      setProviderStatus("binance", "reconnecting");
      scheduleReconnect("binance", connectBinance);
    });
  }

  function connectTwelveData() {
    if (closed) return;
    if (!apiKey) {
      setProviderStatus("twelvedata", "unconfigured");
      return;
    }
    const endpoint = new URL("wss://ws.twelvedata.com/v1/quotes/price");
    endpoint.searchParams.set("apikey", apiKey);
    const upstream = new WebSocket(endpoint);
    upstreams.set("twelvedata", upstream);

    upstream.on("open", () => {
      reconnectDelays.set("twelvedata", 1000);
      upstream.send(JSON.stringify({
        action: "subscribe",
        params: { symbols: TWELVE_DATA_SYMBOLS.join(",") },
      }));
      setProviderStatus("twelvedata", "connected");
      console.log(`Twelve Data WebSocket subscribing to ${TWELVE_DATA_SYMBOLS.length} symbols.`);
    });

    upstream.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.event === "subscribe-status" && message.status === "error") {
          console.error("Twelve Data subscription failed:", message.message || message);
          setProviderStatus("twelvedata", "error");
          return;
        }
        if (message.event !== "price") return;
        const symbol = String(message.symbol || "").toUpperCase().replace(/\s/g, "");
        if (!Object.hasOwn(ASSETS, symbol) || ASSETS[symbol].provider !== "twelvedata") return;
        const price = Number(message.price);
        const timestamp = Number(message.timestamp);
        if (!Number.isFinite(price) || price <= 0) return;
        const seconds = Number.isFinite(timestamp)
          ? Math.floor(timestamp > 1e12 ? timestamp / 1000 : timestamp)
          : Math.floor(Date.now() / 1000);

        for (const [timeframe, interval] of Object.entries(TIMEFRAMES)) {
          const time = Math.floor(seconds / interval.seconds) * interval.seconds;
          const key = `${symbol}:${timeframe}`;
          const previous = twelveCandles.get(key);
          if (previous && time < previous.time) continue;
          if (previous && time > previous.time) {
            emitCandle(symbol, timeframe, { ...previous, closed: true });
          }
          const candle = previous && previous.time === time
            ? {
                ...previous,
                high: Math.max(previous.high, price),
                low: Math.min(previous.low, price),
                close: price,
                closed: false,
              }
            : {
                time,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: 0,
                closed: false,
              };
          twelveCandles.set(key, candle);
          emitCandle(symbol, timeframe, candle);
        }
      } catch (error) {
        console.error("Could not decode Twelve Data quote:", error.message);
      }
    });

    upstream.on("error", (error) => {
      console.error("Twelve Data WebSocket error:", error.message);
    });

    upstream.on("close", () => {
      if (upstreams.get("twelvedata") === upstream) upstreams.delete("twelvedata");
      setProviderStatus("twelvedata", "reconnecting");
      scheduleReconnect("twelvedata", connectTwelveData);
    });
  }

  httpServer.on("upgrade", (request, socket, head) => {
    let requestPath;
    try {
      requestPath = new URL(request.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (requestPath !== "/ws") {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit("connection", client, request);
    });
  });

  webSocketServer.on("connection", (client) => {
    clients.add(client);
    aliveClients.set(client, true);
    client.on("pong", () => aliveClients.set(client, true));
    for (const [provider, status] of Object.entries(providerStatus)) {
      client.send(JSON.stringify({ type: "provider", provider, status }));
    }
    for (const update of cache.values()) client.send(JSON.stringify(update));

    client.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type !== "subscribe" || !Array.isArray(message.assets)) return;
        const valid = message.assets.filter((symbol) => typeof symbol === "string" && ASSETS[symbol]);
        client.send(JSON.stringify({ type: "subscribed", assets: valid }));
      } catch (error) {
        client.send(JSON.stringify({ type: "error", message: `Invalid WebSocket message: ${error.message}` }));
      }
    });
    client.on("close", () => clients.delete(client));
    client.on("error", (error) => {
      console.error("Dashboard WebSocket client error:", error.message);
      clients.delete(client);
    });
  });

  heartbeatTimer = setInterval(() => {
    for (const client of clients) {
      if (!aliveClients.get(client)) {
        client.terminate();
        clients.delete(client);
        continue;
      }
      aliveClients.set(client, false);
      client.ping();
    }
  }, 30_000);

  connectBinance();
  connectTwelveData();

  return {
    broadcast,
    getStatus: () => ({ ...providerStatus }),
    close() {
      closed = true;
      for (const timer of reconnectTimers.values()) clearTimeout(timer);
      clearInterval(heartbeatTimer);
      for (const upstream of upstreams.values()) {
        if (upstream.readyState < WebSocket.CLOSING) upstream.close();
      }
      for (const client of clients) client.close(1001, "Server shutting down");
      webSocketServer.close();
    },
  };
}

module.exports = { createStreamHub };
