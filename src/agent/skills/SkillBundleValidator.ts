import { basename, dirname, posix } from "path";

import {
  hashSkillFiles,
  parseSkillManifest,
  type ParsedSkillBundle,
  type SkillBundle,
  type SkillBundleFile,
} from "@/agent/skills/SkillManifest";
import { serverEnv } from "@/lib/env";

export const MAX_SKILL_FILES = 200;
export const DEFAULT_MAX_SKILL_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_SKILL_TOTAL_BYTES = serverEnv.SKILL_MAX_TOTAL_BYTES ?? DEFAULT_MAX_SKILL_TOTAL_BYTES;
export const MAX_SKILL_FILE_BYTES = 1024 * 1024;
export const MAX_SKILL_MD_BYTES = 256 * 1024;

const TEXT_FILE_PATTERN =
  /(?:^SKILL\.md$|\.md$|\.txt$|\.json$|\.ya?ml$|\.toml$|\.js$|\.jsx$|\.ts$|\.tsx$|\.mjs$|\.cjs$|\.py$|\.sh$|\.css$|\.html$|\.csv$|\.sql$)/i;

export type SkillValidationResult =
  | {
      ok: true;
      bundle: ParsedSkillBundle;
      warnings: string[];
    }
  | {
      ok: false;
      error: string;
      warnings: string[];
    };

export function normalizeBundlePath(rawPath: string): string {
  const replaced = rawPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (
    !replaced ||
    replaced.startsWith("/") ||
    /^[A-Za-z]:/.test(replaced) ||
    replaced.includes("\0")
  ) {
    throw new Error(`Unsafe skill file path: ${rawPath}`);
  }

  const normalized = posix.normalize(replaced);
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.includes("/../")
  ) {
    throw new Error(`Unsafe skill file path: ${rawPath}`);
  }

  return normalized;
}

export function isLikelyTextFile(file: SkillBundleFile): boolean {
  if (TEXT_FILE_PATTERN.test(file.path)) {
    return true;
  }
  const sample = file.content.subarray(0, Math.min(file.content.length, 4096));
  return !sample.includes(0);
}

function isPlatformCompatible(platforms: string[]): boolean {
  if (platforms.length === 0) {
    return true;
  }
  const aliases = new Set([
    process.platform,
    process.platform === "darwin" ? "macos" : "",
    process.platform === "win32" ? "windows" : "",
    process.platform === "linux" ? "linux" : "",
  ]);

  return platforms.some((platform) => aliases.has(platform.toLowerCase()));
}

function warningForFile(file: SkillBundleFile): string | null {
  if (file.content.length > MAX_SKILL_FILE_BYTES) {
    return `${file.path} exceeds ${MAX_SKILL_FILE_BYTES} bytes and was rejected.`;
  }
  if (!isLikelyTextFile(file) && !file.path.startsWith("assets/")) {
    return `${file.path} looks binary and is outside assets/.`;
  }
  return null;
}

function fallbackSkillName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "skill"
  );
}

export function validateSkillBundle(bundle: SkillBundle): SkillValidationResult {
  const warnings: string[] = [];
  try {
    if (bundle.files.length === 0) {
      return { error: "Skill bundle is empty.", ok: false, warnings };
    }
    if (bundle.files.length > MAX_SKILL_FILES) {
      return {
        error: `Skill bundle has ${bundle.files.length} files; limit is ${MAX_SKILL_FILES}.`,
        ok: false,
        warnings,
      };
    }

    const normalizedFiles = bundle.files.map((file) => ({
      content: file.content,
      path: normalizeBundlePath(file.path),
    }));
    const seen = new Set<string>();
    for (const file of normalizedFiles) {
      if (seen.has(file.path)) {
        return { error: `Duplicate skill file path: ${file.path}`, ok: false, warnings };
      }
      seen.add(file.path);
      if (basename(file.path) === "" || dirname(file.path).split("/").includes("..")) {
        return { error: `Unsafe skill file path: ${file.path}`, ok: false, warnings };
      }
      const warning = warningForFile(file);
      if (warning) {
        return { error: warning, ok: false, warnings };
      }
    }

    const totalBytes = normalizedFiles.reduce((total, file) => total + file.content.length, 0);
    if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
      return {
        error: `Skill bundle is ${totalBytes} bytes; limit is ${MAX_SKILL_TOTAL_BYTES}.`,
        ok: false,
        warnings,
      };
    }

    const skillFile = normalizedFiles.find((file) => file.path === "SKILL.md");
    if (!skillFile) {
      return {
        error: "Skill bundle must contain SKILL.md at its selected root.",
        ok: false,
        warnings,
      };
    }
    if (skillFile.content.length > MAX_SKILL_MD_BYTES) {
      return {
        error: `SKILL.md is ${skillFile.content.length} bytes; limit is ${MAX_SKILL_MD_BYTES}.`,
        ok: false,
        warnings,
      };
    }

    const fallbackName = fallbackSkillName(String(bundle.metadata.name ?? bundle.identifier));
    const manifest = parseSkillManifest(skillFile.content.toString("utf8"), fallbackName);
    if (!manifest.name.trim()) {
      return { error: "Skill name is empty.", ok: false, warnings };
    }
    if (!manifest.userInvocable) {
      warnings.push("Skill declares user-invocable=false; runtime will still load it only by explicit tool call.");
    }
    if (!isPlatformCompatible(manifest.platforms)) {
      return {
        error: `Skill platform is not compatible with ${process.platform}.`,
        ok: false,
        warnings,
      };
    }

    return {
      bundle: {
        ...bundle,
        contentHash: hashSkillFiles(normalizedFiles),
        files: normalizedFiles.sort((a, b) => a.path.localeCompare(b.path)),
        manifest,
        skillFile,
      },
      ok: true,
      warnings,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Skill bundle validation failed.",
      ok: false,
      warnings,
    };
  }
}
