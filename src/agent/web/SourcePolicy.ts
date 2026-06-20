import type { WebSearchOptions } from "@/agent/web/types";

export type WebSearchSourcePolicyId = "financial_market_data" | "github_repository_metrics";

export type AppliedWebSearchSourcePolicy = {
  allowed_domains: string[];
  guidance: string;
  id: WebSearchSourcePolicyId;
  reason: string;
};

export type WebSearchSourcePolicyResolution = {
  options: Pick<WebSearchOptions, "allowedDomains" | "blockedDomains">;
  sourcePolicy?: AppliedWebSearchSourcePolicy;
};

type SourcePolicyDefinition = {
  allowedDomains: string[];
  guidance: string;
  id: WebSearchSourcePolicyId;
  matches: (query: string) => boolean;
  reason: string;
};

const FINANCIAL_MARKET_DOMAINS = [
  "finance.yahoo.com",
  "bloomberg.com",
  "marketwatch.com",
  "cnbc.com",
  "reuters.com",
  "nasdaq.com",
  "investing.com",
] as const;

const GITHUB_REPOSITORY_DOMAINS = ["github.com"] as const;

function hasPattern(query: string, pattern: RegExp): boolean {
  return pattern.test(query);
}

function hasFinancialMarketIntent(query: string): boolean {
  const valueIntent =
    hasPattern(
      query,
      /\b(close|closing|price|quote|latest|today|now|historical|history|open|high|low|volume|market cap)\b/i,
    ) ||
    hasPattern(query, /收盘|收盘价|价格|报价|行情|最新|今日|今天|历史|开盘|最高|最低|成交量|市值/);

  if (!valueIntent) {
    return false;
  }

  return (
    hasPattern(
      query,
      /\b(stock|stocks|share price|shares|ticker|equity|etf|fund|index|indices|nasdaq|nyse|s&p|sp500|dow|russell|vix|ftse|dax|cac|nikkei|hang seng|csi 300)\b/i,
    ) ||
    hasPattern(query, /股票|股价|指数|基金|美股|港股|A股|沪深|上证|深证|创业板|恒生|日经|标普|纳指|道指/) ||
    hasPattern(query, /(?:^|[\s(（])(?:\$[A-Z][A-Z0-9.-]{0,14}|\^[A-Z0-9]{2,14})\b/)
  );
}

function hasGitHubRepositoryMetricsIntent(query: string): boolean {
  const repoMetric =
    hasPattern(query, /\b(star|stars|stargazers|fork|forks|watchers|open issues)\b/i) ||
    hasPattern(query, /星标|收藏|fork|分叉|关注|issue|议题/);
  const githubContext =
    hasPattern(query, /\bgithub\b/i) ||
    hasPattern(query, /github\.com\//i) ||
    hasPattern(query, /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/);

  return repoMetric && githubContext;
}

const SOURCE_POLICIES: SourcePolicyDefinition[] = [
  {
    allowedDomains: [...FINANCIAL_MARKET_DOMAINS],
    guidance:
      "Financial market prices, closes, quotes, and index levels are time-sensitive numerical facts. Use source-policy selected finance/news domains and avoid treating generic snippets as verified prices.",
    id: "financial_market_data",
    matches: hasFinancialMarketIntent,
    reason: "Detected a financial market numerical lookup.",
  },
  {
    allowedDomains: [...GITHUB_REPOSITORY_DOMAINS],
    guidance:
      "Repository stars, forks, and issue counts are volatile. Prefer GitHub result metadata or GitHub pages over third-party snippets.",
    id: "github_repository_metrics",
    matches: hasGitHubRepositoryMetricsIntent,
    reason: "Detected a GitHub repository metric lookup.",
  },
];

export function resolveWebSearchSourcePolicy(
  query: string,
  requestedOptions: Pick<WebSearchOptions, "allowedDomains" | "blockedDomains">,
): WebSearchSourcePolicyResolution {
  const allowedDomains = requestedOptions.allowedDomains ?? [];
  const blockedDomains = requestedOptions.blockedDomains ?? [];

  if (allowedDomains.length > 0) {
    return {
      options: { allowedDomains, blockedDomains },
    };
  }

  const policy = SOURCE_POLICIES.find((item) => item.matches(query));
  if (!policy) {
    return {
      options: { allowedDomains, blockedDomains },
    };
  }

  return {
    options: {
      allowedDomains: policy.allowedDomains,
      blockedDomains,
    },
    sourcePolicy: {
      allowed_domains: policy.allowedDomains,
      guidance: policy.guidance,
      id: policy.id,
      reason: policy.reason,
    },
  };
}
