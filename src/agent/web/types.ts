export type WebCapability = "search" | "extract";

export type WebProviderName =
  | "brave-free"
  | "ddgs"
  | "exa"
  | "firecrawl"
  | "parallel"
  | "searxng"
  | "tavily";

export type GitHubRepositoryMetadata = {
  default_branch: string;
  description: string;
  forks: number;
  full_name: string;
  html_url: string;
  language: string;
  license: string;
  open_issues: number;
  pushed_at: string;
  retrieved_at: string;
  source: "github_rest_api";
  stars: number;
  updated_at: string;
};

export type MarketDataObservation = {
  currency?: string;
  date: string;
  field: "close";
  frequency: "daily";
  instrument: string;
  note: string;
  provider_symbol: string;
  requested_date: string;
  retrieved_at: string;
  source: "yahoo_chart";
  source_name: string;
  source_url: string;
  status: "as_of_requested_date" | "latest_available_before_requested_date";
  symbol: string;
  value: number;
  value_formatted: string;
};

export type WebSearchResult = {
  description: string;
  metadata?: {
    github?: GitHubRepositoryMetadata;
  };
  position: number;
  title: string;
  url: string;
};

export type WebSearchSuccess = {
  data: {
    market_data?: MarketDataObservation[];
    web: WebSearchResult[];
  };
  provider: string;
  query: string;
  success: true;
};

export type WebFailure = {
  error: string;
  provider?: string;
  success: false;
};

export type WebSearchResponse = WebSearchSuccess | WebFailure;

export type WebExtractDocument = {
  blocked_by_policy?: {
    host: string;
    reason: string;
    source: string;
  };
  content?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  raw_content?: string;
  title: string;
  url: string;
};

export type WebExtractResponse =
  | {
      provider: string;
      results: WebExtractDocument[];
      success: true;
    }
  | WebFailure;

export type WebSearchOptions = {
  allowedDomains?: string[];
  blockedDomains?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type WebExtractOptions = {
  format?: "html" | "markdown" | "text";
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type WebProviderSetupField = {
  key: string;
  prompt: string;
  url?: string;
};

export type WebProviderSetupSchema = {
  badge?: string;
  envVars: WebProviderSetupField[];
  name: string;
  tag?: string;
};

export type WebSearchProvider = {
  displayName: string;
  extract?: (urls: string[], options?: WebExtractOptions) => Promise<WebExtractDocument[]>;
  getSetupSchema?: () => WebProviderSetupSchema;
  isAvailable: () => boolean;
  name: WebProviderName;
  search?: (
    query: string,
    limit: number,
    options?: WebSearchOptions,
  ) => Promise<WebSearchResponse>;
  supportsExtract: () => boolean;
  supportsSearch: () => boolean;
};
