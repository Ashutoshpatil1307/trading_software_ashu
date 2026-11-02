const WebSocket = require("ws");
const { ASSETS, TIMEFRAMES } = require("./market-data");

const CRYPTO_SYMBOLS = Object.entries(ASSETS)
  .filter(([, asset]) => asset.provider === "binance")
  .map(([symbol, asset]) => ({ symbol, providerSymbol: asset.binanceSymbol.toLowerCase() }));
const CRYPTO_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"];

function createStreamHub(httpServer, { onMarket } = {}) {
  const webSocketServer = new WebSocket.Server({ noServer: true, maxPayload: 16 * 1024 });
  const clients = new Set();
  const cache = new Map();
  const aliveClients = new WeakMap();
  let upstream;
  let reconnectTimer;
  let heartbeatTimer;
  let reconnectDelay = 1000;
  let closed = false;

  function broadcast(message) {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 1_000_000) {
        client.send(payload);
      }
    }
  }

  function latestSnapshot(symbol) {
    return [...cache.values()].filter((item) => item.asset === symbol);
  }

  function connectUpstream() {
    if (closed) return;
    const streams = CRYPTO_SYMBOLS.flatMap(({ providerSymbol }) =>
      CRYPTO_INTERVALS.map((interval) => `${providerSymbol}@kline_${interval}`)
    );
    upstream = new WebSocket(
      `wss://stream.binance.com:9443/stream?streams=${streams.join("/")}`
    );

    upstream.on("open", () => {
      reconnectDelay = 1000;
      broadcast({ type: "provider", provider: "binance", status: "connected" });
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
        const update = {
          type: "market",
          asset: asset.symbol,
          timeframe: kline.i,
          candle,
          receivedAt: Date.now(),
        };
        cache.set(`${asset.symbol}:${kline.i}`, update);
        broadcast(update);
        onMarket?.(update);
      } catch (error) {
        console.error("Could not decode Binance market message:", error.message);
      }
    });

    upstream.on("error", (error) => {
      console.error("Binance WebSocket error:", error.message);
    });

    upstream.on("close", () => {
      broadcast({ type: "provider", provider: "binance", status: "reconnecting" });
      if (!closed) {
        reconnectTimer = setTimeout(connectUpstream, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      }
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
    client.send(JSON.stringify({
      type: "provider",
      provider: "binance",
      status: upstream?.readyState === WebSocket.OPEN ? "connected" : "connecting",
    }));
    for (const symbol of new Set(CRYPTO_SYMBOLS.map((item) => item.symbol))) {
      for (const update of latestSnapshot(symbol)) client.send(JSON.stringify(update));
    }

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

  connectUpstream();

  return {
    broadcast,
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      clearInterval(heartbeatTimer);
      if (upstream && upstream.readyState < WebSocket.CLOSING) upstream.close();
      for (const client of clients) client.close(1001, "Server shutting down");
      webSocketServer.close();
    },
  };
}

module.exports = { createStreamHub };
