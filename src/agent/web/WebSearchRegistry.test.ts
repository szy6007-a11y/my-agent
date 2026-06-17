import assert from "node:assert/strict";
import test from "node:test";

import { WebSearchRegistry } from "@/agent/web/WebSearchRegistry";
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

test("WebSearchRegistry does not enable extract for search-only providers", () => {
  withEnv("WEB_EXTRACT_PROVIDER", undefined, () => {
    const registry = new WebSearchRegistry([
      provider({ available: true, extract: false, name: "brave-free", search: true }),
    ]);

    assert.equal(registry.getActiveProvider("extract"), null);
    assert.equal(registry.hasEnabledTool("extract"), false);
  });
});
