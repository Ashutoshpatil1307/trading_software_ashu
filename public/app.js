(() => {
  "use strict";

  const REFRESH_MS = 15_000;
  const DEFAULT_ASSETS = [
    { symbol: "XAU/USD", label: "Gold", category: "Metals" },
    { symbol: "XAG/USD", label: "Silver", category: "Metals" },
    { symbol: "EUR/USD", label: "Euro / US Dollar", category: "Forex" },
    { symbol: "GBP/USD", label: "British Pound / US Dollar", category: "Forex" },
    { symbol: "USD/JPY", label: "US Dollar / Japanese Yen", category: "Forex" },
    { symbol: "AUD/USD", label: "Australian Dollar / US Dollar", category: "Forex" },
    { symbol: "BTC/USDT", label: "Bitcoin / Tether", category: "Crypto" },
    { symbol: "ETH/USDT", label: "Ethereum / Tether", category: "Crypto" },
    { symbol: "SOL/USDT", label: "Solana / Tether", category: "Crypto" },
  ];
  const PRECISION = {
    "XAU/USD": 2, "XAG/USD": 3, "EUR/USD": 5, "GBP/USD": 5, "USD/JPY": 3,
    "AUD/USD": 5, "BTC/USDT": 2, "ETH/USDT": 2, "SOL/USDT": 3,
  };
  const PIP_SIZE = {
    "XAU/USD": 0.01, "XAG/USD": 0.001, "EUR/USD": 0.0001, "GBP/USD": 0.0001,
    "USD/JPY": 0.01, "AUD/USD": 0.0001, "BTC/USDT": 0.01, "ETH/USDT": 0.01,
    "SOL/USDT": 0.001,
  };
  const byId = (id) => document.getElementById(id);
  const assetsBySymbol = new Map(DEFAULT_ASSETS.map((asset) => [asset.symbol, asset]));
  let watchlist = loadWatchlist();
  let selectedAsset = watchlist[0] || DEFAULT_ASSETS[0].symbol;
  let selectedTimeframe = "5m";
  let chart;
  let chartAsset;
  let chartTimeframe;
  let candleSeries;
  let ema20Series;
  let ema50Series;
  let requestInProgress = false;
  let refreshPending = false;
  let marketPollingEnabled = true;
  let noticeTimeout;
  let searchResults = [];
  let liveSocket;
  let liveCandles = [];
  let lastSignals = [];
  let historyFilter = "all";
  let selectedSignalId;
  let signalPriceLines = [];
  let websocketRetryDelay = 1000;
  const previousPrices = {};

  function loadWatchlist() {
    try {
      const saved = JSON.parse(localStorage.getItem("forex-market-watchlist") || "[]");
      const valid = Array.isArray(saved) ? saved.filter((symbol) =>
        DEFAULT_ASSETS.some((asset) => asset.symbol === symbol) ||
        /^[A-Z0-9]{2,15}\/[A-Z0-9]{2,15}$/.test(symbol)
      ) : [];
      return [...new Set([...DEFAULT_ASSETS.map((asset) => asset.symbol), ...valid])];
    } catch (error) {
      console.error("Could not read the saved watchlist:", error);
      return DEFAULT_ASSETS.map((asset) => asset.symbol);
    }
  }

  function saveWatchlist() {
    try {
      localStorage.setItem("forex-market-watchlist", JSON.stringify(watchlist));
    } catch (error) {
      showNotice(`Could not save your watchlist: ${error.message}`);
    }
  }

  function assetLabel(symbol) {
    return assetsBySymbol.get(symbol)?.label || symbol.replace("/", " / ");
  }

  function precision(symbol) {
    return PRECISION[symbol] ?? (symbol.endsWith("/JPY") ? 3 : 5);
  }

  function formatPrice(value, symbol = selectedAsset) {
    return Number(value).toLocaleString("en-US", {
      minimumFractionDigits: precision(symbol),
      maximumFractionDigits: precision(symbol),
    });
  }

  function showNotice(message) {
    const notice = byId("notice");
    notice.textContent = message;
    notice.hidden = false;
    clearTimeout(noticeTimeout);
    noticeTimeout = setTimeout(() => { notice.hidden = true; }, 9000);
  }

  function setConnection(connected, label) {
    document.querySelector(".status-dot").classList.toggle("connected", connected);
    byId("connection-label").textContent = label;
  }

  function renderAssetTabs() {
    const strip = byId("asset-strip");
    strip.replaceChildren();
    for (const symbol of watchlist) {
      const asset = assetsBySymbol.get(symbol) || { symbol, label: symbol.replace("/", " / "), category: "Added" };
      const button = document.createElement("button");
      button.type = "button";
      button.className = `asset-tab${symbol === selectedAsset ? " active" : ""}`;
      button.dataset.symbol = symbol;
      const label = document.createElement("span");
      label.className = "asset-symbol";
      label.textContent = symbol;
      const category = document.createElement("span");
      category.className = "asset-name";
      category.textContent = asset.category.toUpperCase();
      const price = document.createElement("span");
      price.className = "asset-price";
      price.id = `price-${symbol.replace(/[^A-Z0-9]/g, "-")}`;
      price.textContent = "—";
      const change = document.createElement("span");
      change.className = "asset-change";
      change.id = `change-${symbol.replace(/[^A-Z0-9]/g, "-")}`;
      change.textContent = "SELECT";
      button.append(label, category, price, change);
      button.addEventListener("click", () => selectAsset(symbol));
      strip.append(button);
    }
  }

  function selectAsset(symbol) {
    if (symbol === selectedAsset) return;
    selectedAsset = symbol;
    selectedSignalId = undefined;
    liveCandles = [];
    marketPollingEnabled = true;
    clearSignalLines();
    renderAssetTabs();
    byId("chart-asset-name").textContent = assetLabel(symbol);
    byId("chart-asset-code").textContent = symbol;
    byId("signal-symbol").textContent = symbol;
    loadMarket();
  }

  function selectedSignal(signal) {
    return signal && !signal.closedAt &&
      !["TP2 Hit", "SL Hit", "TP1 Hit"].includes(signal.outcome);
  }

  function clearSignalLines() {
    if (candleSeries) {
      for (const line of signalPriceLines) candleSeries.removePriceLine(line);
    }
    signalPriceLines = [];
    candleSeries?.setMarkers([]);
  }

  function drawSignalOverlay(signal) {
    if (!chart || !candleSeries || !signal) return;
    clearSignalLines();
    selectedSignalId = signal.id;
    const dashed = LightweightCharts.LineStyle.Dashed;
    const levels = [
      { price: signal.entryPrice, title: "ENTRY", color: "#00e5ff", lineStyle: LightweightCharts.LineStyle.Solid },
      { price: signal.target1, title: "TP1", color: "#00ff88", lineStyle: dashed },
      { price: signal.target2, title: "TP2", color: "#00ff88", lineStyle: dashed },
      { price: signal.stopLoss, title: "STOP", color: "#ff3366", lineStyle: dashed },
    ];
    signalPriceLines = levels.map((level) => candleSeries.createPriceLine({
      price: level.price,
      color: level.color,
      lineWidth: 1,
      lineStyle: level.lineStyle,
      axisLabelVisible: true,
      title: level.title,
    }));
    if (signal.entryCandleTime) {
      const marker = {
        time: signal.entryCandleTime,
        position: signal.action === "BUY" ? "belowBar" : "aboveBar",
        color: signal.action === "BUY" ? "#00ff88" : "#ff3366",
        shape: signal.action === "BUY" ? "arrowUp" : "arrowDown",
        text: `${signal.action} ${signal.confidence}%`,
      };
      candleSeries.setMarkers([marker]);
    }
  }

  function selectTimeframe(timeframe) {
    if (!document.querySelector(`[data-timeframe="${timeframe}"]`)) return;
    if (timeframe !== selectedTimeframe) {
      selectedSignalId = undefined;
      clearSignalLines();
    }
    selectedTimeframe = timeframe;
    document.querySelectorAll("[data-timeframe]").forEach((item) =>
      item.classList.toggle("selected", item.dataset.timeframe === timeframe)
    );
    loadMarket();
  }

  function openSignal(signal) {
    selectedSignalId = signal.id;
    if (signal.asset !== selectedAsset) {
      selectedAsset = signal.asset;
      liveCandles = [];
      marketPollingEnabled = true;
      clearSignalLines();
      renderAssetTabs();
    }
    if (signal.timeframe !== selectedTimeframe) {
      selectedTimeframe = signal.timeframe;
      document.querySelectorAll("[data-timeframe]").forEach((item) =>
        item.classList.toggle("selected", item.dataset.timeframe === selectedTimeframe)
      );
    }
    byId("chart-asset-name").textContent = assetLabel(signal.asset);
    byId("chart-asset-code").textContent = signal.asset;
    byId("signal-stream").scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (
      signal.asset === chartAsset &&
      signal.timeframe === chartTimeframe &&
      liveCandles.length
    ) {
      drawSignalOverlay(signal);
      renderSignalStream(lastSignals);
      return;
    }
    loadMarket();
  }

  function initializeChart() {
    if (!window.LightweightCharts) {
      byId("chart").textContent = "Chart library could not be loaded. Check your internet connection.";
      byId("chart").classList.add("chart-error");
      return;
    }
    const chartContainer = byId("chart");
    const getChartSize = () => ({
      width: Math.floor(chartContainer.getBoundingClientRect().width),
      height: window.matchMedia("(max-width: 768px)").matches ? 360 : 560,
    });
    const initialSize = getChartSize();
    chart = LightweightCharts.createChart(byId("chart"), {
      layout: { background: { type: "solid", color: "#07090e" }, textColor: "#94a3b8", fontFamily: '"JetBrains Mono", monospace', fontSize: 10 },
      grid: { vertLines: { color: "rgba(255, 255, 255, 0.03)" }, horzLines: { color: "rgba(255, 255, 255, 0.03)" } },
      rightPriceScale: { borderColor: "#26313a" },
      timeScale: { borderColor: "#26313a", timeVisible: true, secondsVisible: false },
      crosshair: {
        vertLine: { color: "#00e5ff", width: 1, style: LightweightCharts.LineStyle.Dashed },
        horzLine: { color: "#00e5ff", width: 1, style: LightweightCharts.LineStyle.Dashed },
      },
      handleScroll: { pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false, mouseWheel: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      width: initialSize.width,
      height: initialSize.height,
    });
    candleSeries = chart.addCandlestickSeries({
      upColor: "#00ff88", downColor: "#ff3366", borderUpColor: "#00ff88",
      borderDownColor: "#ff3366", wickUpColor: "#00ff88", wickDownColor: "#ff3366",
    });
    ema20Series = chart.addLineSeries({ color: "#ffb703", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ema50Series = chart.addLineSeries({ color: "#00e5ff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    let appliedWidth = initialSize.width;
    let appliedHeight = initialSize.height;
    const resizeChart = () => {
      if (!chart) return;
      const { width, height } = getChartSize();
      if (width <= 0 || (width === appliedWidth && height === appliedHeight)) return;
      chart.applyOptions({ width, height });
      appliedWidth = width;
      appliedHeight = height;
    };
    new ResizeObserver(resizeChart).observe(chartContainer);
    window.addEventListener("resize", resizeChart, { passive: true });
    window.addEventListener("orientationchange", resizeChart, { passive: true });
  }

  function calculateEmaSeries(candles, period) {
    const multiplier = 2 / (period + 1);
    let ema = 0;
    const values = [];
    for (let index = 0; index < candles.length; index += 1) {
      if (index === period - 1) {
        ema = candles.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) / period;
        values.push({ time: candles[index].time, value: ema });
      } else if (index >= period) {
        ema = (candles[index].close - ema) * multiplier + ema;
        values.push({ time: candles[index].time, value: ema });
      }
    }
    return values;
  }

  function updateMarketStrip(symbol, candles) {
    const price = candles.at(-1).close;
    const key = symbol.replace(/[^A-Z0-9]/g, "-");
    const priceElement = byId(`price-${key}`);
    const changeElement = byId(`change-${key}`);
    if (priceElement) priceElement.textContent = formatPrice(price, symbol);
    if (changeElement) {
      const previous = previousPrices[symbol];
      changeElement.textContent = previous === undefined
        ? "LIVE"
        : `${price > previous ? "▲" : price < previous ? "▼" : "•"} ${formatPrice(Math.abs(price - previous), symbol)}`;
      changeElement.classList.toggle("up", previous !== undefined && price > previous);
      changeElement.classList.toggle("down", previous !== undefined && price < previous);
    }
    previousPrices[symbol] = price;
    if (symbol === selectedAsset) byId("main-price").textContent = formatPrice(price, symbol);
  }

  function setIndicatorNote(element, text, tone) {
    element.textContent = text;
    element.classList.remove("positive", "negative");
    if (tone) element.classList.add(tone);
  }

  function renderIndicators(analysis, symbol) {
    const values = analysis.indicators;
    byId("indicator-rsi").textContent = values.rsi.toFixed(1);
    setIndicatorNote(
      byId("rsi-note"),
      values.rsi < 30 ? "OVERSOLD" : values.rsi > 70 ? "OVERBOUGHT" : "NEUTRAL",
      values.rsi < 30 ? "positive" : values.rsi > 70 ? "negative" : ""
    );
    byId("indicator-emas").textContent = [values.ema20, values.ema50, values.ema200]
      .map((value) => formatPrice(value, symbol)).join(" / ");
    const emaBullish = values.ema20 > values.ema50;
    setIndicatorNote(byId("ema-note"), emaBullish ? "BULLISH ALIGNMENT" : "BEARISH ALIGNMENT", emaBullish ? "positive" : "negative");
    byId("indicator-macd").textContent = values.macd.toFixed(precision(symbol));
    const macdBullish = values.macd > values.macdSignal;
    setIndicatorNote(byId("macd-note"), macdBullish ? "BULLISH" : "BEARISH", macdBullish ? "positive" : "negative");
    byId("indicator-atr").textContent = formatPrice(values.atr, symbol);
  }

  function appendTags(element, items, emptyText) {
    element.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("span");
      empty.className = "empty-pattern";
      empty.textContent = emptyText;
      element.append(empty);
      return;
    }
    for (const item of items) {
      const tag = document.createElement("span");
      tag.className = "pattern-tag";
      tag.textContent = item;
      element.append(tag);
    }
  }

  function renderSignal(analysis, news, signal, symbol) {
    const trade = signal && !signal.closedAt ? signal : null;
    const visibleAction = trade ? trade.action : "HOLD";
    const status = byId("signal-status");
    status.classList.remove("buy", "sell", "hold");
    status.classList.add(visibleAction.toLowerCase());
    byId("signal-symbol").textContent = symbol;
    byId("signal-action").textContent = visibleAction === "BUY"
      ? "STRONG BUY"
      : visibleAction === "SELL" ? "STRONG SELL" : "HOLD";
    byId("signal-caption").textContent = news.highImpactWarning
      ? "HIGH-IMPACT EVENT DUE · NO ENTRY"
      : news.calendarStatus !== "ok"
        ? "CALENDAR UNAVAILABLE · NO ENTRY"
        : visibleAction === "HOLD"
          ? analysis.isFresh ? "WAITING FOR ALL CONFLUENCES" : "LATEST CANDLE IS STALE"
          : `${visibleAction === "BUY" ? "BULLISH" : "BEARISH"} SETUP · ${selectedTimeframe.toUpperCase()}`;
    const confidence = trade ? trade.confidence : analysis.confidence;
    byId("confidence-value").innerHTML = `${confidence}<small>%</small>`;
    byId("confidence-bar").style.width = `${confidence}%`;
    byId("confidence-bar").classList.toggle("qualified", visibleAction !== "HOLD");
    const riskLevel = trade?.riskLevel || analysis.riskLevel || "MEDIUM";
    const riskBadge = byId("risk-badge");
    riskBadge.classList.remove("risk-low", "risk-medium", "risk-high");
    riskBadge.classList.add(`risk-${riskLevel.toLowerCase()}`);
    const riskLabel = riskLevel === "LOW"
      ? "LOW RISK / SAFE SETUP"
      : riskLevel === "HIGH" ? "HIGH RISK WARNING" : "MEDIUM RISK";
    riskBadge.querySelector("strong").textContent = riskLabel;
    byId("signal-zone").textContent = trade
      ? `${formatPrice(trade.entryZone[0], symbol)} - ${formatPrice(trade.entryZone[1], symbol)}`
      : "—";
    byId("signal-sl").textContent = trade ? formatPrice(trade.stopLoss, symbol) : "—";
    byId("signal-tp1").textContent = trade ? `${formatPrice(trade.target1, symbol)}${trade.tp1Hit ? " · HIT" : ""}` : "—";
    byId("signal-tp2").textContent = trade ? formatPrice(trade.target2, symbol) : "—";
    byId("signal-time").textContent = trade
      ? `${new Date(trade.entryTime).toLocaleString()} · ${trade.timeframe.toUpperCase()}`
      : "—";

    const patterns = [
      ...analysis.smc.map((item) => item.name),
      ...analysis.patterns.map((item) => item.name),
      ...(analysis.crossovers.goldenCross ? ["Golden Cross"] : []),
      ...(analysis.crossovers.deathCross ? ["Death Cross"] : []),
    ];
    appendTags(byId("pattern-tags"), [...new Set(patterns)], "No confirmed patterns");
    const reasons = byId("reason-list");
    reasons.replaceChildren();
    const signalReasons = trade?.reasons || analysis.reasons;
    const reasonItems = signalReasons.length ? signalReasons : [
      news.highImpactWarning
        ? "High-impact calendar event blocks new entries"
        : news.calendarStatus !== "ok"
          ? "Economic calendar unavailable; entries are disabled"
          : "Technical, SMC, indicator, or sentiment confluence below threshold",
    ];
    for (const reason of reasonItems) {
      const item = document.createElement("li");
      item.textContent = reason;
      reasons.append(item);
    }
  }

  function renderNews(news) {
    const mood = byId("news-mood");
    mood.classList.remove("bullish", "bearish", "neutral");
    const sentiment = news.sentiment;
    const tone = sentiment.score >= 0.15 ? "bullish" : sentiment.score <= -0.15 ? "bearish" : "neutral";
    mood.classList.add(tone);
    byId("news-sentiment").textContent = `${sentiment.label.toUpperCase()} · ${sentiment.score.toFixed(2)}`;

    const warning = byId("volatility-warning");
    warning.hidden = !news.highImpactWarning;
    if (news.highImpactWarning) {
      const event = news.calendar.find((item) =>
        item.impact.toLowerCase() === "high" && Date.parse(item.time) <= Date.now() + 15 * 60 * 1000
      );
      byId("warning-detail").textContent = event
        ? `${event.currency} · ${event.title} · ${new Date(event.time).toLocaleTimeString()}`
        : "High-impact economic event due within 15 minutes.";
    }

    const feedState = news.newsStatus === "ok" ? "News feed live" : `News feed ${news.newsStatus}`;
    const calendarState = news.calendarStatus === "ok" ? "Economic calendar live" : `Economic calendar ${news.calendarStatus}`;
    const issues = [news.newsError, news.calendarError].filter(Boolean);
    byId("news-source-status").textContent =
      `${feedState} · ${calendarState}${issues.length ? ` · ${issues.join(" · ")}` : ""}`;

    const newsList = byId("news-list");
    newsList.replaceChildren();
    if (!news.articles.length) {
      const empty = document.createElement("p");
      empty.className = "empty-news";
      empty.textContent = news.newsStatus === "unavailable"
        ? "News feed is unavailable; news confirmation is not available."
        : "No directly relevant headlines in the latest feed.";
      newsList.append(empty);
    } else {
      for (const article of news.articles) {
        const row = document.createElement("article");
        row.className = "news-item";
        const headline = document.createElement(article.link ? "a" : "span");
        headline.className = "news-title";
        headline.textContent = article.title;
        if (article.link) {
          try {
            const link = new URL(article.link);
            if (link.protocol === "https:" || link.protocol === "http:") {
              headline.href = link.href;
              headline.target = "_blank";
              headline.rel = "noopener noreferrer";
            }
          } catch (error) {
            console.warn("Ignoring malformed news link:", error.message);
          }
        }
        const metadata = document.createElement("span");
        metadata.className = "news-meta";
        metadata.textContent = `${article.impact.toUpperCase()} IMPACT · ${article.sentiment.toUpperCase()} · ${article.publishedAt ? new Date(article.publishedAt).toLocaleString() : "TIME N/A"}`;
        row.append(headline, metadata);
        newsList.append(row);
      }
    }

    const calendarList = byId("calendar-list");
    calendarList.replaceChildren();
    if (!news.calendar.length) {
      const empty = document.createElement("p");
      empty.className = "empty-news";
      empty.textContent = news.calendarStatus === "ok"
        ? "No relevant events in the next 24 hours."
        : "Calendar is unavailable. Signal entries are disabled until it reconnects.";
      calendarList.append(empty);
    } else {
      for (const event of news.calendar) {
        const row = document.createElement("div");
        row.className = `calendar-item impact-${event.impact.toLowerCase()}`;
        const title = document.createElement("span");
        title.className = "calendar-event";
        title.textContent = `${event.currency} · ${event.title}`;
        const time = document.createElement("span");
        time.className = "calendar-meta";
        time.textContent = `${event.impact.toUpperCase()} · ${new Date(event.time).toLocaleString()}`;
        row.append(title, time);
        calendarList.append(row);
      }
    }
  }

  function pipsForSignal(signal) {
    const pip = PIP_SIZE[signal.asset] ?? (signal.asset.endsWith("/JPY") ? 0.01 : 0.0001);
    const direction = signal.action === "BUY" ? 1 : -1;
    let movement;
    if (signal.outcome === "TP2 Hit") {
      movement = ((signal.target1 + signal.target2) / 2) - signal.entryPrice;
    } else if (signal.outcome === "TP1 Hit") {
      movement = (signal.target1 - signal.entryPrice) * 0.5;
    } else {
      movement = (signal.exitPrice ?? signal.stopLoss) - signal.entryPrice;
    }
    return movement * direction / pip;
  }

  function renderHistory(signals) {
    lastSignals = signals;
    const body = byId("history-body");
    body.replaceChildren();
    byId("history-count").textContent = `${signals.length} RECORD${signals.length === 1 ? "" : "S"}`;
    byId("total-calls").textContent = signals.length;
    const closed = signals.filter((signal) => signal.closedAt || ["TP2 Hit", "SL Hit", "TP1 Hit"].includes(signal.outcome));
    const wins = closed.filter((signal) => ["TP2 Hit", "TP1 Hit"].includes(signal.outcome)).length;
    byId("win-rate").innerHTML = `${closed.length ? Math.round((wins / closed.length) * 100) : "—"}<small>%</small>`;
    const totalPoints = closed.reduce((sum, signal) => sum + pipsForSignal(signal), 0);
    const profitLoss = byId("profit-loss");
    profitLoss.innerHTML = `${totalPoints > 0 ? "+" : ""}${totalPoints.toFixed(1)}<span class="unit"> pts</span>`;
    profitLoss.classList.toggle("positive", totalPoints > 0);
    profitLoss.classList.toggle("negative", totalPoints < 0);
    byId("active-calls").textContent = signals.filter((signal) =>
      !signal.closedAt && !["TP2 Hit", "SL Hit", "TP1 Hit"].includes(signal.outcome)
    ).length;

    if (!signals.length || !filteredSignals(signals).length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 10;
      cell.className = "table-empty";
      cell.textContent = signals.length
        ? "No calls match this outcome filter."
        : "No signals generated yet. The engine is monitoring for confluence.";
      row.append(cell);
      body.append(row);
      return;
    }

    for (const signal of filteredSignals(signals).slice(0, 100)) {
      const row = document.createElement("tr");
      const targetOne = signal.target1 ?? signal.takeProfit ?? 0;
      const targetTwo = signal.target2 ?? signal.takeProfit ?? 0;
      const targetText = `${formatPrice(targetOne, signal.asset)} / ${formatPrice(targetTwo, signal.asset)}`;
      const values = [
        [signal.asset, "table-asset"],
        [signal.action, signal.action === "BUY" ? "action-buy" : "action-sell"],
        [`${new Date(signal.entryTime).toLocaleString()} · ${(signal.timeframe || "—").toUpperCase()}`],
        [formatPrice(signal.entryPrice, signal.asset)],
        [targetText],
        [formatPrice(signal.stopLoss, signal.asset)],
        [`${signal.confidence}%`],
        [signal.riskLevel || "MEDIUM", `risk-text risk-${(signal.riskLevel || "MEDIUM").toLowerCase()}`],
        [signal.newsContext || "—", "news-context"],
        [signal.outcome, signal.outcome === "Active" || signal.outcome === "TP1 Hit · Active" ? "outcome-active" : ["TP2 Hit", "TP1 Hit"].includes(signal.outcome) ? "outcome-win" : "outcome-loss"],
      ];
      for (const [value, className = ""] of values) {
        const cell = document.createElement("td");
        if (className.startsWith("outcome-")) {
          cell.className = "outcome-cell";
          const badge = document.createElement("span");
          badge.className = `status-pill ${className}`;
          badge.textContent = value;
          cell.append(badge);
        } else {
          cell.textContent = value;
          if (className) cell.className = className;
        }
        row.append(cell);
      }

      function filteredSignals(signals) {
        if (historyFilter === "active") return signals.filter(selectedSignal);
        if (historyFilter === "wins") return signals.filter((signal) =>
          signal.outcome === "TP2 Hit" || signal.outcome?.startsWith("TP1 Hit")
        );
        if (historyFilter === "losses") return signals.filter((signal) => signal.outcome === "SL Hit");
        return signals;
      }
      row.classList.add("table-row-clickable");
      row.title = "Select this signal to load its chart levels.";
      row.addEventListener("click", () => openSignal(signal));
      body.append(row);
    }
    renderSignalStream(signals);
    if (selectedSignalId) {
      const activeOverlay = signals.find((signal) => signal.id === selectedSignalId);
      if (activeOverlay && activeOverlay.asset === selectedAsset && activeOverlay.timeframe === selectedTimeframe) {
        drawSignalOverlay(activeOverlay);
      }
    }
  }

  function renderSignalStream(signals) {
    const stream = byId("signal-stream");
    stream.replaceChildren();
    const active = signals.filter(selectedSignal).slice(0, 12);
    byId("stream-count").textContent = `${active.length} ACTIVE`;
    if (!active.length) {
      const empty = document.createElement("div");
      empty.className = "stream-empty";
      empty.textContent = "Listening for qualified calls across the watchlist...";
      stream.append(empty);
      return;
    }
    for (const signal of active) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `signal-card ${signal.action.toLowerCase()}`;
      card.addEventListener("click", () => openSignal(signal));
      const top = document.createElement("div");
      top.className = "signal-card-top";
      const symbol = document.createElement("span");
      symbol.className = "signal-card-asset";
      symbol.textContent = `${assetLabel(signal.asset)} · ${signal.asset}`;
      const action = document.createElement("span");
      action.className = `signal-card-action ${signal.action.toLowerCase()}`;
      action.textContent = signal.action === "BUY" ? "STRONG BUY" : "STRONG SELL";
      top.append(symbol, action);
      const levels = document.createElement("div");
      levels.className = "signal-card-levels";
      for (const [label, value] of [
        ["ENTRY", signal.entryPrice],
        ["TP1", signal.target1],
        ["TP2", signal.target2],
        ["SL", signal.stopLoss],
      ]) {
        const level = document.createElement("span");
        level.textContent = `${label} ${formatPrice(value, signal.asset)}`;
        levels.append(level);
      }
      const bottom = document.createElement("div");
      bottom.className = "signal-card-bottom";
      const timestamp = document.createElement("span");
      timestamp.textContent = `${signal.confidence}% · ${new Date(signal.entryTime).toLocaleString()} · ${signal.timeframe.toUpperCase()}`;
      const risk = document.createElement("span");
      const riskLevel = signal.riskLevel || "MEDIUM";
      risk.className = `risk-pill risk-${riskLevel.toLowerCase()}`;
      risk.textContent = `${riskLevel} RISK`;
      bottom.append(timestamp, risk);
      const confidence = document.createElement("div");
      confidence.className = "signal-card-confidence";
      const confidenceLabel = document.createElement("span");
      confidenceLabel.textContent = "CONFLUENCE";
      const confidenceValue = document.createElement("strong");
      const confidenceScore = Math.max(0, Math.min(100, Number(signal.confidence) || 0));
      confidenceValue.textContent = `${confidenceScore}%`;
      const confidenceTrack = document.createElement("div");
      confidenceTrack.className = "signal-card-track";
      confidenceTrack.setAttribute("role", "meter");
      confidenceTrack.setAttribute("aria-label", `Signal confidence ${confidenceScore}%`);
      confidenceTrack.setAttribute("aria-valuemin", "0");
      confidenceTrack.setAttribute("aria-valuemax", "100");
      confidenceTrack.setAttribute("aria-valuenow", String(confidenceScore));
      const confidenceFill = document.createElement("span");
      confidenceFill.style.width = `${confidenceScore}%`;
      confidenceFill.classList.toggle("qualified", confidenceScore >= 75);
      confidenceTrack.append(confidenceFill);
      confidence.append(confidenceLabel, confidenceValue, confidenceTrack);
      card.append(top, levels, confidence, bottom);
      stream.append(card);
    }
  }

  async function loadHistory() {
    const response = await fetch("/api/signals");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load signal history.");
    renderHistory(payload.signals);
  }

  async function loadNews(symbol) {
    const response = await fetch(`/api/news?symbol=${encodeURIComponent(symbol)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load market news.");
    renderNews(payload);
  }

  async function loadMarket() {
    if (requestInProgress) {
      refreshPending = true;
      return;
    }
    requestInProgress = true;
    const requestedAsset = selectedAsset;
    const requestedTimeframe = selectedTimeframe;
    byId("chart-update").textContent = "UPDATING...";
    try {
      const query = new URLSearchParams({ symbol: requestedAsset, timeframe: requestedTimeframe });
      const response = await fetch(`/api/market?${query}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Market data request failed.");
      updateMarketStrip(requestedAsset, payload.candles);
      if (requestedAsset !== selectedAsset || requestedTimeframe !== selectedTimeframe) {
        refreshPending = true;
        return;
      }
      candleSeries?.setData(payload.candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
      liveCandles = payload.candles;
      chartAsset = requestedAsset;
      chartTimeframe = requestedTimeframe;
      ema20Series?.setData(calculateEmaSeries(payload.candles, 20));
      ema50Series?.setData(calculateEmaSeries(payload.candles, 50));
      chart?.timeScale().fitContent();
      byId("chart-update").textContent = `UPDATED ${new Date(payload.updatedAt).toLocaleTimeString()}`;
      byId("chart-asset-name").textContent = assetLabel(requestedAsset);
      byId("chart-asset-code").textContent = requestedAsset;
      renderIndicators(payload.analysis, requestedAsset);
      renderNews(payload.news);
      renderSignal(payload.analysis, payload.news, payload.signal, requestedAsset);
      if (selectedSignalId) {
        const chosen = lastSignals.find((item) => item.id === selectedSignalId);
        if (chosen && chosen.asset === requestedAsset && chosen.timeframe === requestedTimeframe) {
          drawSignalOverlay(chosen);
        } else if (payload.signal && payload.signal.asset === requestedAsset) {
          drawSignalOverlay(payload.signal);
        }
      } else if (selectedSignal(payload.signal)) {
        drawSignalOverlay(payload.signal);
      } else {
        clearSignalLines();
      }
      await loadHistory();
      byId("notice").hidden = true;
      setConnection(true, "LIVE DATA");
    } catch (error) {
      if (requestedAsset === selectedAsset && requestedTimeframe === selectedTimeframe) {
        byId("chart-update").textContent = "UPDATE FAILED";
        setConnection(false, "DATA ERROR");
        showNotice(error.message);
        if (error.message.includes("TWELVEDATA_API_KEY")) marketPollingEnabled = false;
        try {
          await loadNews(requestedAsset);
        } catch (newsError) {
          console.error("Market news fallback failed:", newsError.message);
        }
      }
    } finally {
      requestInProgress = false;
      if (refreshPending) {
        refreshPending = false;
        loadMarket();
      }
    }
  }

  async function searchAssets(event) {
    event.preventDefault();
    const query = byId("asset-search-input").value.trim();
    if (query.length < 2) {
      showNotice("Enter at least two characters to search for a market.");
      return;
    }
    const button = byId("asset-search-button");
    button.disabled = true;
    button.textContent = "SEARCHING...";
    byId("search-help").textContent = "Searching Twelve Data instruments...";
    try {
      const response = await fetch(`/api/assets/search?q=${encodeURIComponent(query)}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Market search failed.");
      searchResults = payload.assets;
      const resultPanel = byId("search-results");
      resultPanel.replaceChildren();
      resultPanel.hidden = searchResults.length === 0;
      for (const result of searchResults) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "search-result";
        option.setAttribute("role", "option");
        const name = document.createElement("span");
        name.textContent = `${result.symbol} · ${result.label}`;
        const category = document.createElement("small");
        category.textContent = result.category;
        option.append(name, category);
        option.addEventListener("click", () => addAsset(result));
        resultPanel.append(option);
      }
      byId("search-help").textContent = searchResults.length
        ? `${searchResults.length} instrument${searchResults.length === 1 ? "" : "s"} found. Select one to add it.`
        : "No matching instruments found.";
    } catch (error) {
      byId("search-help").textContent = error.message;
      showNotice(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "SEARCH";
    }
  }

  function addAsset(asset) {
    assetsBySymbol.set(asset.symbol, asset);
    if (!watchlist.includes(asset.symbol)) {
      watchlist = [...watchlist, asset.symbol];
      saveWatchlist();
    }
    byId("search-results").hidden = true;
    byId("search-help").textContent = `${asset.symbol} added to your watchlist.`;
    selectAsset(asset.symbol);
    renderAssetTabs();
  }

  function updateClock() {
    byId("current-time").textContent = `${new Date().toISOString().slice(11, 19)} UTC`;
  }

  function handleLiveMarket(update) {
    const candle = update.candle;
    const key = update.asset.replace(/[^A-Z0-9]/g, "-");
    const priceElement = byId(`price-${key}`);
    const changeElement = byId(`change-${key}`);
    if (priceElement) priceElement.textContent = formatPrice(candle.close, update.asset);
    if (changeElement) {
      changeElement.textContent = candle.closed ? "LIVE · CLOSED" : "LIVE · STREAM";
      changeElement.classList.remove("up", "down");
    }
    previousPrices[update.asset] = candle.close;

    if (update.asset !== selectedAsset || update.timeframe !== selectedTimeframe) return;
    byId("main-price").textContent = formatPrice(candle.close, update.asset);
    if (!candleSeries || !liveCandles.length) return;
    const updateCandle = {
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    };
    const last = liveCandles.at(-1);
    if (last.time === candle.time) liveCandles[liveCandles.length - 1] = { ...last, ...updateCandle, volume: candle.volume };
    else if (last.time < candle.time) liveCandles.push({ ...updateCandle, volume: candle.volume });
    else return;
    candleSeries.update(updateCandle);
    ema20Series?.setData(calculateEmaSeries(liveCandles, 20));
    ema50Series?.setData(calculateEmaSeries(liveCandles, 50));
  }

  function connectLiveSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    liveSocket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    liveSocket.addEventListener("open", () => {
      websocketRetryDelay = 1000;
      liveSocket.send(JSON.stringify({ type: "subscribe", assets: watchlist }));
    });
    liveSocket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "market") handleLiveMarket(message);
        if (message.type === "provider" && message.provider === "binance") {
          const label = message.status === "connected" ? "LIVE STREAM" : "STREAM RECONNECTING";
          setConnection(message.status === "connected", label);
        }
        if (message.type === "signal" || message.type === "signals-updated") {
          loadHistory().catch((error) => showNotice(error.message));
        }
      } catch (error) {
        console.error("Could not process live market update:", error.message);
      }
    });
    liveSocket.addEventListener("close", () => {
      setConnection(false, "STREAM RECONNECTING");
      setTimeout(connectLiveSocket, websocketRetryDelay);
      websocketRetryDelay = Math.min(websocketRetryDelay * 2, 30_000);
    });
    liveSocket.addEventListener("error", () => liveSocket.close());
  }

  document.querySelectorAll("[data-timeframe]").forEach((button) => {
    button.addEventListener("click", () => {
      selectTimeframe(button.dataset.timeframe);
    });
    document.querySelectorAll("[data-history-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        historyFilter = button.dataset.historyFilter;
        document.querySelectorAll("[data-history-filter]").forEach((item) => {
          const selected = item === button;
          item.classList.toggle("selected", selected);
          item.setAttribute("aria-pressed", String(selected));
        });
        renderHistory(lastSignals);
      });
    });
  });
  const mobileSections = [...document.querySelectorAll(".mobile-nav a")];
  mobileSections.forEach((link) => {
    link.addEventListener("click", () => {
      mobileSections.forEach((item) => item.removeAttribute("aria-current"));
      link.setAttribute("aria-current", "location");
    });
  });
  if ("IntersectionObserver" in window) {
    const sectionObserver = new IntersectionObserver((entries) => {
      const visibleSection = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      if (!visibleSection) return;
      const activeLink = mobileSections.find(
        (link) => link.hash === `#${visibleSection.target.id}`
      );
      if (!activeLink) return;
      mobileSections.forEach((link) => link.removeAttribute("aria-current"));
      activeLink.setAttribute("aria-current", "location");
    }, { rootMargin: "-15% 0px -65% 0px", threshold: [0, 0.1, 0.5] });
    mobileSections.forEach((link) => {
      const section = document.querySelector(link.hash);
      if (section) sectionObserver.observe(section);
    });
  }
  byId("asset-search-form").addEventListener("submit", searchAssets);

  renderAssetTabs();
  initializeChart();
  updateClock();
  connectLiveSocket();
  setInterval(updateClock, 1000);
  loadMarket();
  loadHistory().catch((error) => showNotice(error.message));
  setInterval(() => {
    if (marketPollingEnabled) loadMarket();
  }, REFRESH_MS);
})();
