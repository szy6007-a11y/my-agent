import assert from "node:assert/strict";
import test from "node:test";

import { WebSearchRegistry } from "@/agent/web/WebSearchRegistry";
import {
  DEFAULT_WEB_SEARCH_LIMIT,
  DEFAULT_WEB_TIMEOUT_MS,
  configuredWebSearchLimit,
  configuredWebTimeoutMs,
} from "@/agent/web/env";
import type { WebProviderName, WebSearchProvider } from "@/agent/web/types";

function provider(input: {
  available: boolean;
  extract?: boolean;
  name: WebProviderName;
  search?: boolean;
}): WebSearchProvider {
  return {
    displayName: input.name,
    isAvailable: () => input.available,
    name: input.name,
    supportsExtract: () => input.extract ?? false,
    supportsSearch: () => input.search ?? true,
  };
}

function withEnv(name: string, value: string | undefined, run: () => void) {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

test("WebSearchRegistry returns explicit provider even when unavailable", () => {
  withEnv("WEB_SEARCH_PROVIDER", "tavily", () => {
    const registry = new WebSearchRegistry([
      provider({ available: false, name: "tavily", search: true }),
      provider({ available: true, name: "exa", search: true }),
    ]);

    assert.equal(registry.getActiveProvider("search")?.name, "tavily");
    assert.equal(registry.hasEnabledTool("search"), true);
  });
});

test("WebSearchRegistry follows Hermes legacy auto-detect preference", () => {
  withEnv("WEB_SEARCH_PROVIDER", undefined, () => {
    const registry = new WebSearchRegistry([
      provider({ available: true, name: "tavily", search: true }),
      provider({ available: true, name: "firecrawl", search: true }),
    ]);

    assert.equal(registry.getActiveProvider("search")?.name, "firecrawl");
  });
});

test("WebSearchRegistry defaults search fallback to ddgs", () => {
  withEnv("WEB_SEARCH_FALLBACK_PROVIDER", undefined, () => {
    const firecrawl = provider({ available: true, name: "firecrawl", search: true });
    const registry = new WebSearchRegistry([
      firecrawl,
      provider({ available: true, name: "ddgs", search: true }),
    ]);

    assert.equal(registry.getFallbackProvider("search", firecrawl)?.name, "ddgs");
    assert.equal(registry.getFallbackProvider("extract", firecrawl), null);
  });
});

test("WebSearchRegistry does not enable extract for search-only providers", () => {
  withEnv("WEB_EXTRACT_PROVIDER", undefined, () => {
    const registry = new WebSearchRegistry([
      provider({ available: true, extract: false, name: "brave-free", search: true }),
    ]);

    assert.equal(registry.getActiveProvider("extract"), null);
    assert.equal(registry.hasEnabledTool("extract"), false);
  });
});

test("web integer env helpers use defaults for missing or empty values", () => {
  withEnv("WEB_SEARCH_DEFAULT_LIMIT", undefined, () => {
    assert.equal(configuredWebSearchLimit(), DEFAULT_WEB_SEARCH_LIMIT);
  });

  withEnv("WEB_SEARCH_TIMEOUT_MS", "", () => {
    assert.equal(configuredWebTimeoutMs(), DEFAULT_WEB_TIMEOUT_MS);
  });
});
