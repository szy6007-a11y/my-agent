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

export type WebSearchResultEvidence = {
  note: string;
  retrieved_at: string;
  source: "provider_search_result";
  type: "search_snippet";
  verified: false;
};

export type WebSearchResult = {
  description: string;
  evidence?: WebSearchResultEvidence;
  metadata?: {
    github?: GitHubRepositoryMetadata;
  };
  position: number;
  title: string;
  url: string;
};

export type WebSearchSuccess = {
  data: {
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
