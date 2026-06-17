import {
  configuredWebExtractMaxChars,
  configuredWebExtractMinLength,
  configuredWebExtractTimeoutMs,
  configuredWebSearchLimit,
  configuredWebTimeoutMs,
  MAX_WEB_EXTRACT_URLS,
  MAX_WEB_SEARCH_LIMIT,
  MAX_WEB_TOOL_RESULT_CHARS,
} from "@/agent/web/env";
import { processExtractDocuments } from "@/agent/web/content";
import {
  createDefaultWebSearchRegistry,
  type WebSearchRegistry,
} from "@/agent/web/WebSearchRegistry";
import type { WebExtractDocument } from "@/agent/web/types";
import { validateExternalUrl } from "@/agent/web/urlSafety";
import type { AgentTool } from "@/agent/tools/types";
import { toolError, toolSuccess } from "@/agent/tools/types";

type WebSearchArgs = {
  allowed_domains?: unknown;
  blocked_domains?: unknown;
  limit?: unknown;
  query?: unknown;
};

type WebExtractArgs = {
  format?: unknown;
  max_chars_per_page?: unknown;
  min_length?: unknown;
  urls?: unknown;
  use_llm_processing?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {};
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0)
        .map((item) => item.replace(/^https?:\/\//i, "").split("/")[0] ?? "")
        .filter(Boolean),
    ),
  ];
}

function asFormat(value: unknown): "html" | "markdown" | "text" {
  return value === "html" || value === "text" || value === "markdown" ? value : "markdown";
}

async function validateExtractUrls(rawUrls: unknown) {
  const values =
    Array.isArray(rawUrls) ? rawUrls
    : typeof rawUrls === "string" ? [rawUrls]
    : [];
  const urls = values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .slice(0, MAX_WEB_EXTRACT_URLS);

  const safeUrls: string[] = [];
  const blocked: WebExtractDocument[] = [];
  for (const url of urls) {
    const safety = await validateExternalUrl(url);
    if (safety.ok) {
      safeUrls.push(safety.url);
      continue;
    }
    if (/api key|token|credential/i.test(safety.reason)) {
      return {
        blocked,
        error: `${safety.reason} Secrets must not be sent in URLs.`,
        safeUrls,
      };
    }
    blocked.push({
      content: "",
      error: safety.reason,
      raw_content: "",
      title: "",
      url: safety.url ?? url,
    });
  }

  return { blocked, safeUrls };
}

export function createWebTools(registry: WebSearchRegistry = createDefaultWebSearchRegistry()) {
  const webSearchTool: AgentTool = {
    definition: {
      function: {
        description:
          "Search the live web for current information. Returns titles, URLs, descriptions, provider metadata, and a citation reminder. Query operators such as site:domain, filetype:pdf, intitle:word, -term, and exact phrases may work when the provider supports them.",
        name: "web_search",
        parameters: {
          properties: {
            allowed_domains: {
              description:
                "Optional domains to allow, for example ['docs.example.com']. Results outside these domains are filtered out.",
              items: { type: "string" },
              type: "array",
            },
            blocked_domains: {
              description:
                "Optional domains to block, for example ['example.com']. Ignored for provider-native filtering when allowed_domains is set.",
              items: { type: "string" },
              type: "array",
            },
            limit: {
              default: configuredWebSearchLimit(),
              description: "Maximum number of results to return. Defaults to 5, maximum 100.",
              maximum: MAX_WEB_SEARCH_LIMIT,
              minimum: 1,
              type: "integer",
            },
            query: {
              description: "The web search query.",
              type: "string",
            },
          },
          required: ["query"],
          type: "object",
        },
      },
      type: "function",
    },
    isEnabled: () => registry.hasEnabledTool("search"),
    isReadOnly: true,
    maxResultSizeChars: MAX_WEB_TOOL_RESULT_CHARS,
    name: "web_search",
    async execute(args, context) {
      const input = asRecord(args) as WebSearchArgs;
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) {
        return toolError("query is required.");
      }
      if (query.length > 2_000) {
        return toolError("query is too long; keep web_search queries under 2000 characters.");
      }

      const provider = registry.getActiveProvider("search");
      if (!provider?.search) {
        return toolError("No web search provider configured.");
      }

      const result = await provider.search(query, clampInt(input.limit, configuredWebSearchLimit(), 1, 100), {
        allowedDomains: asStringArray(input.allowed_domains),
        blockedDomains: asStringArray(input.blocked_domains),
        signal: context.signal,
        timeoutMs: configuredWebTimeoutMs(),
      });

      if (!result.success) {
        return JSON.stringify(result);
      }

      return JSON.stringify({
        ...result,
        citations:
          "When using web_search results, cite sources with markdown links and do not imply unsupported facts.",
        sources: result.data.web.map((item) => ({
          title: item.title,
          url: item.url,
        })),
      });
    },
  };

  const webExtractTool: AgentTool = {
    definition: {
      function: {
        description:
          "Extract content from HTTP(S) page URLs. Checks URLs for credentials, private/internal network targets, and unsafe redirects before fetching. Returns markdown/text content when the configured extract provider can access it.",
        name: "web_extract",
        parameters: {
          properties: {
            format: {
              default: "markdown",
              description: "Preferred output format.",
              enum: ["markdown", "text", "html"],
              type: "string",
            },
            max_chars_per_page: {
              default: configuredWebExtractMaxChars(),
              description: "Maximum returned characters per page after processing.",
              minimum: 1000,
              type: "integer",
            },
            min_length: {
              default: configuredWebExtractMinLength(),
              description: "Minimum raw content length that triggers LLM compression.",
              minimum: 0,
              type: "integer",
            },
            urls: {
              description: "URLs to extract. Maximum 5 URLs per call.",
              items: { type: "string" },
              maxItems: MAX_WEB_EXTRACT_URLS,
              type: "array",
            },
            use_llm_processing: {
              default: true,
              description:
                "Whether to compress long pages with the configured summarizer model before returning them.",
              type: "boolean",
            },
          },
          required: ["urls"],
          type: "object",
        },
      },
      type: "function",
    },
    isEnabled: () => registry.hasEnabledTool("extract"),
    isReadOnly: true,
    maxResultSizeChars: MAX_WEB_TOOL_RESULT_CHARS,
    name: "web_extract",
    async execute(args, context) {
      const input = asRecord(args) as WebExtractArgs;
      const validated = await validateExtractUrls(input.urls);
      if ("error" in validated && validated.error) {
        return toolError(validated.error);
      }
      if (validated.safeUrls.length === 0 && validated.blocked.length === 0) {
        return toolError("urls is required and must contain at least one HTTP(S) URL.");
      }

      const provider = registry.getActiveProvider("extract");
      if (!provider?.extract) {
        return toolError(
          "No web extract provider configured. Configure FIRECRAWL_API_KEY, TAVILY_API_KEY, EXA_API_KEY, or PARALLEL_API_KEY.",
        );
      }

      const providerResults =
        validated.safeUrls.length > 0 ?
          await provider.extract(validated.safeUrls, {
            format: asFormat(input.format),
            signal: context.signal,
            timeoutMs: configuredWebExtractTimeoutMs(),
          })
        : [];
      const processing = await processExtractDocuments([...validated.blocked, ...providerResults], {
        maxChars: clampInt(
          input.max_chars_per_page,
          configuredWebExtractMaxChars(),
          1_000,
          100_000,
        ),
        minLength: clampInt(input.min_length, configuredWebExtractMinLength(), 0, 200_000),
        signal: context.signal,
        useLlmProcessing: input.use_llm_processing !== false,
      });

      if (processing.results.length === 0) {
        return toolError("Content was inaccessible or not found.");
      }

      return toolSuccess({
        provider: provider.name,
        processing: {
          processed_with_llm: processing.processedWithLlm,
          truncated: processing.truncated,
        },
        results: processing.results.map((result) => ({
          blocked_by_policy: result.blocked_by_policy,
          content: result.content ?? "",
          error: result.error,
          title: result.title,
          url: result.url,
        })),
      });
    },
  };

  return [webSearchTool, webExtractTool];
}
