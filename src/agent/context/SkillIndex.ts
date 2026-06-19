import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

import { parseSkillManifest } from "@/agent/skills/SkillManifest";
import { activeSkillsRoot } from "@/agent/skills/SkillPaths";

export type SkillIndexEntry = {
  category: string;
  description: string;
  name: string;
  path: string;
  source: "workspace" | "user-installed";
  whenToUse?: string;
};

export type SkillIndex = {
  entries: SkillIndexEntry[];
  hash: string;
  roots: string[];
};

function directoryExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function walkSkillFiles(root: string): string[] {
  if (!directoryExists(root)) {
    return [];
  }

  const result: string[] = [];
  const visit = (directory: string) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        result.push(path);
      }
    }
  };

  visit(root);
  return result;
}

function isPlatformCompatible(platforms: string[] | undefined): boolean {
  if (!platforms || platforms.length === 0) {
    return true;
  }

  const nodePlatform = process.platform;
  const aliases = new Set([
    nodePlatform,
    nodePlatform === "darwin" ? "macos" : "",
    nodePlatform === "win32" ? "windows" : "",
    nodePlatform === "linux" ? "linux" : "",
  ]);

  return platforms.some((platform) => aliases.has(platform.toLowerCase()));
}

function buildEntry(
  skillFile: string,
  root: string,
  source: SkillIndexEntry["source"],
): SkillIndexEntry | null {
  try {
    const raw = readFileSync(skillFile, "utf8");
    const rel = relative(root, skillFile);
    const parts = rel.split(/[\\/]/);
    const skillDirectoryName = parts.length >= 2 ? parts[parts.length - 2] : "general";
    const category =
      source === "user-installed" ? "installed"
      : parts.length > 2 ? parts.slice(0, -2).join("/")
      : parts[0] || "general";
    const manifest = parseSkillManifest(raw, skillDirectoryName);
    if (!isPlatformCompatible(manifest.platforms)) {
      return null;
    }

    return {
      category,
      description: manifest.description,
      name: manifest.name || skillDirectoryName,
      path: rel,
      source,
      whenToUse: manifest.whenToUse,
    };
  } catch {
    return null;
  }
}

function indexHash(entries: SkillIndexEntry[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        entries.map((entry) => ({
          category: entry.category,
          description: entry.description,
          name: entry.name,
          path: entry.path,
          source: entry.source,
          whenToUse: entry.whenToUse,
        })),
      ),
    )
    .digest("hex");
}

export function buildSkillIndex(
  cwd = process.cwd(),
  input: { userId?: string } = {},
): SkillIndex {
  const workspaceRoots = [join(cwd, "skills"), join(cwd, "rules", "skills")]
    .map((root) => resolve(root))
    .filter((root) => directoryExists(root));
  const installedRoots =
    input.userId && directoryExists(activeSkillsRoot(input.userId)) ?
      [activeSkillsRoot(input.userId)]
    : [];
  const roots = [...workspaceRoots, ...installedRoots];

  const entriesByName = new Map<string, SkillIndexEntry>();

  for (const root of workspaceRoots) {
    for (const skillFile of walkSkillFiles(root)) {
      const entry = buildEntry(skillFile, root, "workspace");
      if (entry && !entriesByName.has(entry.name)) {
        entriesByName.set(entry.name, entry);
      }
    }
  }

  for (const root of installedRoots) {
    for (const skillFile of walkSkillFiles(root)) {
      const entry = buildEntry(skillFile, root, "user-installed");
      if (entry) {
        entriesByName.set(entry.name, entry);
      }
    }
  }

  const entries = [...entriesByName.values()].sort((a, b) => {
    const categoryCompare = a.category.localeCompare(b.category);
    return categoryCompare === 0 ? a.name.localeCompare(b.name) : categoryCompare;
  });

  return {
    entries,
    hash: indexHash(entries),
    roots,
  };
}

export function renderSkillIndex(index: SkillIndex): string {
  if (index.entries.length === 0) {
    const searched = index.roots.length > 0 ? index.roots.join(", ") : "./skills, ./rules/skills";
    return `No skills are currently indexed. Searched: ${searched}.`;
  }

  const grouped = new Map<string, SkillIndexEntry[]>();
  for (const entry of index.entries) {
    const existing = grouped.get(entry.category) ?? [];
    existing.push(entry);
    grouped.set(entry.category, existing);
  }

  const lines: string[] = [];
  for (const [category, entries] of grouped) {
    lines.push(`  ${category}:`);
    for (const entry of entries) {
      const suffix = entry.description ? `: ${entry.description}` : "";
      const whenToUse = entry.whenToUse ? ` Trigger: ${entry.whenToUse}` : "";
      lines.push(`    - ${entry.name}${suffix}${whenToUse} [${entry.source}] (${entry.path})`);
    }
  }

  return lines.join("\n");
}
