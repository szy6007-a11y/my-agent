import {
  configuredWebSearchGitHubEnrichLimit,
  configuredWebTimeoutMs,
  envValue,
} from "@/agent/web/env";
import { asRecord, fetchJson, numberValue, stringValue } from "@/agent/web/http";
import type { GitHubRepositoryMetadata, WebSearchResult } from "@/agent/web/types";

type GitHubRepoRef = {
  fullName: string;
  owner: string;
  repo: string;
};

type EnrichOptions = {
  now?: Date;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const RESERVED_GITHUB_PATHS = new Set([
  "about",
  "apps",
  "codespaces",
  "collections",
  "customer-stories",
  "enterprise",
  "events",
  "explore",
  "features",
  "gist",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "settings",
  "sponsors",
  "topics",
  "trending",
]);

function cleanRepoSegment(value: string): string {
  return value.replace(/\.git$/i, "");
}

export function parseGitHubRepoUrl(rawUrl: string): GitHubRepoRef | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return null;
  }

  const [ownerRaw, repoRaw] = url.pathname.split("/").filter(Boolean);
  const owner = ownerRaw?.trim();
  const repo = repoRaw ? cleanRepoSegment(repoRaw.trim()) : "";
  if (!owner || !repo || RESERVED_GITHUB_PATHS.has(owner.toLowerCase())) {
    return null;
  }

  return {
    fullName: `${owner}/${repo}`,
    owner,
    repo,
  };
}

function githubHeaders(): Record<string, string> {
  const token = envValue("GITHUB_TOKEN") || envValue("SKILL_GITHUB_TOKEN");
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "my-agent-web-search/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function metadataFromPayload(payload: unknown, retrievedAt: string): GitHubRepositoryMetadata | null {
  const record = asRecord(payload);
  const fullName = stringValue(record.full_name);
  const htmlUrl = stringValue(record.html_url);
  if (!fullName || !htmlUrl) {
    return null;
  }

  const license = asRecord(record.license);
  return {
    default_branch: stringValue(record.default_branch),
    description: stringValue(record.description),
    forks: numberValue(record.forks_count),
    full_name: fullName,
    html_url: htmlUrl,
    language: stringValue(record.language),
    license: stringValue(license.spdx_id ?? license.name),
    open_issues: numberValue(record.open_issues_count),
    pushed_at: stringValue(record.pushed_at),
    retrieved_at: retrievedAt,
    source: "github_rest_api",
    stars: numberValue(record.stargazers_count),
    updated_at: stringValue(record.updated_at),
  };
}

async function fetchGitHubRepository(
  repo: GitHubRepoRef,
  options: EnrichOptions,
): Promise<GitHubRepositoryMetadata | null> {
  const owner = encodeURIComponent(repo.owner);
  const repoName = encodeURIComponent(repo.repo);
  try {
    const payload = await fetchJson(`https://api.github.com/repos/${owner}/${repoName}`, {
      headers: githubHeaders(),
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? configuredWebTimeoutMs(),
    });
    return metadataFromPayload(payload, (options.now ?? new Date()).toISOString());
  } catch {
    return null;
  }
}

export async function enrichGitHubSearchResults(
  results: WebSearchResult[],
  options: EnrichOptions = {},
): Promise<WebSearchResult[]> {
  const enrichLimit = configuredWebSearchGitHubEnrichLimit();
  if (enrichLimit <= 0 || results.length === 0) {
    return results;
  }

  const refs = new Map<string, GitHubRepoRef>();
  for (const result of results) {
    const repo = parseGitHubRepoUrl(result.url);
    if (!repo || refs.has(repo.fullName.toLowerCase())) {
      continue;
    }
    refs.set(repo.fullName.toLowerCase(), repo);
    if (refs.size >= enrichLimit) {
      break;
    }
  }

  if (refs.size === 0) {
    return results;
  }

  const metadata = new Map<string, GitHubRepositoryMetadata>();
  await Promise.all(
    [...refs.entries()].map(async ([key, repo]) => {
      const repoMetadata = await fetchGitHubRepository(repo, options);
      if (repoMetadata) {
        metadata.set(key, repoMetadata);
      }
    }),
  );

  if (metadata.size === 0) {
    return results;
  }

  return results.map((result) => {
    const repo = parseGitHubRepoUrl(result.url);
    const github = repo ? metadata.get(repo.fullName.toLowerCase()) : undefined;
    if (!github) {
      return result;
    }
    return {
      ...result,
      metadata: {
        ...result.metadata,
        github,
      },
    };
  });
}
