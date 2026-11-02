const Parser = require("rss-parser");

const parser = new Parser({
  timeout: 8000,
  headers: { "User-Agent": "ForexMarketManagement/1.0" },
});
const CACHE_MS = 60_000;
const sentimentCache = new Map();
const positiveWords = new Set([
  "beat", "bull", "bullish", "growth", "gain", "gains", "hawkish", "hike",
  "optimism", "positive", "rally", "record", "rise", "rises", "strong",
  "surge", "upside", "upgrade", "upbeat", "easing", "resilient",
]);
const negativeWords = new Set([
  "bear", "bearish", "crash", "cut", "cuts", "decline", "drop", "falls",
  "fear", "fearful", "geopolitical", "loss", "losses", "negative", "risk",
  "selloff", "slump", "weak", "weakness", "worry", "dovish", "recession",
]);
const highImpactTerms = [
  /\bFOMC\b/i,
  /\bNFP\b/i,
  /\bnon[- ]farm payrolls?\b/i,
  /\bCPI\b/i,
  /\bPCE\b/i,
  /\binterest rate decision\b/i,
  /\bcentral bank rate\b/i,
  /\bmonetary policy decision\b/i,
  /\bECB rate decision\b/i,
  /\bBoE rate decision\b/i,
  /\bBoJ rate decision\b/i,
];

const assetKeywords = {
  "XAU/USD": ["gold", "xau", "bullion", "federal reserve", "fed", "dollar", "usd"],
  "XAG/USD": ["silver", "xag", "federal reserve", "fed", "dollar", "usd"],
  "BTC/USDT": ["bitcoin", "btc", "crypto", "federal reserve", "fed", "dollar"],
  "ETH/USDT": ["ethereum", "ether", "eth", "crypto", "federal reserve", "fed"],
  "SOL/USDT": ["solana", "sol", "crypto", "federal reserve", "fed"],
  "EUR/USD": ["euro", "eur", "ecb", "european central bank", "federal reserve", "fed", "dollar"],
  "GBP/USD": ["pound", "sterling", "gbp", "bank of england", "boe", "federal reserve", "fed", "dollar"],
  "USD/JPY": ["yen", "jpy", "bank of japan", "boj", "federal reserve", "fed", "dollar"],
  "AUD/USD": ["australian dollar", "aussie", "aud", "reserve bank of australia", "rba", "federal reserve", "fed", "dollar"],
};

function classifyImpact(text) {
  if (highImpactTerms.some((pattern) => pattern.test(text))) return "High";
  if (/\b(inflation|jobs report|employment|GDP|PMI|retail sales|unemployment|central bank|rate decision|FOMC minutes)\b/i.test(text)) {
    return "Medium";
  }
  return "Low";
}

function scoreSentiment(text) {
  const tokens = text.toLowerCase().match(/[a-z]+/g) || [];
  let score = 0;
  for (const token of tokens) {
    if (positiveWords.has(token)) score += 1;
    if (negativeWords.has(token)) score -= 1;
  }
  return tokens.length ? Math.max(-1, Math.min(1, score / Math.sqrt(tokens.length))) : 0;
}

function sentimentLabel(score) {
  return score >= 0.12 ? "Bullish" : score <= -0.12 ? "Bearish" : "Neutral";
}

function currenciesFor(symbol) {
  if (symbol === "XAU/USD" || symbol === "XAG/USD") return ["USD"];
  if (symbol.endsWith("/USDT")) return [symbol.split("/")[0], "USD", "USDT"];
  return symbol.replace("/", " ").split(" ");
}

function isRelevant(text, symbol) {
  const lower = text.toLowerCase();
  const direct = (assetKeywords[symbol] || []).some((keyword) => lower.includes(keyword));
  const currencyNames = {
    EUR: ["euro", "ecb", "europe"],
    GBP: ["pound", "sterling", "boe", "britain", "uk"],
    JPY: ["yen", "boj", "japan"],
    AUD: ["australian dollar", "aussie", "rba", "australia"],
    CAD: ["canadian dollar", "loonie", "bank of canada", "boc", "canada"],
    CHF: ["swiss franc", "switzerland", "snb"],
    NZD: ["new zealand dollar", "kiwi", "rbnz", "new zealand"],
    CNY: ["yuan", "renminbi", "pboc", "china"],
    USD: ["dollar", "fed", "federal reserve", "treasury", "us "],
    BTC: ["bitcoin", "btc"],
    ETH: ["ethereum", "ether"],
    SOL: ["solana"],
    USDT: ["crypto", "bitcoin", "ethereum"],
  };
  return direct || currenciesFor(symbol).some((currency) =>
    (currencyNames[currency] || []).some((keyword) => lower.includes(keyword))
  );
}

async function fetchFeed(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error(`News feed returned HTTP ${response.status}.`);
  const xml = await response.text();
  const feed = await parser.parseString(xml);
  return (feed.items || []).slice(0, 40).map((item) => {
    const text = `${item.title || ""} ${item.contentSnippet || ""}`;
    const score = scoreSentiment(text);
    return {
      title: item.title || "Untitled market story",
      summary: (item.contentSnippet || "").slice(0, 240),
      link: item.link || "",
      publishedAt: item.isoDate || item.pubDate || null,
      impact: classifyImpact(text),
      sentiment: sentimentLabel(score),
      sentimentScore: Number(score.toFixed(2)),
    };
  });
}

async function fetchCalendar(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error(`Economic calendar returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("Economic calendar returned an unexpected response.");
  return payload.map((event) => {
    const timestamp = Date.parse(event.date || event.time);
    if (!Number.isFinite(timestamp)) return null;
    return {
      title: event.title || event.event || "Scheduled economic release",
      currency: String(event.country || event.currency || "").toUpperCase(),
      time: new Date(timestamp).toISOString(),
      impact: String(event.impact || "Low"),
      forecast: event.forecast || "",
      previous: event.previous || "",
    };
  }).filter(Boolean);
}

async function fetchWithCache(key, fetcher) {
  const cached = sentimentCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  try {
    const value = await fetcher();
    const result = { status: "ok", error: null, value, fetchedAt: new Date().toISOString() };
    sentimentCache.set(key, { at: Date.now(), value: result });
    return result;
  } catch (error) {
    const previous = sentimentCache.get(key);
    if (previous) {
      const stale = {
        ...previous.value,
        status: "stale",
        error: error.message,
      };
      sentimentCache.set(key, { at: Date.now(), value: stale });
      return stale;
    }
    const result = {
      status: "unavailable",
      error: error.message,
      value: [],
      fetchedAt: null,
    };
    sentimentCache.set(key, { at: Date.now(), value: result });
    return result;
  }
}

async function getNewsSnapshot(symbol) {
  const feedUrl = process.env.NEWS_RSS_URL || "https://www.forexlive.com/feed/news";
  const calendarUrl = process.env.ECONOMIC_CALENDAR_URL ||
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
  const [feed, calendar] = await Promise.all([
    fetchWithCache(`feed:${feedUrl}`, () => fetchFeed(feedUrl)),
    fetchWithCache(`calendar:${calendarUrl}`, () => fetchCalendar(calendarUrl)),
  ]);
  const relevantArticles = feed.value.filter((article) =>
    isRelevant(`${article.title} ${article.summary}`, symbol)
  );
  const weightedScore = relevantArticles.length
    ? relevantArticles.reduce((sum, item) => sum + item.sentimentScore, 0) / relevantArticles.length
    : 0;
  const currencies = currenciesFor(symbol);
  const now = Date.now();
  const upcomingEvents = calendar.value
    .filter((event) =>
      currencies.includes(event.currency) &&
      Date.parse(event.time) >= now &&
      Date.parse(event.time) <= now + 24 * 60 * 60 * 1000
    )
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
    .slice(0, 8);
  const highImpactWarning = upcomingEvents.some((event) =>
    event.impact.toLowerCase() === "high" &&
    Date.parse(event.time) <= now + 15 * 60 * 1000
  );

  return {
    articles: relevantArticles.slice(0, 12),
    calendar: upcomingEvents,
    calendarStatus: calendar.status,
    calendarError: calendar.error,
    newsStatus: feed.status,
    newsError: feed.error,
    highImpactWarning,
    sentiment: {
      score: Number(weightedScore.toFixed(2)),
      label: sentimentLabel(weightedScore),
      articleCount: relevantArticles.length,
    },
    updatedAt: new Date().toISOString(),
  };
}

module.exports = {
  classifyImpact,
  currenciesFor,
  getNewsSnapshot,
  scoreSentiment,
  sentimentLabel,
};
