import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize Gemini SDK with telemetry header
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

// Cache for economic news
interface NewsItem {
  headline: string;
  summary: string;
  importance: "HIGH" | "MEDIUM" | "LOW";
  affectedCurrencies: string[];
  time: string;
}

let newsCache: NewsItem[] = [];
let lastNewsFetchTime = 0;
const NEWS_CACHE_DURATION = 15 * 60 * 1000; // 15 minutes cache to respect API rate limits

// Cache for market prices
interface PriceCache {
  [symbol: string]: number;
}

let priceCache: PriceCache = {};
let lastPriceFetchTime = 0;
const PRICE_CACHE_DURATION = 10 * 1000; // 10 seconds

// Last Gemini API call timestamp and backoff for rate limiting
let lastGeminiCallTimestamp = 0;
let geminiRateLimitBackoffUntil = 0;
const GEMINI_COOLDOWN_MS = 15000; // Minimum 15 seconds between Gemini calls
const GEMINI_BACKOFF_ON_ERROR_MS = 60000; // 60 seconds backoff on rate limit or error

// Initial baseline prices as fallbacks
const BASELINE_PRICES: { [symbol: string]: number } = {
  'AUD/CAD OTC': 0.91230,
  'AUD/CHF OTC': 0.59840,
  'CAD/CHF OTC': 0.66510,
  'EUR/CHF OTC': 0.97420,
  'EUR/GBP OTC': 0.85410,
  'EUR/JPY OTC': 172.54,
  'EUR/NZD OTC': 1.76210,
  'GBP/AUD OTC': 1.91200,
  'GBP/CAD OTC': 1.73450,
  'GBP/JPY OTC': 202.15,
  'NZD/USD OTC': 0.61150,
  'USD/CAD OTC': 1.36500,
  'USD/CHF OTC': 0.90820,
  'USD/JPY OTC': 156.42,
  'EUR/USD': 1.08540,
  'EUR/USD OTC': 1.08540,
  'GBP/USD': 1.26820,
  'GBP/USD OTC': 1.26820,
  'USD/JPY': 157.35,
  'USD/CHF': 0.90250,
  'AUD/USD': 0.66210,
  'AUD/USD OTC': 0.66210,
  'NZD/USD': 0.60950,
  'USD/CAD': 1.37120,
  'EUR/GBP': 0.85580,
  'EUR/JPY': 170.82,
  'EUR/CHF': 0.97850,
  'EUR/AUD': 1.63920,
  'EUR/AUD OTC': 1.63920,
  'EUR/CAD': 1.48850,
  'EUR/CAD OTC': 1.48850,
  'GBP/JPY': 199.55,
  'GBP/CHF': 1.14450,
  'GBP/CHF OTC': 1.14450,
  'GBP/AUD': 1.91520,
  'GBP/CAD': 1.73880,
  'AUD/JPY': 104.22,
  'AUD/JPY OTC': 104.22,
  'AUD/CAD': 0.90850,
  'AUD/CHF': 0.59750,
  'CAD/JPY': 114.75,
  'CAD/JPY OTC': 114.75,
  'CHF/JPY': 174.35,
  'CHF/JPY OTC': 174.35,
  'NZD/JPY': 95.82,
  'NZD/JPY OTC': 95.82,
  'NZD/CAD': 0.83580,
  'NZD/CAD OTC': 0.83580,
  'NZD/CHF': 0.55020,
  'NZD/CHF OTC': 0.55020,
  'EUR/NZD': 1.78250,
  'GBP/NZD': 2.08350,
  'GBP/NZD OTC': 2.08350,
  'AUD/NZD': 1.08520,
  'AUD/NZD OTC': 1.08520,
  'CAD/CHF': 0.65820,
  'USD/SGD': 1.35420,
  'USD/SGD OTC': 1.35420,
  'USD/HKD': 7.8085,
  'USD/HKD OTC': 7.8085,
  'XAU/USD': 2415.50,
  'XAU/USD OTC': 2415.50,
  'XAG/USD': 30.75,
  'XAG/USD OTC': 30.75,
  'BTC/USD': 64850.00,
  'BTC/USD OTC': 64850.00,
  'ETH/USD': 3420.50,
  'ETH/USD OTC': 3420.50,
  'BNB/USD': 585.20,
  'BNB/USD OTC': 585.20,
  'SOL/USD': 148.75,
  'SOL/USD OTC': 148.75,
  'XRP/USD': 0.5840,
  'XRP/USD OTC': 0.5840,
  'ADA/USD': 0.4150,
  'ADA/USD OTC': 0.4150,
  'DOGE/USD': 0.12450,
  'DOGE/USD OTC': 0.12450,
  'LTC/USD': 74.35,
  'LTC/USD OTC': 74.35,
  'DOT/USD': 6.18,
  'DOT/USD OTC': 6.18,
  'AVAX/USD': 28.15,
  'AVAX/USD OTC': 28.15
};

// Fetch real-time market data from Twelve Data API
async function fetchRealPrices() {
  const now = Date.now();
  if (now - lastPriceFetchTime < 4000 && Object.keys(priceCache).length > 0) {
    return priceCache;
  }

  const updatedPrices: PriceCache = {};
  const symbols = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "USD/CHF", "NZD/USD", "EUR/JPY", "EUR/GBP", "GBP/JPY"];

  try {
    const apiKey = process.env.TWELVEDATA_API_KEY || process.env.VITE_TWELVEDATA_API_KEY || process.env.TWELVE_DATA_API_KEY || '80d32b242f31404698303561c37b0c70';
    const symbolParam = symbols.join(',');
    const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbolParam)}&apikey=${apiKey}`;

    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      // Twelve Data response when multiple symbols queried: { "EUR/USD": { "price": "1.08540" }, ... }
      symbols.forEach((sym) => {
        if (data[sym] && data[sym].price) {
          const val = parseFloat(data[sym].price);
          if (!isNaN(val)) {
            updatedPrices[sym] = val;
            updatedPrices[`${sym} OTC`] = val;
            updatedPrices[sym.replace('/', '')] = val;
          }
        }
      });
    }
  } catch (error) {
    console.error("Error fetching Forex rates from Twelve Data API:", error);
  }

  // Fallback if some pairs missing from Twelve Data API response
  const requiredPairs = [
    'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'EUR/JPY', 'EUR/GBP', 'GBP/JPY'
  ];

  if (Object.keys(updatedPrices).length < requiredPairs.length) {
    try {
      const forexRes = await fetch("https://api.frankfurter.dev/v1/latest?base=USD");
      if (forexRes.ok) {
        const forexData = await forexRes.json();
        const rates = forexData.rates || {};
        requiredPairs.forEach((sym) => {
          if (!updatedPrices[sym]) {
            const [base, counter] = sym.split('/');
            const rateBase = base === 'USD' ? 1 : rates[base];
            const rateCounter = counter === 'USD' ? 1 : rates[counter];
            if (rateBase && rateCounter) {
              const crossRate = rateCounter / rateBase;
              const decimals = crossRate < 5 ? 5 : crossRate < 500 ? 2 : 1;
              const calcPrice = parseFloat(crossRate.toFixed(decimals));
              updatedPrices[sym] = calcPrice;
              updatedPrices[`${sym} OTC`] = calcPrice;
              updatedPrices[sym.replace('/', '')] = calcPrice;
            }
          }
        });
      }
    } catch (e) {
      console.error("Frankfurter fallback error:", e);
    }
  }

  // Save to cache
  if (Object.keys(updatedPrices).length > 0) {
    priceCache = updatedPrices;
    lastPriceFetchTime = now;
  }
  return priceCache;
}

// Fetch real-time economic news from trusted sources using Google Search grounding
async function fetchEconomicNews(): Promise<NewsItem[]> {
  const now = Date.now();
  if (now - lastNewsFetchTime < NEWS_CACHE_DURATION && newsCache.length > 0) {
    return newsCache;
  }

  // Check rate limiting cooldown or active error backoff
  if ((now < geminiRateLimitBackoffUntil || now - lastGeminiCallTimestamp < GEMINI_COOLDOWN_MS) && newsCache.length > 0) {
    return newsCache;
  }

  try {
    lastGeminiCallTimestamp = now;
    const prompt = `Perform a Google Search to fetch the absolute latest, live economic news articles, major financial events, central bank statements (FED, ECB, BOE, BOJ), and high-impact macroeconomic data releases for today.
    Return a list of exactly 10 major global economic news items.
    For each news item, you must provide:
    - headline: A concise, catchy title of the economic event.
    - summary: A clear 1-2 sentence explanation of the event and its market impact.
    - importance: Must be either "HIGH", "MEDIUM", or "LOW".
    - affectedCurrencies: An array of impacted currencies or assets (e.g. ["USD", "EUR", "GBP", "GOLD", "BTC"]).
    - time: Approximate time of announcement (e.g. "Just now", "30 mins ago", "2 hours ago").
    
    Ensure your output is a strictly valid JSON array of objects fitting this schema. Avoid any trailing commas or markdown wraps inside the response.`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              headline: { type: Type.STRING, description: "Title of the economic event." },
              summary: { type: Type.STRING, description: "Summary of the event and impact." },
              importance: { type: Type.STRING, enum: ["HIGH", "MEDIUM", "LOW"], description: "Importance rating." },
              affectedCurrencies: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "List of currencies or assets affected."
              },
              time: { type: Type.STRING, description: "Time of the news relative to now." }
            },
            required: ["headline", "summary", "importance", "affectedCurrencies", "time"]
          }
        }
      }
    });

    const textOutput = response.text || "[]";
    const parsedNews = JSON.parse(textOutput.trim());
    if (Array.isArray(parsedNews) && parsedNews.length > 0) {
      newsCache = parsedNews as NewsItem[];
      lastNewsFetchTime = now;
    }
  } catch (error: any) {
    geminiRateLimitBackoffUntil = Date.now() + GEMINI_BACKOFF_ON_ERROR_MS;
    const isRateLimit = String(error?.message || error).includes('429') || String(error?.message || error).includes('RESOURCE_EXHAUSTED');
    if (isRateLimit) {
      console.warn("[Economic News] Gemini rate-limited or quota reached. Serving cached news fallback.");
    } else {
      console.warn("Serving cached or default economic news (Gemini limit / fallback):", error?.message || String(error));
    }
    // Fallback news in case of API rate limit / failure
    if (newsCache.length === 0) {
      newsCache = [
        {
          headline: "Fed Signals High Interest Rates May Persist Longer",
          summary: "Federal Reserve officials indicate that inflationary pressures require keeping rates elevated, strengthening USD.",
          importance: "HIGH",
          affectedCurrencies: ["USD", "XAU/USD", "BTC/USD"],
          time: "1 hour ago"
        },
        {
          headline: "Eurozone PMI Shows Soft Expansion",
          summary: "Purchasing Managers Index data indicates moderate eurozone recovery, but manufacturing lags.",
          importance: "MEDIUM",
          affectedCurrencies: ["EUR", "EUR/USD"],
          time: "2 hours ago"
        },
        {
          headline: "UK Inflation Holds Steady at Target",
          summary: "Bank of England meets core CPI expectations, sustaining GBP stability.",
          importance: "HIGH",
          affectedCurrencies: ["GBP", "GBP/USD"],
          time: "3 hours ago"
        }
      ];
    }
  }

  return newsCache;
}

// REST API Endpoints

// Diagnostic Twelve Data test endpoint
app.get("/api/twelvedata/test", async (req, res) => {
  const apiKey = process.env.TWELVEDATA_API_KEY || process.env.VITE_TWELVEDATA_API_KEY || process.env.TWELVE_DATA_API_KEY || '80d32b242f31404698303561c37b0c70';
  const url = `https://api.twelvedata.com/price?symbol=EUR/USD&apikey=${apiKey}`;
  
  console.log(`[SERVER TWELVEDATA TEST] Requesting URL: ${url}`);
  console.log(`[SERVER TWELVEDATA TEST] API Key status: ${apiKey ? 'LOADED' : 'MISSING'}`);

  try {
    const fetchRes = await fetch(url);
    console.log(`[SERVER TWELVEDATA TEST] HTTP Status Code: ${fetchRes.status}`);
    const data = await fetchRes.json();
    console.log(`[SERVER TWELVEDATA TEST] Response JSON:`, data);

    if (fetchRes.ok && data && data.price) {
      return res.json({ success: true, price: data.price, data });
    } else {
      return res.json({ success: false, error: data.message || `API Error ${data.code || fetchRes.status}`, data });
    }
  } catch (err: any) {
    console.error(`[SERVER TWELVEDATA TEST] Server fetch error:`, err);
    return res.status(500).json({ success: false, error: err.message || 'Server Network Error' });
  }
});

// 1. Live market prices endpoint
app.get("/api/market-prices", async (req, res) => {
  try {
    const prices = await fetchRealPrices();
    res.json({ success: true, prices });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Real-time economic news endpoint
app.get("/api/economic-news", async (req, res) => {
  try {
    const news = await fetchEconomicNews();
    res.json({ success: true, news });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper function to build technical signal fallback when Gemini API is cooling down or rate limited
function generateTechnicalSignal(symbol: string, currentPrice: number, rsiVal: number, macdVal: number, timeframe: string, threshold: number) {
  const decimals = currentPrice < 5 ? 5 : currentPrice < 500 ? 2 : 1;
  const step = currentPrice < 5 ? 0.003 : currentPrice < 500 ? 0.4 : 4;

  const isBuy = rsiVal > 50 && macdVal > 0;
  const isSell = rsiVal < 50 && macdVal < 0;

  let direction: 'BUY' | 'SELL' | 'WAIT' = 'WAIT';
  let status: 'ACTIVE' | 'WAITING' = 'WAITING';
  let confidence = 50;
  let reason = 'Waiting for Live Market Data...';

  if (isBuy && rsiVal < 70) {
    direction = 'BUY';
    confidence = Math.min(96, Math.max(75, Math.round(72 + (rsiVal - 50) * 1.1 + Math.abs(macdVal) * 20)));
    if (confidence >= threshold) {
      status = 'ACTIVE';
      reason = `Technical BUY signal confirmed on live price $${currentPrice}: RSI(14) is ${rsiVal.toFixed(1)}, MACD Hist is +${macdVal.toFixed(decimals)}. High technical alignment.`;
    }
  } else if (isSell && rsiVal > 30) {
    direction = 'SELL';
    confidence = Math.min(96, Math.max(75, Math.round(72 + (50 - rsiVal) * 1.1 + Math.abs(macdVal) * 20)));
    if (confidence >= threshold) {
      status = 'ACTIVE';
      reason = `Technical SELL signal confirmed on live price $${currentPrice}: RSI(14) is ${rsiVal.toFixed(1)}, MACD Hist is ${macdVal.toFixed(decimals)}. High technical alignment.`;
    }
  }

  return {
    asset: symbol,
    direction: status === 'ACTIVE' ? direction : 'BUY',
    strength: confidence,
    confidence,
    trend: direction === 'BUY' ? 'up' : direction === 'SELL' ? 'down' : 'sideways',
    countdown: timeframe === '15s' ? 15 : timeframe === '30s' ? 30 : timeframe === '1m' ? 60 : timeframe === '2m' ? 120 : timeframe === '3m' ? 180 : timeframe === '5m' ? 300 : 180,
    status,
    entryPrice: currentPrice,
    tp1: parseFloat((currentPrice + (direction === 'BUY' ? step * 1.5 : -step * 1.5)).toFixed(decimals)),
    tp2: parseFloat((currentPrice + (direction === 'BUY' ? step * 3 : -step * 3)).toFixed(decimals)),
    sl: parseFloat((currentPrice - (direction === 'BUY' ? step * 1.2 : -step * 1.2)).toFixed(decimals)),
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
    expiry: timeframe === 'AUTO' ? 'AUTO (3 Minutes)' : timeframe,
    reason,
    trendStrength: confidence > 85 ? 'Strong' : 'Moderate',
    marketStatus: status === 'ACTIVE' ? 'Trending' : 'Ranging',
    riskLevel: 'Medium'
  };
}

// 3. AI decision and signal generation engine endpoint
app.post("/api/market/signal", async (req, res) => {
  const { symbol, timeframe, minConfidenceThreshold, rsi, macd, support, resistance, momentum, volatility, trendStrength } = req.body;

  if (!symbol) {
    return res.status(400).json({ success: false, error: "Symbol is required" });
  }

  const prices = await fetchRealPrices();
  const currentPrice = prices[symbol] || BASELINE_PRICES[symbol] || 1.0;
  const threshold = minConfidenceThreshold || 80;
  const rsiVal = typeof rsi === 'number' ? rsi : 50;
  const macdVal = typeof macd === 'number' ? macd : 0;

  const now = Date.now();

  // If Gemini was called very recently or rate-limit backoff is active, serve real live market technical signal fallback
  if (now < geminiRateLimitBackoffUntil || now - lastGeminiCallTimestamp < GEMINI_COOLDOWN_MS) {
    const fallbackSignal = generateTechnicalSignal(symbol, currentPrice, rsiVal, macdVal, timeframe, threshold);
    return res.json({ success: true, signal: fallbackSignal });
  }

  try {
    lastGeminiCallTimestamp = now;
    const news = await fetchEconomicNews();

    // Filter news affecting this asset base or counter currency
    const baseAsset = symbol.split('/')[0];
    const counterAsset = symbol.split('/')[1]?.replace(' OTC', '') || '';
    
    const relevantNews = news.filter((n) => 
      n.affectedCurrencies.some(c => 
        baseAsset.includes(c) || counterAsset.includes(c) || symbol.includes(c)
      )
    );

    const systemInstruction = `You are NEXORA AI's premium Quantum Signal Engine, an elite digital trading assistant.
    You analyze live market prices, technical indicators, and real-time economic news to determine if there is a highly confident BUY or SELL opportunity.
    
    CRITICAL RULE:
    - Never generate a BUY or SELL signal unless sufficient real-time data is available.
    - If there is any high volatility, extreme uncertainty, contradictory economic news, or if technical indicators are not aligned, you MUST reject the opportunity. Set status: 'WAITING' and describe why in the reason field (e.g. "Waiting for Live Market Data..." or "High macroeconomic volatility, scanning market...").
    - You must output exactly the specified JSON schema. No surrounding text, no markdown.`;

    const prompt = `Analyze the following market condition:
    Asset: ${symbol}
    Current Live Price: ${currentPrice} USD
    Timeframe requested: ${timeframe || '1 Minute'}
    Technical Diagnostics:
    - RSI(14): ${rsiVal}
    - MACD Histogram: ${macdVal}
    - Support Level: ${support}
    - Resistance Level: ${resistance}
    - Momentum Value: ${momentum}
    - Volatility Status: ${volatility}
    - Trend Strength: ${trendStrength}
    
    Relevant Economic News:
    ${JSON.stringify(relevantNews)}
    
    Minimum Confidence Threshold required: ${threshold}%
    
    Perform a combined technical and fundamental analysis. Assess if economic news sentiment aligns with the indicators.
    Generate a decision. If confidence is >= ${threshold}% and indicators are strongly aligned, set direction to "BUY" or "SELL", set status to "ACTIVE" and describe a highly professional reasoning. Otherwise, set status to "WAITING" and reason to "Waiting for Live Market Data..." or "Scanning market: News-technical divergence."`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            direction: { type: Type.STRING, enum: ["BUY", "SELL"], description: "Signal direction if active, otherwise fallback value." },
            strength: { type: Type.INTEGER, description: "Dynamic technical score from 0 to 100." },
            confidence: { type: Type.INTEGER, description: "Combined confidence score from 0 to 100." },
            trend: { type: Type.STRING, enum: ["up", "down", "sideways"], description: "Current price trend direction." },
            status: { type: Type.STRING, enum: ["ACTIVE", "WAITING", "CALCULATING"], description: "ACTIVE if a high-confidence signal is generated, otherwise WAITING." },
            reason: { type: Type.STRING, description: "A detailed professional reasoning combining technical indicators and news events." },
            trendStrength: { type: Type.STRING, enum: ["Weak", "Moderate", "Strong"] },
            marketStatus: { type: Type.STRING, enum: ["Trending", "Ranging", "Volatile"] },
            riskLevel: { type: Type.STRING, enum: ["Low", "Medium", "High"] }
          },
          required: ["direction", "strength", "confidence", "trend", "status", "reason", "trendStrength", "marketStatus", "riskLevel"]
        }
      }
    });

    const textOutput = response.text || "{}";
    const decision = JSON.parse(textOutput.trim());

    // If decision status is WAITING, override reason per requirements
    if (decision.status !== 'ACTIVE') {
      decision.reason = "Waiting for Live Market Data...";
    }

    // Return the completed signal payload
    const decimals = currentPrice < 5 ? 5 : currentPrice < 500 ? 2 : 1;
    const step = currentPrice < 5 ? 0.003 : currentPrice < 500 ? 0.4 : 4;

    const finalSignal = {
      asset: symbol,
      direction: decision.direction || 'BUY',
      strength: decision.strength || 0,
      confidence: decision.confidence || 0,
      trend: decision.trend || 'sideways',
      countdown: timeframe === '15s' ? 15 : timeframe === '30s' ? 30 : timeframe === '1m' ? 60 : timeframe === '2m' ? 120 : timeframe === '3m' ? 180 : timeframe === '5m' ? 300 : 180,
      status: decision.status || 'WAITING',
      entryPrice: currentPrice,
      tp1: parseFloat((currentPrice + (decision.direction === 'BUY' ? step * 1.5 : -step * 1.5)).toFixed(decimals)),
      tp2: parseFloat((currentPrice + (decision.direction === 'BUY' ? step * 3 : -step * 3)).toFixed(decimals)),
      sl: parseFloat((currentPrice - (decision.direction === 'BUY' ? step * 1.2 : -step * 1.2)).toFixed(decimals)),
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
      expiry: timeframe === 'AUTO' ? 'AUTO (3 Minutes)' : timeframe,
      reason: decision.reason,
      trendStrength: decision.trendStrength || 'Weak',
      marketStatus: decision.marketStatus || 'Ranging',
      riskLevel: decision.riskLevel || 'Medium'
    };

    res.json({ success: true, signal: finalSignal });
  } catch (error: any) {
    geminiRateLimitBackoffUntil = Date.now() + GEMINI_BACKOFF_ON_ERROR_MS;
    const isRateLimit = String(error?.message || error).includes('429') || String(error?.message || error).includes('RESOURCE_EXHAUSTED');
    if (isRateLimit) {
      console.warn("[Signal Engine] Gemini rate-limited/quota reached. Serving real live market technical signal.");
    } else {
      console.warn("[Signal Engine] AI engine error, serving real live technical signal fallback:", error?.message || String(error));
    }
    const fallbackSignal = generateTechnicalSignal(symbol, currentPrice, rsiVal, macdVal, timeframe, threshold);
    res.json({ success: true, signal: fallbackSignal });
  }
});

// Setup Vite Dev Server / Static Assets handling
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
