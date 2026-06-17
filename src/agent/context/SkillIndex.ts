import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

type SkillFrontmatter = {
  description?: string;
  name?: string;
  platforms?: string[];
};

export type SkillIndexEntry = {
  category: string;
  description: string;
  name: string;
  path: string;
};

export type SkillIndex = {
  entries: SkillIndexEntry[];
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

function parseScalar(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function parseInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return trimmed ? [parseScalar(trimmed)] : [];
  }

  return trimmed
    .slice(1, -1)
    .split(",")
    .map(parseScalar)
    .filter(Boolean);
}

function parseFrontmatter(raw: string): SkillFrontmatter {
  if (!raw.startsWith("---")) {
    return {};
  }

  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    return {};
  }

  const frontmatter: SkillFrontmatter = {};
  const body = raw.slice(3, end).split(/\r?\n/);

  for (const line of body) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const [, key, value] = match;
    if (key === "name") {
      frontmatter.name = parseScalar(value);
    }
    if (key === "description") {
      frontmatter.description = parseScalar(value);
    }
    if (key === "platforms") {
      frontmatter.platforms = parseInlineList(value);
    }
  }

  return frontmatter;
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

function buildEntry(skillFile: string, root: string): SkillIndexEntry | null {
  try {
    const raw = readFileSync(skillFile, "utf8");
    const frontmatter = parseFrontmatter(raw);
    if (!isPlatformCompatible(frontmatter.platforms)) {
      return null;
    }

    const rel = relative(root, skillFile);
    const parts = rel.split(/[\\/]/);
    const skillDirectoryName = parts.length >= 2 ? parts[parts.length - 2] : "general";
    const category = parts.length > 2 ? parts.slice(0, -2).join("/") : parts[0] || "general";

    return {
      category,
      description: frontmatter.description ?? "",
      name: frontmatter.name || skillDirectoryName,
      path: rel,
    };
  } catch {
    return null;
  }
}

export function buildSkillIndex(cwd = process.cwd()): SkillIndex {
  const roots = [join(cwd, "skills"), join(cwd, "rules", "skills")]
    .map((root) => resolve(root))
    .filter((root) => directoryExists(root));

  const entriesByName = new Map<string, SkillIndexEntry>();

  for (const root of roots) {
    for (const skillFile of walkSkillFiles(root)) {
      const entry = buildEntry(skillFile, root);
      if (entry && !entriesByName.has(entry.name)) {
        entriesByName.set(entry.name, entry);
      }
    }
  }

  return {
    entries: [...entriesByName.values()].sort((a, b) => {
      const categoryCompare = a.category.localeCompare(b.category);
      return categoryCompare === 0 ? a.name.localeCompare(b.name) : categoryCompare;
    }),
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
      lines.push(`    - ${entry.name}${suffix} (${entry.path})`);
    }
  }

  return lines.join("\n");
}
