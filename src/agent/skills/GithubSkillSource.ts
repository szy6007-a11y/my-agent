import { basename, dirname, posix } from "path";

import type { SkillBundle, SkillBundleFile } from "@/agent/skills/SkillManifest";
import { serverEnv } from "@/lib/env";

const GITHUB_API_URL = "https://api.github.com";
const MAX_REPO_DISCOVERY_DIRECTORIES = 300;
const MAX_REPO_DISCOVERY_ENTRIES = 3_000;

export type GithubSkillLocation = {
  commitSha: string;
  owner: string;
  path: string;
  ref: string;
  repo: string;
  sourceUrl: string;
};

export type GithubSkillCandidate = {
  path: string;
  skillFilePath: string;
  sourceUrl: string;
};

export class GithubSkillSelectionRequiredError extends Error {
  constructor(
    message: string,
    readonly candidates: GithubSkillCandidate[],
  ) {
    super(message);
    this.name = "GithubSkillSelectionRequiredError";
  }
}

type GithubRepo = {
  default_branch?: string;
  full_name?: string;
};

type GithubCommit = {
  sha?: string;
};

type GithubTree = {
  tree?: Array<{
    mode?: string;
    path?: string;
    sha?: string;
    size?: number;
    type?: string;
  }>;
  truncated?: boolean;
};

type GithubContentItem = {
  content?: string;
  encoding?: string;
  name?: string;
  path?: string;
  size?: number;
  type?: "file" | "dir" | "symlink" | "submodule";
};

function githubHeaders(): HeadersInit {
  const token = serverEnv.SKILL_GITHUB_TOKEN ?? serverEnv.GITHUB_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "my-agent-skill-installer",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function githubRateLimitMessage(response: Response, body: string): string | null {
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (response.status !== 403 || remaining !== "0") {
    return null;
  }

  const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
  const resetAt =
    Number.isFinite(resetSeconds) && resetSeconds > 0 ?
      new Date(resetSeconds * 1000).toISOString()
    : null;

  return [
    "GitHub API rate limit exhausted for the current server egress IP.",
    "Configure SKILL_GITHUB_TOKEN or GITHUB_TOKEN on the server to use authenticated GitHub API quota.",
    resetAt ? `Unauthenticated quota resets around ${resetAt}.` : "",
    body ? `GitHub response: ${body.slice(0, 240)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function normalizeRepoInput(input: string): URL {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/.*)?$/.test(trimmed)) {
    return new URL(`https://github.com/${trimmed}`);
  }
  const url = new URL(trimmed);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Only https://github.com URLs or owner/repo inputs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("GitHub URL must not include credentials.");
  }
  return url;
}

function parseGithubPath(input: string): {
  explicitPath?: string;
  owner: string;
  repo: string;
  treeSegments: string[];
} {
  const url = normalizeRepoInput(input);
  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, rawRepo, marker, ...rest] = parts;
  if (!owner || !rawRepo) {
    throw new Error("GitHub skill source must include owner and repository.");
  }
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("GitHub owner or repository contains unsupported characters.");
  }

  if (marker === "tree" || marker === "blob") {
    return { owner, repo, treeSegments: rest };
  }

  const explicitPath = marker ? [marker, ...rest].join("/") : undefined;
  return { explicitPath, owner, repo, treeSegments: [] };
}

function apiPath(path: string): string {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function githubJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${GITHUB_API_URL}${path}`, {
    headers: githubHeaders(),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const rateLimitMessage = githubRateLimitMessage(response, body);
    if (rateLimitMessage) {
      throw new Error(rateLimitMessage);
    }
    throw new Error(`GitHub API ${response.status}: ${body.slice(0, 240) || response.statusText}`);
  }

  return (await response.json()) as T;
}

async function githubJsonUrl<T>(url: string, signal?: AbortSignal): Promise<T> {
  const parsed = new URL(url);
  if (parsed.origin !== GITHUB_API_URL) {
    throw new Error("Refusing to fetch non-GitHub API URL.");
  }
  return githubJson<T>(`${parsed.pathname}${parsed.search}`, signal);
}

async function resolveRepo(owner: string, repo: string, signal?: AbortSignal): Promise<GithubRepo> {
  return githubJson<GithubRepo>(`/repos/${apiPath(owner)}/${apiPath(repo)}`, signal);
}

async function resolveCommit(
  owner: string,
  repo: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string> {
  const commit = await githubJson<GithubCommit>(
    `/repos/${apiPath(owner)}/${apiPath(repo)}/commits/${apiPath(ref)}`,
    signal,
  );
  if (!commit.sha) {
    throw new Error(`GitHub ref '${ref}' did not resolve to a commit.`);
  }
  return commit.sha;
}

async function resolveTreeRef(
  input: {
    defaultBranch: string;
    explicitPath?: string;
    owner: string;
    repo: string;
    treeSegments: string[];
  },
  signal?: AbortSignal,
) {
  if (input.treeSegments.length === 0) {
    return {
      path: input.explicitPath ?? "",
      ref: input.defaultBranch,
      sha: await resolveCommit(input.owner, input.repo, input.defaultBranch, signal),
    };
  }

  let lastError: unknown;
  for (let index = input.treeSegments.length; index >= 1; index -= 1) {
    const ref = input.treeSegments.slice(0, index).join("/");
    try {
      const sha = await resolveCommit(input.owner, input.repo, ref, signal);
      return {
        path: input.treeSegments.slice(index).join("/"),
        ref,
        sha,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Could not resolve GitHub ref.");
}

function normalizeSelectedPath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, "/").replace(/^\/+/, ""));
  if (!normalized || normalized === ".") {
    return "";
  }
  if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error("GitHub skill path must not escape the repository root.");
  }
  return normalized.replace(/\/+$/, "");
}

function relativeUnderRoot(path: string, root: string): string | null {
  if (!root) {
    return path;
  }
  if (path === root) {
    return basename(path);
  }
  if (!path.startsWith(`${root}/`)) {
    return null;
  }
  return path.slice(root.length + 1);
}

function skillCandidatesFromPaths(
  paths: string[],
  location: GithubSkillLocation,
): GithubSkillCandidate[] {
  return [
    ...new Map(
      paths
        .filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md"))
        .map((skillFilePath) => {
          const path = skillFilePath === "SKILL.md" ? "" : dirname(skillFilePath);
          return [
            path,
            {
              path,
              skillFilePath,
              sourceUrl: `https://github.com/${location.owner}/${location.repo}/tree/${location.commitSha}${
                path ? `/${path}` : ""
              }`,
            },
          ] as const;
        }),
    ).values(),
  ].sort((left, right) => {
    if (left.path === "") return -1;
    if (right.path === "") return 1;
    return left.path.localeCompare(right.path);
  });
}

async function discoverSkillCandidatesByContents(
  location: GithubSkillLocation,
  signal?: AbortSignal,
): Promise<GithubSkillCandidate[]> {
  const queue = [""];
  const skillPaths: string[] = [];
  let visitedDirectories = 0;
  let seenEntries = 0;

  while (queue.length > 0) {
    const path = queue.shift() ?? "";
    visitedDirectories += 1;
    if (visitedDirectories > MAX_REPO_DISCOVERY_DIRECTORIES) {
      throw new Error(
        `Repository discovery exceeded ${MAX_REPO_DISCOVERY_DIRECTORIES} directories; provide a skill path.`,
      );
    }

    const suffix = path ? `/${apiPath(path)}` : "";
    const content = await githubJson<GithubContentItem | GithubContentItem[]>(
      `/repos/${apiPath(location.owner)}/${apiPath(location.repo)}/contents${suffix}?ref=${apiPath(
        location.commitSha,
      )}`,
      signal,
    );
    const items = Array.isArray(content) ? content : [content];
    seenEntries += items.length;
    if (seenEntries > MAX_REPO_DISCOVERY_ENTRIES) {
      throw new Error(
        `Repository discovery exceeded ${MAX_REPO_DISCOVERY_ENTRIES} entries; provide a skill path.`,
      );
    }

    for (const item of items) {
      if (!item.path || !item.type) {
        continue;
      }
      if (item.type === "file" && basename(item.path) === "SKILL.md") {
        skillPaths.push(item.path);
      }
      if (item.type === "dir") {
        queue.push(item.path);
      }
    }
  }

  return skillCandidatesFromPaths(skillPaths, location);
}

async function discoverSkillCandidates(
  location: GithubSkillLocation,
  signal?: AbortSignal,
): Promise<GithubSkillCandidate[]> {
  try {
    const tree = await githubJson<GithubTree>(
      `/repos/${apiPath(location.owner)}/${apiPath(location.repo)}/git/trees/${apiPath(
        location.commitSha,
      )}?recursive=1`,
      signal,
    );
    const entries = tree.tree ?? [];
    const candidates = skillCandidatesFromPaths(
      entries
        .map((entry) => entry.path)
        .filter((path): path is string => Boolean(path)),
      location,
    );
    if (!tree.truncated || candidates.length > 0) {
      return candidates;
    }
  } catch {
    // Fall through to Contents API discovery, which is slower but works for repos
    // where recursive tree retrieval is truncated or unavailable.
  }

  return discoverSkillCandidatesByContents(location, signal);
}

export class GithubSkillSource {
  async resolve(input: string, signal?: AbortSignal): Promise<GithubSkillLocation> {
    const parsed = parseGithubPath(input);
    const repo = await resolveRepo(parsed.owner, parsed.repo, signal);
    const defaultBranch = repo.default_branch ?? "main";
    const resolved = await resolveTreeRef(
      {
        defaultBranch,
        explicitPath: parsed.explicitPath,
        owner: parsed.owner,
        repo: parsed.repo,
        treeSegments: parsed.treeSegments,
      },
      signal,
    );

    return {
      commitSha: resolved.sha,
      owner: parsed.owner,
      path: normalizeSelectedPath(resolved.path),
      ref: resolved.ref,
      repo: parsed.repo,
      sourceUrl: `https://github.com/${parsed.owner}/${parsed.repo}/tree/${resolved.sha}${
        resolved.path ? `/${resolved.path}` : ""
      }`,
    };
  }

  async fetchBundle(location: GithubSkillLocation, signal?: AbortSignal): Promise<SkillBundle> {
    if (location.path) {
      return this.fetchContentsBundle(location, signal);
    }

    const candidates = await discoverSkillCandidates(location, signal);
    if (candidates.length === 0) {
      throw new Error("Repository does not contain any SKILL.md files.");
    }
    if (candidates[0]?.path === "" || candidates.length === 1) {
      const selected = candidates[0];
      return this.fetchContentsBundle(
        {
          ...location,
          path: selected.path,
          sourceUrl: selected.sourceUrl,
        },
        signal,
      );
    }

    throw new GithubSkillSelectionRequiredError(
      "Repository contains multiple skills. Choose one candidate path and call install_github_skill again with its sourceUrl.",
      candidates,
    );
  }

  private async fetchContentsBundle(
    location: GithubSkillLocation,
    signal?: AbortSignal,
  ): Promise<SkillBundle> {
    const rootPath = normalizeSelectedPath(
      location.path.endsWith("/SKILL.md") || location.path === "SKILL.md" ?
        dirname(location.path)
      : location.path,
    );
    const files: SkillBundleFile[] = [];
    const visit = async (path: string) => {
      const suffix = path ? `/${apiPath(path)}` : "";
      const content = await githubJson<GithubContentItem | GithubContentItem[]>(
        `/repos/${apiPath(location.owner)}/${apiPath(location.repo)}/contents${suffix}?ref=${apiPath(
          location.commitSha,
        )}`,
        signal,
      );
      const items = Array.isArray(content) ? content : [content];
      for (const item of items) {
        if (!item.path || !item.type) {
          continue;
        }
        if (item.type === "symlink" || item.type === "submodule") {
          throw new Error(`GitHub skill contains unsupported ${item.type} '${item.path}'.`);
        }
        if (item.type === "dir") {
          await visit(item.path);
          continue;
        }
        if (item.type !== "file") {
          continue;
        }
        const fileContent = Array.isArray(content) ?
          await githubJson<GithubContentItem>(
            `/repos/${apiPath(location.owner)}/${apiPath(location.repo)}/contents/${apiPath(
              item.path,
            )}?ref=${apiPath(location.commitSha)}`,
            signal,
          )
        : item;
        if (fileContent.encoding !== "base64" || !fileContent.content) {
          throw new Error(`GitHub content '${item.path}' is not base64 encoded.`);
        }
        const relativePath = relativeUnderRoot(item.path, rootPath);
        if (relativePath) {
          files.push({
            content: Buffer.from(fileContent.content.replace(/\s+/g, ""), "base64"),
            path: relativePath,
          });
        }
      }
    };

    await visit(rootPath);
    if (!files.some((file) => file.path === "SKILL.md")) {
      throw new Error(`No SKILL.md found at GitHub path '${rootPath}'.`);
    }

    return {
      files,
      identifier: `${location.owner}/${location.repo}/${rootPath || "."}@${location.commitSha}`,
      metadata: {
        commitSha: location.commitSha,
        owner: location.owner,
        path: rootPath,
        ref: location.ref,
        repo: location.repo,
        sourceUrl: location.sourceUrl,
      },
      source: "github",
      trustLevel: "community",
    };
  }
}
