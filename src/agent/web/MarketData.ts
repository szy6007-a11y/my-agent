import { configuredWebTimeoutMs } from "@/agent/web/env";
import { asArray, asRecord, fetchJson, numberValue, stringValue } from "@/agent/web/http";
import type { MarketDataObservation, WebSearchResponse, WebSearchResult } from "@/agent/web/types";

type MarketSymbolCandidate = {
  sourceUrl: string;
  symbol: string;
};

type YahooChartPoint = {
  close: number;
  date: string;
};

type YahooChartObservation = {
  currency?: string;
  exchangeTimezoneName: string;
  instrument: string;
  points: YahooChartPoint[];
  priceHint: number;
  providerSymbol: string;
};

type EnrichOptions = {
  now?: Date;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const DEFAULT_MARKET_TIME_ZONE = "America/New_York";
const MAX_MARKET_SYMBOLS_TO_ENRICH = 3;

function hasMarketValueIntent(query: string): boolean {
  return /close|closing|price|quote|latest|today|now|historical|history|收盘|收盘价|价格|报价|行情|最新|今日|今天|历史/i.test(
    query,
  );
}

function localDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function normalizeDate(year: string, month: string, day: string): string {
  return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function requestedMarketDate(query: string, now: Date = new Date()): string {
  const iso = query.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) {
    return normalizeDate(iso[1] ?? "", iso[2] ?? "", iso[3] ?? "");
  }

  const chineseDate = query.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?/);
  if (chineseDate) {
    return normalizeDate(chineseDate[1] ?? "", chineseDate[2] ?? "", chineseDate[3] ?? "");
  }

  const currentMarketDate = localDateInTimeZone(now, DEFAULT_MARKET_TIME_ZONE);
  const [, currentYear] = currentMarketDate.match(/^(\d{4})-/) ?? [];
  const chineseMonthDay = query.match(/(?:^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?/);
  if (chineseMonthDay && currentYear) {
    return normalizeDate(currentYear, chineseMonthDay[1] ?? "", chineseMonthDay[2] ?? "");
  }

  return currentMarketDate;
}

export function extractYahooFinanceSymbol(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host !== "finance.yahoo.com" && !host.endsWith(".finance.yahoo.com")) {
    return null;
  }

  const [first, second] = url.pathname.split("/").filter(Boolean);
  if (first !== "quote" || !second) {
    return null;
  }

  const symbol = decodeURIComponent(second).trim();
  return normalizeMarketSymbol(symbol);
}

function normalizeMarketSymbol(value: string): string | null {
  const symbol = value.trim().toUpperCase();
  if (!symbol || symbol.length > 24) {
    return null;
  }
  if (!/^[A-Z0-9^.=/-]+$/.test(symbol)) {
    return null;
  }
  return symbol;
}

function explicitSymbolsFromQuery(query: string): MarketSymbolCandidate[] {
  const candidates: MarketSymbolCandidate[] = [];
  for (const match of query.matchAll(/(?:^|[\s(（])\$([A-Z][A-Z0-9.-]{0,14})\b/g)) {
    const symbol = normalizeMarketSymbol(match[1] ?? "");
    if (symbol) {
      candidates.push({ sourceUrl: yahooHistoryUrl(symbol), symbol });
    }
  }
  for (const match of query.matchAll(/\^([A-Z0-9]{2,14})\b/g)) {
    const symbol = normalizeMarketSymbol(`^${match[1] ?? ""}`);
    if (symbol) {
      candidates.push({ sourceUrl: yahooHistoryUrl(symbol), symbol });
    }
  }
  return candidates;
}

function symbolsFromSearchResults(results: WebSearchResult[]): MarketSymbolCandidate[] {
  return results
    .map((result) => {
      const symbol = extractYahooFinanceSymbol(result.url);
      return symbol ? { sourceUrl: result.url, symbol } : null;
    })
    .filter((item): item is MarketSymbolCandidate => Boolean(item));
}

export function extractMarketSymbolCandidates(
  query: string,
  results: WebSearchResult[],
): MarketSymbolCandidate[] {
  if (!hasMarketValueIntent(query)) {
    return [];
  }

  const seen = new Set<string>();
  const candidates: MarketSymbolCandidate[] = [];
  for (const candidate of [...symbolsFromSearchResults(results), ...explicitSymbolsFromQuery(query)]) {
    const key = candidate.symbol.toUpperCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push(candidate);
    if (candidates.length >= MAX_MARKET_SYMBOLS_TO_ENRICH) {
      break;
    }
  }
  return candidates;
}

function dateToUnixSeconds(date: string, offsetDays: number): number {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  return Math.floor(Date.UTC(year, month - 1, day + offsetDays) / 1000);
}

function yahooChartUrl(symbol: string, requestedDate: string): string {
  const params = new URLSearchParams({
    events: "history",
    interval: "1d",
    period1: String(dateToUnixSeconds(requestedDate, -10)),
    period2: String(dateToUnixSeconds(requestedDate, 3)),
  });
  return `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;
}

function yahooHistoryUrl(symbol: string): string {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/history/`;
}

function parseYahooChartPayload(payload: unknown): YahooChartObservation | null {
  const chart = asRecord(asRecord(payload).chart);
  const result = asRecord(asArray(chart.result)[0]);
  if (Object.keys(result).length === 0) {
    return null;
  }

  const meta = asRecord(result.meta);
  const timestamps = asArray(result.timestamp);
  const quote = asRecord(asArray(asRecord(result.indicators).quote)[0]);
  const closes = asArray(quote.close);
  const timezone = stringValue(meta.exchangeTimezoneName) || DEFAULT_MARKET_TIME_ZONE;
  const points = timestamps
    .map((timestamp, index) => {
      const unixSeconds = numberValue(timestamp, NaN);
      const close = numberValue(closes[index], NaN);
      if (!Number.isFinite(unixSeconds) || !Number.isFinite(close)) {
        return null;
      }
      return {
        close,
        date: localDateInTimeZone(new Date(unixSeconds * 1000), timezone),
      };
    })
    .filter((item): item is YahooChartPoint => Boolean(item));

  const providerSymbol = stringValue(meta.symbol);
  if (!providerSymbol || points.length === 0) {
    return null;
  }

  return {
    currency: stringValue(meta.currency) || undefined,
    exchangeTimezoneName: timezone,
    instrument: stringValue(meta.longName) || stringValue(meta.shortName) || providerSymbol,
    points,
    priceHint: Math.max(0, Math.min(8, numberValue(meta.priceHint, 2))),
    providerSymbol,
  };
}

export function latestPointOnOrBefore(
  points: YahooChartPoint[],
  requestedDate: string,
): YahooChartPoint | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (point && point.date <= requestedDate) {
      return point;
    }
  }
  return points.at(-1) ?? null;
}

function roundMarketValue(value: number, priceHint: number): number {
  const precision = 10 ** priceHint;
  return Math.round(value * precision) / precision;
}

function formatMarketValue(value: number, priceHint: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: priceHint,
    minimumFractionDigits: Math.min(priceHint, 2),
  }).format(value);
}

async function fetchYahooObservation(
  candidate: MarketSymbolCandidate,
  query: string,
  options: EnrichOptions,
): Promise<MarketDataObservation | null> {
  const now = options.now ?? new Date();
  const requestedDate = requestedMarketDate(query, now);
  const payload = await fetchJson(yahooChartUrl(candidate.symbol, requestedDate), {
    headers: {
      "User-Agent": "my-agent-web-search/1.0",
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? configuredWebTimeoutMs(),
  });
  const chart = parseYahooChartPayload(payload);
  if (!chart) {
    return null;
  }

  const point = latestPointOnOrBefore(chart.points, requestedDate);
  if (!point) {
    return null;
  }

  const value = roundMarketValue(point.close, chart.priceHint);
  const status =
    point.date === requestedDate ?
      "as_of_requested_date"
    : "latest_available_before_requested_date";

  return {
    currency: chart.currency,
    date: point.date,
    field: "close",
    frequency: "daily",
    instrument: chart.instrument,
    note:
      status === "as_of_requested_date" ?
        "Daily close from Yahoo Finance chart data."
      : "Requested date has no returned daily bar or was not a trading day; this is the latest available daily close on or before the requested date.",
    provider_symbol: chart.providerSymbol,
    requested_date: requestedDate,
    retrieved_at: now.toISOString(),
    source: "yahoo_chart",
    source_name: "Yahoo Finance chart API",
    source_url: candidate.sourceUrl || yahooHistoryUrl(chart.providerSymbol),
    status,
    symbol: chart.providerSymbol,
    value,
    value_formatted: formatMarketValue(value, chart.priceHint),
  };
}

export async function enrichMarketSearchResults(
  result: WebSearchResponse,
  options: EnrichOptions = {},
): Promise<WebSearchResponse> {
  if (!result.success) {
    return result;
  }

  const candidates = extractMarketSymbolCandidates(result.query, result.data.web);
  if (candidates.length === 0) {
    return result;
  }

  const observations = (
    await Promise.all(
      candidates.map(async (candidate) => {
        try {
          return await fetchYahooObservation(candidate, result.query, options);
        } catch {
          return null;
        }
      }),
    )
  ).filter((item): item is MarketDataObservation => Boolean(item));

  if (observations.length === 0) {
    return result;
  }

  return {
    ...result,
    data: {
      ...result.data,
      market_data: [...(result.data.market_data ?? []), ...observations],
    },
  };
}
