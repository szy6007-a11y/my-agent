import assert from "node:assert/strict";
import test from "node:test";

import type { ModelToolCall } from "@/agent/runtime/types";
import type { WebSearchProvider } from "@/agent/web/types";

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
