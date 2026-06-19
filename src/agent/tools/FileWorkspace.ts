import { createHash, randomUUID } from "crypto";
import { constants } from "fs";
import { access, mkdir, readFile, realpath, stat, writeFile } from "fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "path";

import { serverEnv } from "@/lib/env";

const FALLBACK_WORKSPACE_DIR = ".my-agent/workspaces";
const FALLBACK_ARTIFACT_DIR = ".my-agent/artifacts";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;

export type WorkspaceFile = {
  absolutePath: string;
  content: string;
  displayPath: string;
  exists: boolean;
  mtimeMs: number | null;
  relativePath: string;
};

export type FileArtifact = {
  contentType: string;
  downloadUrl: string;
  filename: string;
  id: string;
  path: string;
  sizeBytes: number;
};

type ArtifactMetadata = FileArtifact & {
  createdAt: string;
  runId: string;
  sessionId: string;
  storagePath: string;
  userId: string;
};

function safeSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "unknown"
  );
}

function storageRoot(envValue: string | undefined, fallback: string): string {
  return resolve(envValue ?? join(process.cwd(), fallback));
}

export function workspaceRoot(userId: string, sessionId: string): string {
  return join(
    storageRoot(serverEnv.FILE_WORKSPACE_DIR, FALLBACK_WORKSPACE_DIR),
    serverEnv.APP_ENV,
    safeSegment(userId),
    safeSegment(sessionId),
  );
}

export function workspaceStateRoot(userId: string, sessionId: string): string {
  return join(
    storageRoot(serverEnv.FILE_WORKSPACE_DIR, FALLBACK_WORKSPACE_DIR),
    serverEnv.APP_ENV,
    safeSegment(userId),
    ".state",
    safeSegment(sessionId),
  );
}

export function artifactRoot(): string {
  return join(storageRoot(serverEnv.ARTIFACT_STORAGE_DIR, FALLBACK_ARTIFACT_DIR), serverEnv.APP_ENV);
}

function assertInside(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Path escapes the session workspace: ${target}`);
  }
  return resolvedTarget;
}

function normalizeRelativePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!trimmed || trimmed.includes("\0")) {
    throw new Error("path is required.");
  }
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    return trimmed;
  }

  const parts = trimmed.split("/").filter(Boolean);
  if (
    parts.some((part) => part === "." || part === "..") ||
    parts.some((part) => part.toLowerCase() === ".git")
  ) {
    throw new Error("Workspace file path contains an unsafe segment.");
  }
  if (parts.some((part) => /^\.env(?:\.|$)/i.test(part))) {
    throw new Error("Workspace file path targets an environment file.");
  }

  return parts.join("/");
}

export function resolveWorkspaceFile(input: {
  path: string;
  sessionId: string;
  userId: string;
}): { absolutePath: string; relativePath: string; root: string } {
  const root = workspaceRoot(input.userId, input.sessionId);
  const normalized = normalizeRelativePath(input.path);
  const absolutePath =
    normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) ?
      assertInside(root, normalized)
    : assertInside(root, join(root, normalized));
  const relativePath = absolutePath === root ? "." : absolutePath.slice(root.length + 1);
  if (!relativePath || relativePath === "." || relativePath.startsWith("..")) {
    throw new Error("Workspace file path must point to a file.");
  }
  return { absolutePath, relativePath: relativePath.replace(/\\/g, "/"), root };
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}

export async function readWorkspaceFile(input: {
  limit?: number;
  offset?: number;
  path: string;
  sessionId: string;
  userId: string;
}): Promise<WorkspaceFile & { isPartialView: boolean; totalLines: number }> {
  const resolved = resolveWorkspaceFile(input);
  const fileStat = await stat(resolved.absolutePath);
  if (!fileStat.isFile()) {
    throw new Error("Path is not a file.");
  }
  if (fileStat.size > MAX_FILE_BYTES) {
    throw new Error(`File is too large to read (${fileStat.size} bytes; limit is ${MAX_FILE_BYTES}).`);
  }

  const buffer = await readFile(resolved.absolutePath);
  if (looksBinary(buffer)) {
    throw new Error("File appears to be binary and cannot be loaded as text.");
  }
  const content = buffer.toString("utf8");
  if (Buffer.byteLength(content) > MAX_TEXT_BYTES && input.limit === undefined) {
    throw new Error(
      `File content is too large to return in one read; use offset and limit (${Buffer.byteLength(
        content,
      )} bytes; limit is ${MAX_TEXT_BYTES}).`,
    );
  }

  const lines = content.split(/\r?\n/);
  const offset = Math.max(1, input.offset ?? 1);
  const start = Math.min(lines.length, offset - 1);
  const end = input.limit === undefined ? lines.length : Math.min(lines.length, start + input.limit);
  const isPartialView = start > 0 || end < lines.length;
  return {
    absolutePath: resolved.absolutePath,
    content: lines.slice(start, end).join("\n"),
    displayPath: resolved.relativePath,
    exists: true,
    isPartialView,
    mtimeMs: Math.floor(fileStat.mtimeMs),
    relativePath: resolved.relativePath,
    totalLines: lines.length,
  };
}

export async function readWorkspaceFileForWrite(input: {
  path: string;
  sessionId: string;
  userId: string;
}): Promise<WorkspaceFile> {
  const resolved = resolveWorkspaceFile(input);
  try {
    const fileStat = await stat(resolved.absolutePath);
    if (!fileStat.isFile()) {
      throw new Error("Path is not a file.");
    }
    if (fileStat.size > MAX_FILE_BYTES) {
      throw new Error(`File is too large to edit (${fileStat.size} bytes; limit is ${MAX_FILE_BYTES}).`);
    }
    const buffer = await readFile(resolved.absolutePath);
    if (looksBinary(buffer)) {
      throw new Error("File appears to be binary and cannot be edited as text.");
    }
    return {
      absolutePath: resolved.absolutePath,
      content: buffer.toString("utf8"),
      displayPath: resolved.relativePath,
      exists: true,
      mtimeMs: Math.floor(fileStat.mtimeMs),
      relativePath: resolved.relativePath,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        absolutePath: resolved.absolutePath,
        content: "",
        displayPath: resolved.relativePath,
        exists: false,
        mtimeMs: null,
        relativePath: resolved.relativePath,
      };
    }
    throw error;
  }
}

export async function ensureWorkspaceRoot(input: { sessionId: string; userId: string }) {
  await mkdir(workspaceRoot(input.userId, input.sessionId), { mode: 0o700, recursive: true });
}

function contentTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".md") return "text/markdown; charset=utf-8";
  if (ext === ".txt") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

export async function publishWorkspaceArtifact(input: {
  absolutePath: string;
  relativePath: string;
  runId: string;
  sessionId: string;
  userId: string;
}): Promise<FileArtifact> {
  const id = `artifact_${randomUUID()}`;
  const artifactDir = join(artifactRoot(), safeSegment(input.userId), id);
  await mkdir(artifactDir, { mode: 0o700, recursive: true });
  const content = await readFile(input.absolutePath);
  const filename = basename(input.relativePath) || `${id}.txt`;
  const storagePath = join(artifactDir, filename);
  await writeFile(storagePath, content, { mode: 0o600 });
  const artifact: FileArtifact = {
    contentType: contentTypeForPath(filename),
    downloadUrl: `/api/agent/artifacts/${encodeURIComponent(id)}/download`,
    filename,
    id,
    path: input.relativePath,
    sizeBytes: content.length,
  };
  const metadata: ArtifactMetadata = {
    ...artifact,
    createdAt: new Date().toISOString(),
    runId: input.runId,
    sessionId: input.sessionId,
    storagePath,
    userId: input.userId,
  };
  await writeFile(join(artifactDir, "metadata.json"), JSON.stringify(metadata, null, 2), {
    mode: 0o600,
  });
  return artifact;
}

export async function getArtifactForDownload(input: {
  artifactId: string;
  userId: string;
}): Promise<{ content: Buffer; metadata: ArtifactMetadata } | null> {
  const id = safeSegment(input.artifactId);
  if (id !== input.artifactId) {
    return null;
  }
  const metadataPath = join(artifactRoot(), safeSegment(input.userId), id, "metadata.json");
  let metadata: ArtifactMetadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8")) as ArtifactMetadata;
  } catch {
    return null;
  }
  if (metadata.userId !== input.userId) {
    return null;
  }
  const resolvedArtifactRoot = await realpath(join(artifactRoot(), safeSegment(input.userId), id));
  const resolvedStoragePath = await realpath(resolve(metadata.storagePath));
  assertInside(resolvedArtifactRoot, resolvedStoragePath);
  await access(resolvedStoragePath, constants.R_OK);
  return {
    content: await readFile(resolvedStoragePath),
    metadata,
  };
}

export function fileSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
