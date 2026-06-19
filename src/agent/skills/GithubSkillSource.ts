import { basename, dirname, posix } from "path";

import type { SkillBundle, SkillBundleFile } from "@/agent/skills/SkillManifest";
import { serverEnv } from "@/lib/env";

const GITHUB_API_URL = "https://api.github.com";
const MAX_GITHUB_TREE_ENTRIES = 1_000;

export type GithubSkillLocation = {
  commitSha: string;
  owner: string;
  path: string;
  ref: string;
  repo: string;
  sourceUrl: string;
};

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

type GithubBlob = {
  content?: string;
  encoding?: string;
};

function githubHeaders(): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "my-agent-skill-installer",
    ...(serverEnv.SKILL_GITHUB_TOKEN ?
      { Authorization: `Bearer ${serverEnv.SKILL_GITHUB_TOKEN}` }
    : {}),
  };
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

function chooseSkillRoot(paths: string[], requestedPath: string): string {
  const normalizedRequestedPath = normalizeSelectedPath(requestedPath);
  const directSkill = normalizedRequestedPath ?
    `${normalizedRequestedPath}/SKILL.md`
  : "SKILL.md";
  if (paths.includes(directSkill)) {
    return normalizedRequestedPath;
  }
  if (normalizedRequestedPath.endsWith("/SKILL.md") && paths.includes(normalizedRequestedPath)) {
    return dirname(normalizedRequestedPath);
  }
  if (normalizedRequestedPath === "SKILL.md" && paths.includes("SKILL.md")) {
    return "";
  }

  const candidates = paths.filter((path) => path.endsWith("/SKILL.md") || path === "SKILL.md");
  if (!normalizedRequestedPath && candidates.length === 1) {
    return candidates[0] === "SKILL.md" ? "" : dirname(candidates[0]);
  }

  throw new Error(
    normalizedRequestedPath ?
      `No SKILL.md found at GitHub path '${normalizedRequestedPath}'.`
    : "Repository must contain exactly one SKILL.md when no path is provided.",
  );
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

    const tree = await githubJson<GithubTree>(
      `/repos/${apiPath(location.owner)}/${apiPath(location.repo)}/git/trees/${apiPath(
        location.commitSha,
      )}?recursive=1`,
      signal,
    );
    const entries = tree.tree ?? [];
    if (tree.truncated || entries.length > MAX_GITHUB_TREE_ENTRIES) {
      throw new Error("GitHub tree is too large or truncated; select a narrower skill path.");
    }

    const paths = entries
      .map((entry) => entry.path)
      .filter((path): path is string => Boolean(path));
    const skillRoot = chooseSkillRoot(paths, location.path);
    const filesToFetch = entries
      .filter((entry) => entry.type === "blob" && entry.path && entry.sha)
      .map((entry) => {
        const relativePath = relativeUnderRoot(entry.path ?? "", skillRoot);
        return relativePath ? { ...entry, relativePath } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    const files: SkillBundleFile[] = [];
    for (const file of filesToFetch) {
      if (file.mode === "120000") {
        throw new Error(`GitHub skill contains symlink '${file.relativePath}', which is not allowed.`);
      }
      const blob = await githubJson<GithubBlob>(
        `/repos/${apiPath(location.owner)}/${apiPath(location.repo)}/git/blobs/${apiPath(
          file.sha ?? "",
        )}`,
        signal,
      );
      if (blob.encoding !== "base64" || !blob.content) {
        throw new Error(`GitHub blob '${file.relativePath}' is not base64 encoded.`);
      }
      files.push({
        content: Buffer.from(blob.content.replace(/\s+/g, ""), "base64"),
        path: file.relativePath,
      });
    }

    return {
      files,
      identifier: `${location.owner}/${location.repo}/${skillRoot || "."}@${location.commitSha}`,
      metadata: {
        commitSha: location.commitSha,
        owner: location.owner,
        path: skillRoot,
        ref: location.ref,
        repo: location.repo,
        sourceUrl: location.sourceUrl,
      },
      source: "github",
      trustLevel: "community",
    };
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
