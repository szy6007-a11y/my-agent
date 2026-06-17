import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  closeSync,
  fsyncSync,
} from "fs";
import { basename, dirname, join } from "path";
import { setTimeout as sleep } from "timers/promises";

import { getUserMemoryDir } from "@/agent/memory/MemoryPaths";
import {
  firstStrictMemoryThreatMessage,
  scanStrictMemoryContent,
} from "@/agent/memory/ThreatPatterns";
import { serverEnv } from "@/lib/env";

export type MemoryTarget = "memory" | "user";
export type MemoryAction = "add" | "replace" | "remove";

export type MemoryMutationResult = {
  current_entries?: string[];
  drift_backup?: string;
  entry_count?: number;
  entries?: string[];
  error?: string;
  message?: string;
  remediation?: string;
  success: boolean;
  target?: MemoryTarget;
  usage?: string;
};

export const ENTRY_DELIMITER = "\n§\n";

const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
const DEFAULT_USER_CHAR_LIMIT = 1375;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 40;

function readLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value && value > 0 ? value : fallback;
}

function uniqueEntries(entries: string[]): string[] {
  return [...new Set(entries)];
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function formatPercent(current: number, limit: number): string {
  const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
  return `${pct}% - ${current.toLocaleString()}/${limit.toLocaleString()} chars`;
}

function driftError(path: string, backupPath: string): MemoryMutationResult {
  return {
    drift_backup: backupPath,
    error:
      `Refusing to write ${basename(path)}: file on disk has content that would not round-trip through the memory tool. ` +
      `A snapshot was saved to ${backupPath}. Resolve the drift first, then retry.`,
    remediation:
      "Open the backup, integrate missing facts through memory(action='add', ...), then rewrite the original file as a clean §-delimited list.",
    success: false,
  };
}

export class MemoryStore {
  private memoryEntries: string[] = [];
  private userEntries: string[] = [];
  private systemPromptSnapshot: Record<MemoryTarget, string> = {
    memory: "",
    user: "",
  };

  constructor(
    private readonly userId: string,
    private readonly memoryCharLimit = readLimit(
      serverEnv.MEMORY_CHAR_LIMIT,
      DEFAULT_MEMORY_CHAR_LIMIT,
    ),
    private readonly userCharLimit = readLimit(
      serverEnv.USER_MEMORY_CHAR_LIMIT,
      DEFAULT_USER_CHAR_LIMIT,
    ),
  ) {}

  get directory(): string {
    return getUserMemoryDir(this.userId);
  }

  loadFromDisk(): void {
    mkdirSync(this.directory, { recursive: true });
    this.memoryEntries = uniqueEntries(this.readFile(this.pathFor("memory")));
    this.userEntries = uniqueEntries(this.readFile(this.pathFor("user")));

    const sanitizedMemory = this.sanitizeEntriesForSnapshot(this.memoryEntries, "MEMORY.md");
    const sanitizedUser = this.sanitizeEntriesForSnapshot(this.userEntries, "USER.md");

    this.systemPromptSnapshot = {
      memory: this.renderBlock("memory", sanitizedMemory),
      user: this.renderBlock("user", sanitizedUser),
    };
  }

  formatForSystemPrompt(target: MemoryTarget): string | null {
    const block = this.systemPromptSnapshot[target];
    return block ? block : null;
  }

  async add(target: MemoryTarget, rawContent: string): Promise<MemoryMutationResult> {
    const content = rawContent.trim();
    if (!content) {
      return { error: "Content cannot be empty.", success: false };
    }

    const scanError = firstStrictMemoryThreatMessage(content);
    if (scanError) {
      return { error: scanError, success: false };
    }

    return this.withFileLock(target, async () => {
      const drift = this.reloadTarget(target);
      if (drift) {
        return driftError(this.pathFor(target), drift);
      }

      const entries = this.entriesFor(target);
      if (entries.includes(content)) {
        return this.successResponse(target, "Entry already exists (no duplicate added).");
      }

      const next = [...entries, content];
      const limit = this.charLimit(target);
      const nextTotal = this.joinEntries(next).length;
      if (nextTotal > limit) {
        const current = this.charCount(target);
        return {
          current_entries: entries,
          error:
            `Memory at ${current.toLocaleString()}/${limit.toLocaleString()} chars. ` +
            `Adding this entry (${content.length} chars) would exceed the limit. ` +
            "Consolidate or remove stale entries, then retry this add in the same turn.",
          success: false,
          usage: `${current.toLocaleString()}/${limit.toLocaleString()}`,
        };
      }

      this.setEntries(target, next);
      this.saveToDisk(target);
      return this.successResponse(target, "Entry added.");
    });
  }

  async replace(
    target: MemoryTarget,
    rawOldText: string,
    rawNewContent: string,
  ): Promise<MemoryMutationResult> {
    const oldText = rawOldText.trim();
    const newContent = rawNewContent.trim();
    if (!oldText) {
      return { error: "old_text cannot be empty.", success: false };
    }
    if (!newContent) {
      return { error: "new_content cannot be empty. Use remove to delete entries.", success: false };
    }

    const scanError = firstStrictMemoryThreatMessage(newContent);
    if (scanError) {
      return { error: scanError, success: false };
    }

    return this.withFileLock(target, async () => {
      const drift = this.reloadTarget(target);
      if (drift) {
        return driftError(this.pathFor(target), drift);
      }

      const entries = this.entriesFor(target);
      const matches = entries
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.includes(oldText));

      if (matches.length === 0) {
        return { error: `No entry matched '${oldText}'.`, success: false };
      }

      if (new Set(matches.map(({ entry }) => entry)).size > 1) {
        return {
          current_entries: matches.map(({ entry }) =>
            entry.length > 80 ? `${entry.slice(0, 80)}...` : entry,
          ),
          error: `Multiple entries matched '${oldText}'. Be more specific.`,
          success: false,
        };
      }

      const next = [...entries];
      next[matches[0].index] = newContent;
      const limit = this.charLimit(target);
      const nextTotal = this.joinEntries(next).length;
      if (nextTotal > limit) {
        return {
          current_entries: entries,
          error:
            `Replacement would put memory at ${nextTotal.toLocaleString()}/${limit.toLocaleString()} chars. ` +
            "Shorten the replacement or remove stale entries first.",
          success: false,
          usage: `${this.charCount(target).toLocaleString()}/${limit.toLocaleString()}`,
        };
      }

      this.setEntries(target, next);
      this.saveToDisk(target);
      return this.successResponse(target, "Entry replaced.");
    });
  }

  async remove(target: MemoryTarget, rawOldText: string): Promise<MemoryMutationResult> {
    const oldText = rawOldText.trim();
    if (!oldText) {
      return { error: "old_text cannot be empty.", success: false };
    }

    return this.withFileLock(target, async () => {
      const drift = this.reloadTarget(target);
      if (drift) {
        return driftError(this.pathFor(target), drift);
      }

      const entries = this.entriesFor(target);
      const matches = entries
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.includes(oldText));

      if (matches.length === 0) {
        return { error: `No entry matched '${oldText}'.`, success: false };
      }

      if (new Set(matches.map(({ entry }) => entry)).size > 1) {
        return {
          current_entries: matches.map(({ entry }) =>
            entry.length > 80 ? `${entry.slice(0, 80)}...` : entry,
          ),
          error: `Multiple entries matched '${oldText}'. Be more specific.`,
          success: false,
        };
      }

      const next = [...entries];
      next.splice(matches[0].index, 1);
      this.setEntries(target, next);
      this.saveToDisk(target);
      return this.successResponse(target, "Entry removed.");
    });
  }

  private async withFileLock<T>(target: MemoryTarget, fn: () => Promise<T>): Promise<T> {
    const path = this.pathFor(target);
    const lockDir = `${path}.lock`;
    mkdirSync(dirname(path), { recursive: true });
    const started = Date.now();

    while (true) {
      try {
        mkdirSync(lockDir);
        break;
      } catch (error) {
        if (Date.now() - started > LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for memory lock ${lockDir}`);
        }
        await sleep(LOCK_POLL_MS);
      }
    }

    try {
      return await fn();
    } finally {
      rmSync(lockDir, { force: true, recursive: true });
    }
  }

  private pathFor(target: MemoryTarget): string {
    return join(this.directory, target === "user" ? "USER.md" : "MEMORY.md");
  }

  private entriesFor(target: MemoryTarget): string[] {
    return target === "user" ? this.userEntries : this.memoryEntries;
  }

  private setEntries(target: MemoryTarget, entries: string[]): void {
    if (target === "user") {
      this.userEntries = entries;
      return;
    }
    this.memoryEntries = entries;
  }

  private charLimit(target: MemoryTarget): number {
    return target === "user" ? this.userCharLimit : this.memoryCharLimit;
  }

  private charCount(target: MemoryTarget): number {
    return this.joinEntries(this.entriesFor(target)).length;
  }

  private joinEntries(entries: string[]): string {
    return entries.length > 0 ? entries.join(ENTRY_DELIMITER) : "";
  }

  private readFile(path: string): string[] {
    if (!fileExists(path)) {
      return [];
    }
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) {
      return [];
    }
    return raw
      .split(ENTRY_DELIMITER)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  private sanitizeEntriesForSnapshot(entries: string[], filename: string): string[] {
    return entries.map((entry) => {
      if (!entry || entry.startsWith("[BLOCKED:")) {
        return entry;
      }
      const findings = scanStrictMemoryContent(entry);
      if (findings.length === 0) {
        return entry;
      }
      return `[BLOCKED: ${filename} entry contained threat pattern(s): ${findings.join(", ")}. Removed from system prompt; use memory(action='remove') to delete the original.]`;
    });
  }

  private reloadTarget(target: MemoryTarget): string | null {
    const drift = this.detectExternalDrift(target);
    this.setEntries(target, uniqueEntries(this.readFile(this.pathFor(target))));
    return drift;
  }

  private detectExternalDrift(target: MemoryTarget): string | null {
    const path = this.pathFor(target);
    if (!fileExists(path)) {
      return null;
    }

    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) {
      return null;
    }

    const parsed = raw
      .split(ENTRY_DELIMITER)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const roundTrip = this.joinEntries(parsed);
    const maxEntryLength = parsed.reduce((max, entry) => Math.max(max, entry.length), 0);
    const driftDetected = raw.trim() !== roundTrip || maxEntryLength > this.charLimit(target);
    if (!driftDetected) {
      return null;
    }

    const backupPath = `${path}.bak.${Math.floor(Date.now() / 1000)}`;
    writeFileSync(backupPath, raw, "utf8");
    return backupPath;
  }

  private saveToDisk(target: MemoryTarget): void {
    const path = this.pathFor(target);
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = join(dirname(path), `.mem_${process.pid}_${Date.now()}.tmp`);
    const fd = openSync(tempPath, "w", 0o600);
    try {
      writeFileSync(fd, this.joinEntries(this.entriesFor(target)), "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    try {
      renameSync(tempPath, path);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup.
      }
      throw error;
    }
  }

  private renderBlock(target: MemoryTarget, entries: string[]): string {
    if (entries.length === 0) {
      return "";
    }

    const content = this.joinEntries(entries);
    const limit = this.charLimit(target);
    const current = content.length;
    const header =
      target === "user" ?
        `USER PROFILE (who the user is) [${formatPercent(current, limit)}]`
      : `MEMORY (agent notes) [${formatPercent(current, limit)}]`;
    const separator = "==============================================";
    return `${separator}\n${header}\n${separator}\n${content}`;
  }

  private successResponse(target: MemoryTarget, message: string): MemoryMutationResult {
    const entries = this.entriesFor(target);
    const current = this.charCount(target);
    const limit = this.charLimit(target);
    return {
      entries,
      entry_count: entries.length,
      message,
      success: true,
      target,
      usage: formatPercent(current, limit),
    };
  }
}
