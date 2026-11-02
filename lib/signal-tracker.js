function updateSignalOutcomes(signals, candles, symbol, timeframe) {
  let changed = false;
  for (const signal of signals) {
    if (
      signal.asset !== symbol ||
      signal.timeframe !== timeframe ||
      signal.closedAt ||
      ["TP2 Hit", "SL Hit", "TP1 Hit"].includes(signal.outcome)
    ) {
      continue;
    }

    const laterCandles = candles.filter((candle) =>
      candle.time > signal.entryCandleTime &&
      (
        candle.time > (signal.lastEvaluatedCandleTime || signal.entryCandleTime) ||
        candle.closed !== true &&
        candle.time === signal.lastEvaluatedCandleTime
      )
    );
    for (const candle of laterCandles) {
      const isBuy = signal.action === "BUY";
      const stopHit = isBuy ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;
      const targetOneHit = isBuy ? candle.high >= signal.target1 : candle.low <= signal.target1;
      const targetTwoHit = isBuy ? candle.high >= signal.target2 : candle.low <= signal.target2;

      if (candle.closed) signal.lastEvaluatedCandleTime = candle.time;
      if (candle.closed) changed = true;

      if (stopHit) {
        signal.closedAt = new Date(candle.time * 1000).toISOString();
        if (signal.tp1Hit) {
          signal.outcome = "TP1 Hit";
          signal.exitPrice = signal.entryPrice;
        } else {
          signal.outcome = "SL Hit";
          signal.exitPrice = isBuy
            ? Math.min(candle.open, signal.stopLoss)
            : Math.max(candle.open, signal.stopLoss);
        }
        break;
      }

      if (targetTwoHit) {
        signal.tp1Hit = true;
        if (!signal.firstTargetAt) {
          signal.firstTargetAt = new Date(candle.time * 1000).toISOString();
        }
        signal.outcome = "TP2 Hit";
        signal.exitPrice = isBuy
          ? Math.max(candle.open, signal.target2)
          : Math.min(candle.open, signal.target2);
        signal.closedAt = new Date(candle.time * 1000).toISOString();
        changed = true;
        break;
      }

      if (!signal.tp1Hit && targetOneHit) {
        signal.tp1Hit = true;
        signal.firstTargetAt = new Date(candle.time * 1000).toISOString();
        signal.outcome = "TP1 Hit · Active";
        changed = true;
        break;
      }
    }
  }
  return changed;
}

function createSignal(symbol, timeframe, analysis, news, asset, signals) {
  const existing = signals.find((signal) =>
    signal.asset === symbol &&
    signal.timeframe === timeframe &&
    !signal.closedAt &&
    !["TP2 Hit", "SL Hit", "TP1 Hit"].includes(signal.outcome)
  );
  if (existing) return existing;
  if (analysis.action === "HOLD") return null;

  const sameCandleCall = signals.some((signal) =>
    signal.asset === symbol &&
    signal.timeframe === timeframe &&
    signal.entryCandleTime === analysis.candleTime
  );
  if (sameCandleCall) return null;

  const risk = analysis.indicators.atr * 1.5;
  const entry = Number(analysis.entry.toFixed(asset.decimals));
  const round = (value) => Number(value.toFixed(asset.decimals));
  const direction = analysis.action === "BUY" ? 1 : -1;
  const signal = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    asset: symbol,
    action: analysis.action,
    timeframe,
    entryTime: new Date().toISOString(),
    entryCandleTime: analysis.candleTime,
    entryPrice: entry,
    entryZone: [
      round(entry - analysis.indicators.atr * 0.15),
      round(entry + analysis.indicators.atr * 0.15),
    ],
    target1: round(entry + direction * risk * 1.5),
    target2: round(entry + direction * risk * 3),
    stopLoss: round(entry - direction * risk),
    confidence: analysis.confidence,
    riskLevel: analysis.riskLevel,
    reasons: analysis.reasons,
    sentiment: news.sentiment,
    newsContext: news.articles[0]?.title || "No directly relevant headline",
    tp1Hit: false,
    outcome: "Active",
  };
  signals.unshift(signal);
  return signal;
}

module.exports = { createSignal, updateSignalOutcomes };
