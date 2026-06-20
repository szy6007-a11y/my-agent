import assert from "node:assert/strict";
import test from "node:test";

import {
  extractMarketSymbolCandidates,
  extractYahooFinanceSymbol,
  latestPointOnOrBefore,
  requestedMarketDate,
} from "@/agent/web/MarketData";

test("extractYahooFinanceSymbol reads symbols from regional Yahoo Finance quote URLs", () => {
  assert.equal(
    extractYahooFinanceSymbol("https://finance.yahoo.com/quote/%5EGSPC/history/"),
    "^GSPC",
  );
  assert.equal(
    extractYahooFinanceSymbol("https://sg.finance.yahoo.com/quote/%5ESPX/"),
    "^SPX",
  );
  assert.equal(extractYahooFinanceSymbol("https://finance.yahoo.com/quote/AAPL/"), "AAPL");
  assert.equal(extractYahooFinanceSymbol("https://example.com/quote/AAPL/"), null);
});

test("extractMarketSymbolCandidates uses finance symbols instead of hard-coded index aliases", () => {
  const candidates = extractMarketSymbolCandidates("标普500 收盘价 2026年6月20日", [
    {
      description: "Get historical data for the S&P 500 INDEX (^SPX) on Yahoo Finance.",
      position: 1,
      title: "S&P 500 INDEX (^SPX) Historical Data - Yahoo Finance",
      url: "https://finance.yahoo.com/quote/^SPX/history/",
    },
    {
      description: "The latest price is $7,493.74.",
      position: 2,
      title: "S And P 500 Close By Day In 2026 | StatMuse Money",
      url: "https://www.statmuse.com/money/ask/s-and-p-500-close-by-day-in-2026",
    },
  ]);

  assert.deepEqual(candidates, [
    {
      sourceUrl: "https://finance.yahoo.com/quote/^SPX/history/",
      symbol: "^SPX",
    },
  ]);
});

test("extractMarketSymbolCandidates accepts explicit ticker syntax without a Yahoo result", () => {
  assert.deepEqual(extractMarketSymbolCandidates("今天 $AAPL 收盘价", []), [
    {
      sourceUrl: "https://finance.yahoo.com/quote/AAPL/history/",
      symbol: "AAPL",
    },
  ]);
  assert.deepEqual(extractMarketSymbolCandidates("今天 ^GSPC 收盘价", []), [
    {
      sourceUrl: "https://finance.yahoo.com/quote/%5EGSPC/history/",
      symbol: "^GSPC",
    },
  ]);
});

test("latestPointOnOrBefore returns the prior trading close for a holiday or weekend", () => {
  assert.deepEqual(
    latestPointOnOrBefore(
      [
        { close: 7511.35, date: "2026-06-16" },
        { close: 7420.1, date: "2026-06-17" },
        { close: 7500.58, date: "2026-06-18" },
      ],
      "2026-06-20",
    ),
    { close: 7500.58, date: "2026-06-18" },
  );
});

test("requestedMarketDate parses Chinese dates and today's market date", () => {
  assert.equal(requestedMarketDate("标普500 收盘价 2026年6月20日"), "2026-06-20");
  assert.equal(
    requestedMarketDate("今天的标普500收盘价", new Date("2026-06-20T11:26:45.000Z")),
    "2026-06-20",
  );
});
