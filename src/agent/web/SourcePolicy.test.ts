import assert from "node:assert/strict";
import test from "node:test";

import { resolveWebSearchSourcePolicy } from "@/agent/web/SourcePolicy";

test("source policy applies finance domains to market close queries", () => {
  const resolution = resolveWebSearchSourcePolicy("S&P 500 close today June 20 2026", {
    allowedDomains: [],
    blockedDomains: [],
  });

  assert.equal(resolution.sourcePolicy?.id, "financial_market_data");
  assert.deepEqual(resolution.options.allowedDomains?.slice(0, 5), [
    "finance.yahoo.com",
    "bloomberg.com",
    "marketwatch.com",
    "cnbc.com",
    "reuters.com",
  ]);
});

test("source policy applies finance domains to Chinese index price queries", () => {
  const resolution = resolveWebSearchSourcePolicy("标普500 今天收盘价", {
    allowedDomains: [],
    blockedDomains: [],
  });

  assert.equal(resolution.sourcePolicy?.id, "financial_market_data");
  assert.ok(resolution.options.allowedDomains?.includes("finance.yahoo.com"));
});

test("source policy applies GitHub domains to repository metric queries", () => {
  const resolution = resolveWebSearchSourcePolicy("anthropics/financial-services github stars", {
    allowedDomains: [],
    blockedDomains: [],
  });

  assert.equal(resolution.sourcePolicy?.id, "github_repository_metrics");
  assert.deepEqual(resolution.options.allowedDomains, ["github.com"]);
});

test("source policy does not override explicit allowed domains", () => {
  const resolution = resolveWebSearchSourcePolicy("S&P 500 close today June 20 2026", {
    allowedDomains: ["sec.gov"],
    blockedDomains: ["example.com"],
  });

  assert.equal(resolution.sourcePolicy, undefined);
  assert.deepEqual(resolution.options.allowedDomains, ["sec.gov"]);
  assert.deepEqual(resolution.options.blockedDomains, ["example.com"]);
});
