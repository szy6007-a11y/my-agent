import assert from "node:assert/strict";
import test from "node:test";

import type { ModelToolCall } from "@/agent/runtime/types";
import type { WebSearchOptions, WebSearchProvider } from "@/agent/web/types";

process.env.DEEPSEEK_API_KEY ??= "test-deepseek-key";

function makeToolCall(name: string, args: unknown): ModelToolCall {
  return {
    arguments: JSON.stringify(args),
    id: `call_${name}`,
    name,
  };
}

function makeContext() {
  return {
    runId: "run_test",
    sessionId: "sess_test",
    sessions: {} as never,
    userId: "usr_test",
  };
}

async function loadWebToolModules() {
  const [{ ToolRegistry }, { createWebTools }, { WebSearchRegistry }, { tavilyProvider }] =
    await Promise.all([
      import("@/agent/tools/ToolRegistry"),
      import("@/agent/tools/WebTools"),
      import("@/agent/web/WebSearchRegistry"),
      import("@/agent/web/providers"),
    ]);

  return { createWebTools, tavilyProvider, ToolRegistry, WebSearchRegistry };
}

test("web_search tool is advertised and returns provider-normalized sources", async () => {
  const { createWebTools, ToolRegistry, WebSearchRegistry } = await loadWebToolModules();
  const fakeProvider: WebSearchProvider = {
    displayName: "Tavily",
    isAvailable: () => true,
    name: "tavily",
    search: async (query) => ({
      data: {
        web: [
          {
            description: "Result body",
            position: 1,
            title: "Result",
            url: "https://example.com/result",
          },
        ],
      },
      provider: "tavily",
      query,
      success: true,
    }),
    supportsExtract: () => false,
    supportsSearch: () => true,
  };
  const registry = new ToolRegistry(createWebTools(new WebSearchRegistry([fakeProvider])));

  assert.deepEqual(registry.names, ["web_search"]);
  const result = JSON.parse(
    await registry.execute(makeToolCall("web_search", { query: "agent search", limit: 1 }), makeContext()),
  ) as {
    data: { web: Array<{ title: string; url: string }> };
    provider: string;
    sources: Array<{ title: string; url: string }>;
    success: boolean;
  };

  assert.equal(result.success, true);
  assert.equal(result.provider, "tavily");
  assert.deepEqual(result.sources, [{ title: "Result", url: "https://example.com/result" }]);
});

test("web_search enriches GitHub repository results with live star counts", async () => {
  const { createWebTools, ToolRegistry, WebSearchRegistry } = await loadWebToolModules();
  const previousFetch = globalThis.fetch;
  const previousEnrichLimit = process.env.WEB_SEARCH_GITHUB_ENRICH_LIMIT;
  process.env.WEB_SEARCH_GITHUB_ENRICH_LIMIT = "5";
  globalThis.fetch = async () =>
    ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          default_branch: "main",
          description: "Reference agents for financial services.",
          forks_count: 4598,
          full_name: "anthropics/financial-services",
          html_url: "https://github.com/anthropics/financial-services",
          language: "Python",
          license: { spdx_id: "Apache-2.0" },
          open_issues_count: 166,
          pushed_at: "2026-06-05T20:53:09Z",
          stargazers_count: 31979,
          updated_at: "2026-06-20T10:48:09Z",
        }),
    }) as Response;
  const fakeProvider: WebSearchProvider = {
    displayName: "DuckDuckGo (ddgs)",
    isAvailable: () => true,
    name: "ddgs",
    search: async (query) => ({
      data: {
        web: [
          {
            description: "A stale third-party snippet says 12,088 stars.",
            position: 1,
            title: "GitHub - anthropics/financial-services",
            url: "https://github.com/anthropics/financial-services",
          },
        ],
      },
      provider: "ddgs",
      query,
      success: true,
    }),
    supportsExtract: () => false,
    supportsSearch: () => true,
  };
  const registry = new ToolRegistry(createWebTools(new WebSearchRegistry([fakeProvider])));

  try {
    const result = JSON.parse(
      await registry.execute(
        makeToolCall("web_search", { query: "github anthropics/financial-services stars" }),
        makeContext(),
      ),
    ) as {
      data: { web: Array<{ metadata?: { github?: { stars?: number } } }> };
      github_repositories: Array<{ full_name: string; source: string; stars: number }>;
    };

    assert.equal(result.data.web[0]?.metadata?.github?.stars, 31979);
    assert.equal(result.github_repositories[0]?.full_name, "anthropics/financial-services");
    assert.equal(result.github_repositories[0]?.source, "github_rest_api");
    assert.equal(result.github_repositories[0]?.stars, 31979);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousEnrichLimit === undefined) {
      delete process.env.WEB_SEARCH_GITHUB_ENRICH_LIMIT;
    } else {
      process.env.WEB_SEARCH_GITHUB_ENRICH_LIMIT = previousEnrichLimit;
    }
  }
});

test("web_search applies source policy domains to financial market lookups", async () => {
  const { createWebTools, ToolRegistry, WebSearchRegistry } = await loadWebToolModules();
  let capturedOptions: WebSearchOptions | undefined;
  const fakeProvider: WebSearchProvider = {
    displayName: "Firecrawl",
    isAvailable: () => true,
    name: "firecrawl",
    search: async (query, _limit, options) => {
      capturedOptions = options;
      return {
        data: {
          web: [
            {
              description: "S&P 500 historical data.",
              position: 1,
              title: "S&P 500 INDEX Historical Data - Yahoo Finance",
              url: "https://finance.yahoo.com/quote/%5EGSPC/history/",
            },
          ],
        },
        provider: "firecrawl",
        query,
        success: true,
      };
    },
    supportsExtract: () => false,
    supportsSearch: () => true,
  };
  const registry = new ToolRegistry(createWebTools(new WebSearchRegistry([fakeProvider])));

  const result = JSON.parse(
    await registry.execute(
      makeToolCall("web_search", { query: "S&P 500 close today June 20 2026" }),
      makeContext(),
    ),
  ) as {
    source_policy?: {
      allowed_domains: string[];
      id: string;
    };
    success: boolean;
  };

  assert.equal(result.success, true);
  assert.equal(result.source_policy?.id, "financial_market_data");
  assert.deepEqual(capturedOptions?.allowedDomains?.slice(0, 5), [
    "finance.yahoo.com",
    "bloomberg.com",
    "marketwatch.com",
    "cnbc.com",
    "reuters.com",
  ]);
  assert.deepEqual(result.source_policy?.allowed_domains.slice(0, 5), [
    "finance.yahoo.com",
    "bloomberg.com",
    "marketwatch.com",
    "cnbc.com",
    "reuters.com",
  ]);
});

test("web_search keeps explicit allowed domains over source policy domains", async () => {
  const { createWebTools, ToolRegistry, WebSearchRegistry } = await loadWebToolModules();
  let capturedOptions: WebSearchOptions | undefined;
  const fakeProvider: WebSearchProvider = {
    displayName: "Firecrawl",
    isAvailable: () => true,
    name: "firecrawl",
    search: async (query, _limit, options) => {
      capturedOptions = options;
      return {
        data: {
          web: [
            {
              description: "SEC result",
              position: 1,
              title: "SEC",
              url: "https://www.sec.gov/result",
            },
          ],
        },
        provider: "firecrawl",
        query,
        success: true,
      };
    },
    supportsExtract: () => false,
    supportsSearch: () => true,
  };
  const registry = new ToolRegistry(createWebTools(new WebSearchRegistry([fakeProvider])));

  const result = JSON.parse(
    await registry.execute(
      makeToolCall("web_search", {
        allowed_domains: ["https://www.sec.gov/reports"],
        query: "S&P 500 close today June 20 2026",
      }),
      makeContext(),
    ),
  ) as {
    source_policy?: unknown;
    success: boolean;
  };

  assert.equal(result.success, true);
  assert.equal(result.source_policy, undefined);
  assert.deepEqual(capturedOptions?.allowedDomains, ["www.sec.gov"]);
});

test("web_search falls back to ddgs when firecrawl fails", async () => {
  const { createWebTools, ToolRegistry, WebSearchRegistry } = await loadWebToolModules();
  const firecrawlProvider: WebSearchProvider = {
    displayName: "Firecrawl",
    isAvailable: () => true,
    name: "firecrawl",
    search: async () => ({
      error: "FIRECRAWL_API_KEY or FIRECRAWL_API_URL is not set.",
      provider: "firecrawl",
      success: false,
    }),
    supportsExtract: () => false,
    supportsSearch: () => true,
  };
  const ddgsProvider: WebSearchProvider = {
    displayName: "DuckDuckGo (ddgs)",
    isAvailable: () => true,
    name: "ddgs",
    search: async (query) => ({
      data: {
        web: [
          {
            description: "Duck result",
            position: 1,
            title: "Duck",
            url: "https://example.com/duck",
          },
        ],
      },
      provider: "ddgs",
      query,
      success: true,
    }),
    supportsExtract: () => false,
    supportsSearch: () => true,
  };
  const registry = new ToolRegistry(
    createWebTools(new WebSearchRegistry([firecrawlProvider, ddgsProvider])),
  );

  const result = JSON.parse(
    await registry.execute(makeToolCall("web_search", { query: "agent search", limit: 1 }), makeContext()),
  ) as {
    fallback: { from: string; reason: string };
    provider: string;
    sources: Array<{ title: string; url: string }>;
    success: boolean;
  };

  assert.equal(result.success, true);
  assert.equal(result.provider, "ddgs");
  assert.deepEqual(result.fallback, {
    from: "firecrawl",
    reason: "FIRECRAWL_API_KEY or FIRECRAWL_API_URL is not set.",
  });
  assert.deepEqual(result.sources, [{ title: "Duck", url: "https://example.com/duck" }]);
});

test("web_extract blocks private and secret-bearing URLs before provider execution", async () => {
  const { createWebTools, ToolRegistry, WebSearchRegistry } = await loadWebToolModules();
  let called = false;
  const fakeProvider: WebSearchProvider = {
    displayName: "Firecrawl",
    extract: async () => {
      called = true;
      return [];
    },
    isAvailable: () => true,
    name: "firecrawl",
    supportsExtract: () => true,
    supportsSearch: () => false,
  };
  const registry = new ToolRegistry(createWebTools(new WebSearchRegistry([fakeProvider])));

  const secretResult = JSON.parse(
    await registry.execute(
      makeToolCall("web_extract", { urls: ["https://example.com/?token=sk-test-secret"] }),
      makeContext(),
    ),
  ) as { error: string; success: boolean };
  assert.equal(secretResult.success, false);
  assert.match(secretResult.error, /Secrets must not be sent/);
  assert.equal(called, false);

  const privateResult = JSON.parse(
    await registry.execute(makeToolCall("web_extract", { urls: ["http://127.0.0.1:3000"] }), makeContext()),
  ) as { results: Array<{ error?: string }>; success: boolean };
  assert.equal(privateResult.success, true);
  assert.match(privateResult.results[0]?.error ?? "", /private or internal/);
  assert.equal(called, false);
});

test("web_extract returns processed provider content when LLM processing is disabled", async () => {
  const { createWebTools, ToolRegistry, WebSearchRegistry } = await loadWebToolModules();
  const previousAllowPrivate = process.env.WEB_ALLOW_PRIVATE_URLS;
  process.env.WEB_ALLOW_PRIVATE_URLS = "true";
  const fakeProvider: WebSearchProvider = {
    displayName: "Exa",
    extract: async (urls) =>
      urls.map((url) => ({
        content: "clean content",
        raw_content: "clean content",
        title: "Doc",
        url,
      })),
    isAvailable: () => true,
    name: "exa",
    supportsExtract: () => true,
    supportsSearch: () => false,
  };
  const registry = new ToolRegistry(createWebTools(new WebSearchRegistry([fakeProvider])));

  try {
    const result = JSON.parse(
      await registry.execute(
        makeToolCall("web_extract", {
          urls: ["http://127.0.0.1/docs"],
          use_llm_processing: false,
        }),
        makeContext(),
      ),
    ) as { results: Array<{ content: string; title: string; url: string }>; success: boolean };

    assert.equal(result.success, true);
    assert.deepEqual(result.results, [
      {
        content: "clean content",
        title: "Doc",
        url: "http://127.0.0.1/docs",
      },
    ]);
  } finally {
    if (previousAllowPrivate === undefined) {
      delete process.env.WEB_ALLOW_PRIVATE_URLS;
    } else {
      process.env.WEB_ALLOW_PRIVATE_URLS = previousAllowPrivate;
    }
  }
});

test("Tavily provider normalizes search API results", async () => {
  const { tavilyProvider } = await loadWebToolModules();
  const previousKey = process.env.TAVILY_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.TAVILY_API_KEY = "tvly-test";
  globalThis.fetch = async () =>
    ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          results: [
            {
              content: "Snippet",
              title: "Title",
              url: "https://example.com",
            },
          ],
        }),
    }) as Response;

  try {
    const result = await tavilyProvider.search?.("query", 3);
    assert.equal(result?.success, true);
    if (result?.success) {
      assert.deepEqual(result.data.web, [
        {
          description: "Snippet",
          position: 1,
          title: "Title",
          url: "https://example.com",
        },
      ]);
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.TAVILY_API_KEY;
    } else {
      process.env.TAVILY_API_KEY = previousKey;
    }
  }
});
