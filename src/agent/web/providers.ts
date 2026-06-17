import {
  DEFAULT_WEB_EXTRACT_TIMEOUT_MS,
  DEFAULT_WEB_TIMEOUT_MS,
  envValue,
} from "@/agent/web/env";
import {
  asArray,
  asRecord,
  fetchJson,
  numberValue,
  stringValue,
} from "@/agent/web/http";
import type {
  WebExtractDocument,
  WebExtractOptions,
  WebProviderSetupSchema,
  WebSearchOptions,
  WebSearchProvider,
  WebSearchResponse,
  WebSearchResult,
} from "@/agent/web/types";
import { domainMatches } from "@/agent/web/urlSafety";

function clampLimit(limit: number, max = 100): number {
  return Math.max(1, Math.min(max, Math.trunc(Number.isFinite(limit) ? limit : 5)));
}

function setup(name: string, envVars: WebProviderSetupSchema["envVars"], tag = "") {
  return {
    envVars,
    name,
    tag,
  };
}

function filterResults(results: WebSearchResult[], options?: WebSearchOptions): WebSearchResult[] {
  const allowed = options?.allowedDomains ?? [];
  const blocked = options?.blockedDomains ?? [];
  return results
    .filter((result) => domainMatches(result.url, allowed))
    .filter((result) => blocked.length === 0 || !domainMatches(result.url, blocked))
    .map((result, index) => ({ ...result, position: index + 1 }));
}

function searchSuccess(
  provider: string,
  query: string,
  results: WebSearchResult[],
  options?: WebSearchOptions,
): WebSearchResponse {
  return {
    data: { web: filterResults(results, options) },
    provider,
    query,
    success: true,
  };
}

function searchFailure(provider: string, error: string): WebSearchResponse {
  return { error, provider, success: false };
}

function docsFromFailedUrls(value: unknown): WebExtractDocument[] {
  return asArray(value).map((item) => {
    const record = asRecord(item);
    const url = typeof item === "string" ? item : stringValue(record.url);
    return {
      content: "",
      error: stringValue(record.error) || "extraction failed",
      raw_content: "",
      title: "",
      url,
    };
  });
}

function isHttpError(error: unknown, status: number): boolean {
  return error instanceof Error && error.message.startsWith(`HTTP ${status}:`);
}

async function fetchFirecrawlJson(
  endpoint: "scrape" | "search",
  body: Record<string, unknown>,
  options: WebSearchOptions | WebExtractOptions | undefined,
) {
  const base = (envValue("FIRECRAWL_API_URL") || "https://api.firecrawl.dev").replace(/\/$/, "");
  const apiKey = envValue("FIRECRAWL_API_KEY");
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const timeoutMs = options?.timeoutMs ?? DEFAULT_WEB_EXTRACT_TIMEOUT_MS;

  try {
    return await fetchJson(`${base}/v2/${endpoint}`, {
      body,
      headers,
      signal: options?.signal,
      timeoutMs,
    });
  } catch (error) {
    if (!isHttpError(error, 404)) {
      throw error;
    }
    return await fetchJson(`${base}/v1/${endpoint}`, {
      body,
      headers,
      signal: options?.signal,
      timeoutMs,
    });
  }
}

function normalizeFirecrawlSearch(query: string, payload: unknown, options?: WebSearchOptions) {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const raw =
    asArray(data.web).length > 0 ? asArray(data.web)
    : asArray(data.results).length > 0 ? asArray(data.results)
    : asArray(root.web).length > 0 ? asArray(root.web)
    : asArray(root.results).length > 0 ? asArray(root.results)
    : Array.isArray(root.data) ? asArray(root.data)
    : [];

  const results = raw.map((item, index) => {
    const record = asRecord(item);
    return {
      description: stringValue(record.description ?? record.content ?? record.snippet),
      position: index + 1,
      title: stringValue(record.title),
      url: stringValue(record.url),
    };
  });

  return searchSuccess("firecrawl", query, results, options);
}

function normalizeFirecrawlScrape(url: string, payload: unknown, format: string): WebExtractDocument {
  const root = asRecord(payload);
  const data = Object.keys(asRecord(root.data)).length > 0 ? asRecord(root.data) : root;
  const metadata = asRecord(data.metadata);
  const finalUrl = stringValue(metadata.sourceURL) || url;
  const markdown = stringValue(data.markdown);
  const html = stringValue(data.html ?? data.rawHtml);
  const chosen = format === "html" ? html || markdown : markdown || html;

  return {
    content: chosen,
    metadata,
    raw_content: chosen,
    title: stringValue(metadata.title),
    url: finalUrl,
  };
}

export const firecrawlProvider: WebSearchProvider = {
  displayName: "Firecrawl",
  name: "firecrawl",
  getSetupSchema: () =>
    setup("Firecrawl", [
      {
        key: "FIRECRAWL_API_KEY",
        prompt: "Firecrawl API key",
        url: "https://docs.firecrawl.dev/introduction",
      },
      {
        key: "FIRECRAWL_API_URL",
        prompt: "Self-hosted Firecrawl API URL",
      },
    ]),
  isAvailable: () => Boolean(envValue("FIRECRAWL_API_KEY") || envValue("FIRECRAWL_API_URL")),
  supportsExtract: () => true,
  supportsSearch: () => true,
  async search(query, limit, options) {
    if (!firecrawlProvider.isAvailable()) {
      return searchFailure("firecrawl", "FIRECRAWL_API_KEY or FIRECRAWL_API_URL is not set.");
    }
    try {
      const includeDomains = options?.allowedDomains?.length ? options.allowedDomains : undefined;
      const excludeDomains =
        !includeDomains && options?.blockedDomains?.length ? options.blockedDomains : undefined;
      const payload = await fetchFirecrawlJson(
        "search",
        {
          query,
          limit: clampLimit(limit, 100),
          sources: ["web"],
          ...(includeDomains ? { includeDomains } : {}),
          ...(excludeDomains ? { excludeDomains } : {}),
        },
        { ...options, timeoutMs: options?.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS },
      );
      return normalizeFirecrawlSearch(query, payload, options);
    } catch (error) {
      return searchFailure(
        "firecrawl",
        `Firecrawl search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
  async extract(urls, options) {
    if (!firecrawlProvider.isAvailable()) {
      return urls.map((url) => ({
        content: "",
        error: "FIRECRAWL_API_KEY or FIRECRAWL_API_URL is not set.",
        raw_content: "",
        title: "",
        url,
      }));
    }

    const format = options?.format ?? "markdown";
    const formats = format === "html" ? ["html"] : format === "text" ? ["markdown"] : ["markdown"];
    const results: WebExtractDocument[] = [];
    for (const url of urls) {
      try {
        const payload = await fetchFirecrawlJson(
          "scrape",
          {
            formats,
            onlyMainContent: true,
            url,
          },
          options,
        );
        results.push(normalizeFirecrawlScrape(url, payload, format));
      } catch (error) {
        results.push({
          content: "",
          error: `Firecrawl extract failed: ${error instanceof Error ? error.message : String(error)}`,
          raw_content: "",
          title: "",
          url,
        });
      }
    }
    return results;
  },
};

export const tavilyProvider: WebSearchProvider = {
  displayName: "Tavily",
  name: "tavily",
  getSetupSchema: () =>
    setup("Tavily", [
      {
        key: "TAVILY_API_KEY",
        prompt: "Tavily API key",
        url: "https://app.tavily.com/home",
      },
    ]),
  isAvailable: () => Boolean(envValue("TAVILY_API_KEY")),
  supportsExtract: () => true,
  supportsSearch: () => true,
  async search(query, limit, options) {
    const apiKey = envValue("TAVILY_API_KEY");
    if (!apiKey) {
      return searchFailure("tavily", "TAVILY_API_KEY is not set.");
    }
    try {
      const base = envValue("TAVILY_BASE_URL") || "https://api.tavily.com";
      const payload = await fetchJson(`${base.replace(/\/$/, "")}/search`, {
        body: {
          include_images: false,
          include_raw_content: false,
          max_results: Math.min(clampLimit(limit, 100), 20),
          query,
        },
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: options?.signal,
        timeoutMs: options?.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS,
      });
      const results = asArray(asRecord(payload).results).map((item, index) => {
        const record = asRecord(item);
        return {
          description: stringValue(record.content),
          position: index + 1,
          title: stringValue(record.title),
          url: stringValue(record.url),
        };
      });
      return searchSuccess("tavily", query, results, options);
    } catch (error) {
      return searchFailure(
        "tavily",
        `Tavily search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
  async extract(urls, options) {
    const apiKey = envValue("TAVILY_API_KEY");
    if (!apiKey) {
      return urls.map((url) => ({
        content: "",
        error: "TAVILY_API_KEY is not set.",
        raw_content: "",
        title: "",
        url,
      }));
    }
    try {
      const base = envValue("TAVILY_BASE_URL") || "https://api.tavily.com";
      const payload = await fetchJson(`${base.replace(/\/$/, "")}/extract`, {
        body: {
          format: options?.format === "text" ? "text" : "markdown",
          include_favicon: false,
          include_images: false,
          urls,
        },
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: options?.signal,
        timeoutMs: options?.timeoutMs ?? DEFAULT_WEB_EXTRACT_TIMEOUT_MS,
      });
      const root = asRecord(payload);
      const documents = asArray(root.results).map((item) => {
        const record = asRecord(item);
        const raw = stringValue(record.raw_content ?? record.content);
        const url = stringValue(record.url);
        return {
          content: raw,
          metadata: {
            favicon: record.favicon,
            sourceURL: url,
            title: record.title,
          },
          raw_content: raw,
          title: stringValue(record.title),
          url,
        };
      });
      return [...documents, ...docsFromFailedUrls(root.failed_results), ...docsFromFailedUrls(root.failed_urls)];
    } catch (error) {
      return urls.map((url) => ({
        content: "",
        error: `Tavily extract failed: ${error instanceof Error ? error.message : String(error)}`,
        raw_content: "",
        title: "",
        url,
      }));
    }
  },
};

export const exaProvider: WebSearchProvider = {
  displayName: "Exa",
  name: "exa",
  getSetupSchema: () =>
    setup("Exa", [
      {
        key: "EXA_API_KEY",
        prompt: "Exa API key",
        url: "https://exa.ai",
      },
    ]),
  isAvailable: () => Boolean(envValue("EXA_API_KEY")),
  supportsExtract: () => true,
  supportsSearch: () => true,
  async search(query, limit, options) {
    const apiKey = envValue("EXA_API_KEY");
    if (!apiKey) {
      return searchFailure("exa", "EXA_API_KEY is not set.");
    }
    try {
      const payload = await fetchJson("https://api.exa.ai/search", {
        body: {
          contents: { highlights: true },
          numResults: clampLimit(limit, 100),
          query,
        },
        headers: { "x-api-key": apiKey },
        signal: options?.signal,
        timeoutMs: options?.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS,
      });
      const results = asArray(asRecord(payload).results).map((item, index) => {
        const record = asRecord(item);
        const highlights = asArray(record.highlights).map(stringValue).join(" ");
        return {
          description: highlights || stringValue(record.summary ?? record.text),
          position: index + 1,
          title: stringValue(record.title),
          url: stringValue(record.url),
        };
      });
      return searchSuccess("exa", query, results, options);
    } catch (error) {
      return searchFailure(
        "exa",
        `Exa search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
  async extract(urls, options) {
    const apiKey = envValue("EXA_API_KEY");
    if (!apiKey) {
      return urls.map((url) => ({
        content: "",
        error: "EXA_API_KEY is not set.",
        raw_content: "",
        title: "",
        url,
      }));
    }
    try {
      const payload = await fetchJson("https://api.exa.ai/contents", {
        body: {
          text: true,
          urls,
        },
        headers: { "x-api-key": apiKey },
        signal: options?.signal,
        timeoutMs: options?.timeoutMs ?? DEFAULT_WEB_EXTRACT_TIMEOUT_MS,
      });
      return asArray(asRecord(payload).results).map((item) => {
        const record = asRecord(item);
        const content = stringValue(record.text ?? record.summary);
        const url = stringValue(record.url);
        return {
          content,
          metadata: {
            author: record.author,
            id: record.id,
            publishedDate: record.publishedDate,
            sourceURL: url,
            title: record.title,
          },
          raw_content: content,
          title: stringValue(record.title),
          url,
        };
      });
    } catch (error) {
      return urls.map((url) => ({
        content: "",
        error: `Exa extract failed: ${error instanceof Error ? error.message : String(error)}`,
        raw_content: "",
        title: "",
        url,
      }));
    }
  },
};

export const parallelProvider: WebSearchProvider = {
  displayName: "Parallel",
  name: "parallel",
  getSetupSchema: () =>
    setup("Parallel", [
      {
        key: "PARALLEL_API_KEY",
        prompt: "Parallel API key",
        url: "https://platform.parallel.ai",
      },
    ]),
  isAvailable: () => Boolean(envValue("PARALLEL_API_KEY")),
  supportsExtract: () => true,
  supportsSearch: () => true,
  async search(query, limit, options) {
    const apiKey = envValue("PARALLEL_API_KEY");
    if (!apiKey) {
      return searchFailure("parallel", "PARALLEL_API_KEY is not set.");
    }
    try {
      const payload = await fetchJson("https://api.parallel.ai/v1/search", {
        body: {
          max_results: Math.min(clampLimit(limit, 100), 20),
          objective: query,
          search_queries: [query],
        },
        headers: { "x-api-key": apiKey },
        signal: options?.signal,
        timeoutMs: options?.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS,
      });
      const results = asArray(asRecord(payload).results).map((item, index) => {
        const record = asRecord(item);
        return {
          description:
            asArray(record.excerpts).map(stringValue).join(" ") || stringValue(record.description),
          position: index + 1,
          title: stringValue(record.title),
          url: stringValue(record.url),
        };
      });
      return searchSuccess("parallel", query, results, options);
    } catch (error) {
      return searchFailure(
        "parallel",
        `Parallel search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
  async extract(urls, options) {
    const apiKey = envValue("PARALLEL_API_KEY");
    if (!apiKey) {
      return urls.map((url) => ({
        content: "",
        error: "PARALLEL_API_KEY is not set.",
        raw_content: "",
        title: "",
        url,
      }));
    }
    try {
      const payload = await fetchJson("https://api.parallel.ai/v1/extract", {
        body: {
          advanced_settings: {
            excerpt_settings: { max_chars_per_result: 5_000 },
            full_content: { max_chars_per_result: 50_000 },
          },
          max_chars_total: 100_000,
          objective: "Extract complete page content for an AI agent.",
          urls,
        },
        headers: { "x-api-key": apiKey },
        signal: options?.signal,
        timeoutMs: options?.timeoutMs ?? DEFAULT_WEB_EXTRACT_TIMEOUT_MS,
      });
      const root = asRecord(payload);
      const results = asArray(root.results).map((item) => {
        const record = asRecord(item);
        const content =
          stringValue(record.full_content) || asArray(record.excerpts).map(stringValue).join("\n\n");
        const url = stringValue(record.url);
        return {
          content,
          metadata: {
            publish_date: record.publish_date,
            sourceURL: url,
            title: record.title,
          },
          raw_content: content,
          title: stringValue(record.title),
          url,
        };
      });
      const errors = asArray(root.errors).map((item) => {
        const record = asRecord(item);
        return {
          content: "",
          error: stringValue(record.message ?? record.error) || "extraction failed",
          raw_content: "",
          title: "",
          url: stringValue(record.url),
        };
      });
      return [...results, ...errors];
    } catch (error) {
      return urls.map((url) => ({
        content: "",
        error: `Parallel extract failed: ${error instanceof Error ? error.message : String(error)}`,
        raw_content: "",
        title: "",
        url,
      }));
    }
  },
};

export const searxngProvider: WebSearchProvider = {
  displayName: "SearXNG",
  name: "searxng",
  getSetupSchema: () =>
    setup("SearXNG", [
      {
        key: "SEARXNG_URL",
        prompt: "SearXNG instance URL",
        url: "https://searx.space/",
      },
    ]),
  isAvailable: () => Boolean(envValue("SEARXNG_URL")),
  supportsExtract: () => false,
  supportsSearch: () => true,
  async search(query, limit, options) {
    const base = envValue("SEARXNG_URL").replace(/\/$/, "");
    if (!base) {
      return searchFailure("searxng", "SEARXNG_URL is not set.");
    }
    try {
      const params = new URLSearchParams({
        format: "json",
        pageno: "1",
        q: query,
      });
      const payload = await fetchJson(`${base}/search?${params.toString()}`, {
        signal: options?.signal,
        timeoutMs: options?.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS,
      });
      const results = asArray(asRecord(payload).results)
        .sort((left, right) => numberValue(asRecord(right).score) - numberValue(asRecord(left).score))
        .slice(0, clampLimit(limit, 100))
        .map((item, index) => {
          const record = asRecord(item);
          return {
            description: stringValue(record.content),
            position: index + 1,
            title: stringValue(record.title),
            url: stringValue(record.url),
          };
        });
      return searchSuccess("searxng", query, results, options);
    } catch (error) {
      return searchFailure(
        "searxng",
        `SearXNG search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
};

export const braveFreeProvider: WebSearchProvider = {
  displayName: "Brave Search (Free)",
  name: "brave-free",
  getSetupSchema: () =>
    setup("Brave Search (Free)", [
      {
        key: "BRAVE_SEARCH_API_KEY",
        prompt: "Brave Search API key",
        url: "https://brave.com/search/api/",
      },
    ]),
  isAvailable: () => Boolean(envValue("BRAVE_SEARCH_API_KEY")),
  supportsExtract: () => false,
  supportsSearch: () => true,
  async search(query, limit, options) {
    const apiKey = envValue("BRAVE_SEARCH_API_KEY");
    if (!apiKey) {
      return searchFailure("brave-free", "BRAVE_SEARCH_API_KEY is not set.");
    }
    try {
      const params = new URLSearchParams({
        count: String(Math.min(clampLimit(limit, 100), 20)),
        q: query,
      });
      const payload = await fetchJson(
        `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
        {
          headers: { "X-Subscription-Token": apiKey },
          signal: options?.signal,
          timeoutMs: options?.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS,
        },
      );
      const results = asArray(asRecord(asRecord(payload).web).results).map((item, index) => {
        const record = asRecord(item);
        return {
          description: stringValue(record.description),
          position: index + 1,
          title: stringValue(record.title),
          url: stringValue(record.url),
        };
      });
      return searchSuccess("brave-free", query, results, options);
    } catch (error) {
      return searchFailure(
        "brave-free",
        `Brave Search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
};

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)));
}

function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function normalizeDuckDuckGoUrl(raw: string): string {
  const decoded = decodeHtml(raw);
  try {
    const url = new URL(decoded, "https://duckduckgo.com");
    const redirected = url.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : url.toString();
  } catch {
    return decoded;
  }
}

export const ddgsProvider: WebSearchProvider = {
  displayName: "DuckDuckGo (ddgs)",
  name: "ddgs",
  getSetupSchema: () => setup("DuckDuckGo (ddgs)", [], "Free, keyless, search only."),
  isAvailable: () => envValue("WEB_DDGS_ENABLED").toLowerCase() !== "false",
  supportsExtract: () => false,
  supportsSearch: () => true,
  async search(query, limit, options) {
    try {
      const params = new URLSearchParams({ q: query });
      const response = await fetch(
        `https://html.duckduckgo.com/html/?${params.toString()}`,
        {
          headers: {
            Accept: "text/html",
            "User-Agent":
              "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) my-agent-web-search/1.0",
          },
          signal: options?.signal,
        },
      );
      if (!response.ok) {
        return searchFailure("ddgs", `DuckDuckGo returned HTTP ${response.status}.`);
      }
      const html = await response.text();
      const matches = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)];
      const results = matches.slice(0, clampLimit(limit, 100)).map((match, index) => ({
        description: stripHtml(match[3] ?? ""),
        position: index + 1,
        title: stripHtml(match[2] ?? ""),
        url: normalizeDuckDuckGoUrl(match[1] ?? ""),
      }));
      return searchSuccess("ddgs", query, results, options);
    } catch (error) {
      return searchFailure(
        "ddgs",
        `DuckDuckGo search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
};

export function createBuiltInWebProviders(): WebSearchProvider[] {
  return [
    firecrawlProvider,
    parallelProvider,
    tavilyProvider,
    exaProvider,
    searxngProvider,
    braveFreeProvider,
    ddgsProvider,
  ];
}
