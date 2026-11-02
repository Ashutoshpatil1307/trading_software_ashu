const { EMA, RSI, MACD, ATR, BollingerBands } = require("technicalindicators");
const { TIMEFRAMES } = require("./market-data");

function isBullish(candle) {
  return candle.close > candle.open;
}

function isBearish(candle) {
  return candle.close < candle.open;
}

function findSwings(candles, radius = 2) {
  const highs = [];
  const lows = [];
  for (let index = radius; index < candles.length - radius; index += 1) {
    const candle = candles[index];
    if (candles.slice(index - radius, index + radius + 1).every((item) => candle.high >= item.high)) {
      highs.push({ index, price: candle.high });
    }
    if (candles.slice(index - radius, index + radius + 1).every((item) => candle.low <= item.low)) {
      lows.push({ index, price: candle.low });
    }
  }
  return { highs, lows };
}

function detectCandlestickPatterns(candles) {
  const found = [];
  const last = candles.at(-1);
  const previous = candles.at(-2);
  const third = candles.at(-3);
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;

  if (range > 0 && body / range < 0.1) found.push({ name: "Doji", direction: "neutral" });
  if (range > 0 && lowerWick >= body * 2 && upperWick <= body && body / range < 0.4) {
    found.push({ name: "Hammer / Pinbar", direction: "bullish" });
  }
  if (range > 0 && upperWick >= body * 2 && lowerWick <= body && body / range < 0.4) {
    found.push({ name: "Shooting Star / Pinbar", direction: "bearish" });
  }
  if (isBullish(last) && isBearish(previous) && last.open <= previous.close && last.close >= previous.open) {
    found.push({ name: "Bullish Engulfing", direction: "bullish" });
  }
  if (isBearish(last) && isBullish(previous) && last.open >= previous.close && last.close <= previous.open) {
    found.push({ name: "Bearish Engulfing", direction: "bearish" });
  }
  if (
    isBearish(third) &&
    Math.abs(previous.close - previous.open) < Math.abs(third.close - third.open) * 0.5 &&
    isBullish(last) &&
    last.close > (third.open + third.close) / 2
  ) {
    found.push({ name: "Morning Star", direction: "bullish" });
  }
  if (
    isBullish(third) &&
    Math.abs(previous.close - previous.open) < Math.abs(third.close - third.open) * 0.5 &&
    isBearish(last) &&
    last.close < (third.open + third.close) / 2
  ) {
    found.push({ name: "Evening Star", direction: "bearish" });
  }
  return found;
}

function detectPriceAction(candles, atr) {
  const recent = candles.slice(-100);
  const last = candles.at(-1);
  const patterns = [];
  const smc = [];
  const { highs, lows } = findSwings(recent);
  const oldHigh = highs.filter((point) => point.index < recent.length - 3).at(-1);
  const oldLow = lows.filter((point) => point.index < recent.length - 3).at(-1);
  const lastTwoHighs = highs.slice(-2);
  const lastTwoLows = lows.slice(-2);
  const uptrend = lastTwoHighs.length === 2 &&
    lastTwoLows.length === 2 &&
    lastTwoHighs[1].price > lastTwoHighs[0].price &&
    lastTwoLows[1].price > lastTwoLows[0].price;
  const downtrend = lastTwoHighs.length === 2 &&
    lastTwoLows.length === 2 &&
    lastTwoHighs[1].price < lastTwoHighs[0].price &&
    lastTwoLows[1].price < lastTwoLows[0].price;

  if (oldHigh && last.close > oldHigh.price) {
    smc.push({ name: downtrend ? "Bullish CHoCH" : "Bullish BOS", direction: "bullish", level: oldHigh.price });
  }
  if (oldLow && last.close < oldLow.price) {
    smc.push({ name: uptrend ? "Bearish CHoCH" : "Bearish BOS", direction: "bearish", level: oldLow.price });
  }

  const fvgStart = Math.max(2, recent.length - 24);
  for (let index = fvgStart; index < recent.length; index += 1) {
    const left = recent[index - 2];
    const right = recent[index];
    if (right.low > left.high && right.low - left.high >= atr * 0.08) {
      smc.push({ name: "Bullish FVG", direction: "bullish", level: (right.low + left.high) / 2 });
    }
    if (right.high < left.low && left.low - right.high >= atr * 0.08) {
      smc.push({ name: "Bearish FVG", direction: "bearish", level: (right.high + left.low) / 2 });
    }
  }

  const averageBody = recent.slice(-10, -1)
    .reduce((sum, candle) => sum + Math.abs(candle.close - candle.open), 0) / 9;
  if (lastTwoHighs.length && last.close > lastTwoHighs.at(-1).price && Math.abs(last.close - last.open) > averageBody * 1.4) {
    const orderBlock = recent.slice(-8, -1).reverse().find(isBearish);
    if (orderBlock) smc.push({ name: "Bullish Order Block", direction: "bullish", level: orderBlock.open });
  }
  if (lastTwoLows.length && last.close < lastTwoLows.at(-1).price && Math.abs(last.close - last.open) > averageBody * 1.4) {
    const orderBlock = recent.slice(-8, -1).reverse().find(isBullish);
    if (orderBlock) smc.push({ name: "Bearish Order Block", direction: "bearish", level: orderBlock.open });
  }

  const liquidityWindow = recent.slice(-21, -1);
  const priorHigh = Math.max(...liquidityWindow.map((candle) => candle.high));
  const priorLow = Math.min(...liquidityWindow.map((candle) => candle.low));
  if (last.high > priorHigh && last.close < priorHigh) {
    smc.push({ name: "Buy-side Liquidity Sweep", direction: "bearish", level: priorHigh });
  }
  if (last.low < priorLow && last.close > priorLow) {
    smc.push({ name: "Sell-side Liquidity Sweep", direction: "bullish", level: priorLow });
  }
  if (oldHigh && Math.abs(last.low - oldHigh.price) <= atr * 0.2 && last.close > oldHigh.price) {
    smc.push({ name: "Resistance Retest", direction: "bullish", level: oldHigh.price });
  }
  if (oldLow && Math.abs(last.high - oldLow.price) <= atr * 0.2 && last.close < oldLow.price) {
    smc.push({ name: "Support Retest", direction: "bearish", level: oldLow.price });
  }

  const peakPair = lastTwoHighs;
  const lowPair = lastTwoLows;
  const similarHighs = peakPair.length === 2 &&
    Math.abs(peakPair[0].price - peakPair[1].price) / peakPair[0].price < 0.004;
  const similarLows = lowPair.length === 2 &&
    Math.abs(lowPair[0].price - lowPair[1].price) / lowPair[0].price < 0.004;
  const headShoulders = highs.slice(-3);
  const inverseHeadShoulders = lows.slice(-3);
  if (peakPair.length === 2 && lowPair.length === 2) {
    if (similarHighs && peakPair[1].index - peakPair[0].index >= 4) {
      patterns.push({ name: "Double Top", direction: "bearish" });
    }
    if (similarLows && lowPair[1].index - lowPair[0].index >= 4) {
      patterns.push({ name: "Double Bottom", direction: "bullish" });
    }
    if (
      headShoulders.length === 3 &&
      headShoulders[1].price > headShoulders[0].price &&
      headShoulders[1].price > headShoulders[2].price &&
      Math.abs(headShoulders[0].price - headShoulders[2].price) / headShoulders[1].price < 0.01
    ) {
      patterns.push({ name: "Head & Shoulders", direction: "bearish" });
    }
    if (
      inverseHeadShoulders.length === 3 &&
      inverseHeadShoulders[1].price < inverseHeadShoulders[0].price &&
      inverseHeadShoulders[1].price < inverseHeadShoulders[2].price &&
      Math.abs(inverseHeadShoulders[0].price - inverseHeadShoulders[2].price) / inverseHeadShoulders[1].price < 0.01
    ) {
      patterns.push({ name: "Inverse Head & Shoulders", direction: "bullish" });
    }
  }
  if (peakPair.length === 2 && lowPair.length === 2) {
    const descendingHighs = peakPair[1].price < peakPair[0].price;
    const ascendingLows = lowPair[1].price > lowPair[0].price;
    if (similarHighs && ascendingLows) {
      patterns.push({ name: "Ascending Triangle", direction: "bullish" });
    } else if (descendingHighs && similarLows) {
      patterns.push({ name: "Descending Triangle", direction: "bearish" });
    } else if (descendingHighs && ascendingLows) {
      patterns.push({ name: "Symmetrical Triangle", direction: "neutral" });
    }
  }
  return { patterns, smc };
}

function calculateAnalysis(candles, timeframe, news) {
  const closes = candles.map((candle) => candle.close);
  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });
  const rsi = RSI.calculate({ period: 14, values: closes });
  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const atr = ATR.calculate({
    period: 14,
    high: candles.map((candle) => candle.high),
    low: candles.map((candle) => candle.low),
    close: closes,
  });
  const bands = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
  const current = candles.at(-1);
  const currentEma20 = ema20.at(-1);
  const currentEma50 = ema50.at(-1);
  const currentEma200 = ema200.at(-1);
  const currentRsi = rsi.at(-1);
  const currentMacd = macd.at(-1);
  const currentAtr = atr.at(-1);
  const currentRange = current.high - current.low;
  const wickRatio = currentRange > 0
    ? (currentRange - Math.abs(current.close - current.open)) / currentRange
    : 0;
  const volatilitySpike = currentAtr > 0 &&
    (currentRange > currentAtr * 2.5 || currentRange > 0 && wickRatio > 0.88 && currentRange > currentAtr * 1.8);
  const emaSpread = current.close > 0 ? Math.abs(currentEma20 - currentEma50) / current.close : 0;
  const crossover = {
    goldenCross: currentEma50 > currentEma200 && ema50.at(-2) <= ema200.at(-2),
    deathCross: currentEma50 < currentEma200 && ema50.at(-2) >= ema200.at(-2),
  };
  const priceAction = detectPriceAction(candles, currentAtr);
  const candlePatterns = detectCandlestickPatterns(candles);
  const patterns = [...candlePatterns, ...priceAction.patterns];
  const directionTrend = currentEma20 > currentEma50 &&
    currentEma50 > currentEma200 && current.close > currentEma20
    ? "bullish"
    : currentEma20 < currentEma50 &&
      currentEma50 < currentEma200 && current.close < currentEma20
      ? "bearish"
      : "neutral";
  const choppy = directionTrend === "neutral" || emaSpread < 0.00015;

  const scores = { bullish: 0, bearish: 0 };
  const reasons = { bullish: [], bearish: [] };
  const breakdown = {
    bullish: { trend: 0, smc: 0, indicators: 0, sentiment: 0, candlePattern: 0 },
    bearish: { trend: 0, smc: 0, indicators: 0, sentiment: 0, candlePattern: 0 },
  };
  const addPoints = (direction, points, reason) => {
    if (direction === "bullish" || direction === "bearish") {
      scores[direction] += points;
      reasons[direction].push(reason);
    }
  };
  if (directionTrend !== "neutral") {
    breakdown[directionTrend].trend = 25;
    addPoints(directionTrend, 25, "EMA 20/50/200 trend alignment");
  }

  const requirements = {
    bullish: { trend: directionTrend === "bullish", smc: false, indicators: false, sentiment: false },
    bearish: { trend: directionTrend === "bearish", smc: false, indicators: false, sentiment: false },
  };

  for (const direction of ["bullish", "bearish"]) {
    const setup = priceAction.smc.filter((item) => item.direction === direction);
    const indicatorRsiAligned = direction === "bullish" ? currentRsi >= 40 && currentRsi < 70 : currentRsi <= 60 && currentRsi > 30;
    const indicatorMacdAligned = direction === "bullish"
      ? currentMacd.MACD > currentMacd.signal
      : currentMacd.MACD < currentMacd.signal;
    const priceAligned = direction === "bullish" ? current.close > currentEma20 : current.close < currentEma20;
    const sentimentAligned = direction === "bullish"
      ? news.sentiment.score >= 0.15
      : news.sentiment.score <= -0.15;
    const candleAligned = patterns.some((item) => item.direction === direction);

    if (setup.length) {
      requirements[direction].smc = true;
      breakdown[direction].smc = 25;
      scores[direction] += 25;
      reasons[direction].push(setup.slice(0, 2).map((item) => item.name).join(" + "));
    }
    const indicatorPoints = (indicatorRsiAligned ? 10 : 0) +
      (indicatorMacdAligned ? 10 : 0) + (priceAligned ? 5 : 0);
    breakdown[direction].indicators = indicatorPoints;
    requirements[direction].indicators = indicatorPoints >= 15;
    if (indicatorRsiAligned) reasons[direction].push(`RSI ${currentRsi.toFixed(1)} aligned`);
    if (indicatorMacdAligned) reasons[direction].push("MACD confirmation");
    if (priceAligned) reasons[direction].push("Price aligned with EMA 20");
    if (sentimentAligned) {
      requirements[direction].sentiment = true;
      breakdown[direction].sentiment = 15;
      scores[direction] += 15;
      reasons[direction].push(`News sentiment aligned (${news.sentiment.score.toFixed(2)})`);
    }
    if (candleAligned) {
      breakdown[direction].candlePattern = 10;
      scores[direction] += 10;
      reasons[direction].push(patterns.find((item) => item.direction === direction).name);
    }
    scores[direction] += indicatorPoints;
  }

  scores.bullish = Math.min(100, scores.bullish);
  scores.bearish = Math.min(100, scores.bearish);
  const interval = TIMEFRAMES[timeframe];
  const isFresh = interval && (Date.now() - current.time * 1000) / 1000 <= interval.seconds * 2;
  const newsBlocked = news.calendarStatus !== "ok" || news.highImpactWarning;
  const action = isFresh && !newsBlocked && !volatilitySpike && currentAtr > 0 &&
    requirements.bullish.trend && requirements.bullish.smc &&
    requirements.bullish.indicators && requirements.bullish.sentiment &&
    scores.bullish >= 75 && scores.bullish > scores.bearish
    ? "BUY"
    : isFresh && !newsBlocked && !volatilitySpike && currentAtr > 0 &&
      requirements.bearish.trend && requirements.bearish.smc &&
      requirements.bearish.indicators && requirements.bearish.sentiment &&
      scores.bearish >= 75 && scores.bearish > scores.bullish
      ? "SELL"
      : "HOLD";
  const confidence = action === "BUY"
    ? scores.bullish
    : action === "SELL"
      ? scores.bearish
      : Math.max(scores.bullish, scores.bearish);
  const leadDirection = scores.bullish >= scores.bearish ? "bullish" : "bearish";
  const reasonDirection = action === "BUY" ? "bullish" : action === "SELL" ? "bearish" : leadDirection;
  const reasonsForDisplay = [...reasons[reasonDirection]];
  const leadRequirements = requirements[leadDirection];
  if (!leadRequirements.trend) reasonsForDisplay.push("EMA trend is not fully aligned");
  if (!leadRequirements.smc) reasonsForDisplay.push("No directional SMC setup");
  if (!leadRequirements.indicators) reasonsForDisplay.push("At least two indicator checks are not aligned");
  if (!leadRequirements.sentiment) reasonsForDisplay.push("Relevant news sentiment is neutral or unavailable");
  if (news.highImpactWarning) reasonsForDisplay.push("High-impact event due within 15 minutes; entries blocked");
  if (news.calendarStatus !== "ok") reasonsForDisplay.push("Calendar unavailable; entries blocked");
  if (!isFresh) reasonsForDisplay.push("Latest candle is stale");
  if (volatilitySpike) reasonsForDisplay.push("Erratic candle volatility; entry suppressed");

  const riskLevel = volatilitySpike || news.highImpactWarning
    ? "HIGH"
    : choppy
      ? "MEDIUM"
      : "LOW";

  return {
    indicators: {
      rsi: currentRsi,
      ema20: currentEma20,
      ema50: currentEma50,
      ema200: currentEma200,
      macd: currentMacd.MACD,
      macdSignal: currentMacd.signal,
      atr: currentAtr,
      bollingerUpper: bands.at(-1).upper,
      bollingerMiddle: bands.at(-1).middle,
      bollingerLower: bands.at(-1).lower,
      volume: current.volume,
    },
    crossovers: crossover,
    patterns,
    smc: priceAction.smc.slice(-12),
    trend: directionTrend,
    volatilitySpike,
    riskLevel,
    scores,
    breakdown,
    requirements,
    reasons: reasonsForDisplay,
    isFresh: Boolean(isFresh),
    action,
    confidence,
    entry: current.close,
    candleTime: current.time,
  };
}

module.exports = { calculateAnalysis, detectCandlestickPatterns, detectPriceAction };
