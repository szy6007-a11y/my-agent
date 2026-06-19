import { readdir, readFile, stat } from "fs/promises";
import { basename, join, relative, resolve, sep } from "path";

import { parseSkillManifest, type SkillManifest } from "@/agent/skills/SkillManifest";
import { normalizeBundlePath } from "@/agent/skills/SkillBundleValidator";
import { activeSkillsRoot } from "@/agent/skills/SkillPaths";
import { skillRepository } from "@/agent/skills/SkillRepository";

export type RuntimeSkill = {
  description: string;
  manifest: SkillManifest;
  name: string;
  root: string;
  slug: string;
  source: "user-installed" | "workspace";
};

export type LoadedSkill = RuntimeSkill & {
  content: string;
  filePath: string;
  linkedFiles: string[];
};

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function assertInside(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Skill file path escapes skill root: ${target}`);
  }
  return resolvedTarget;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function walk(root: string): Promise<string[]> {
  if (!(await directoryExists(root))) {
    return [];
  }
  const result: string[] = [];
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        result.push(path);
      }
    }
  };
  await visit(root);
  return result;
}

async function loadSkillFromRoot(root: string, source: RuntimeSkill["source"]): Promise<RuntimeSkill | null> {
  try {
    const raw = await readFile(join(root, "SKILL.md"), "utf8");
    const fallbackName = basename(root);
    const manifest = parseSkillManifest(raw, fallbackName);
    return {
      description: manifest.description,
      manifest,
      name: manifest.name,
      root,
      slug: slugify(manifest.name || fallbackName),
      source,
    };
  } catch {
    return null;
  }
}

async function workspaceSkillRoots(cwd: string): Promise<string[]> {
  const roots = [join(cwd, "skills"), join(cwd, "rules", "skills")];
  const skillRoots: string[] = [];

  for (const root of roots) {
    for (const file of await walk(root)) {
      if (basename(file) === "SKILL.md") {
        skillRoots.push(resolve(file, ".."));
      }
    }
  }

  return skillRoots;
}

async function installedSkillRoots(root: string): Promise<string[]> {
  if (!(await directoryExists(root))) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const roots: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      const candidate = join(root, entry.name);
      try {
        const skillFile = await stat(join(candidate, "SKILL.md"));
        if (skillFile.isFile()) {
          roots.push(candidate);
        }
      } catch {
        // Ignore malformed installed skill directories; repository status remains authoritative.
      }
    }
  }
  return roots.sort((a, b) => a.localeCompare(b));
}

export class SkillRuntime {
  async list(input: { cwd?: string; userId: string }): Promise<RuntimeSkill[]> {
    const cwd = resolve(input.cwd ?? process.cwd());
    const roots = [
      ...(await workspaceSkillRoots(cwd)).map((root) => ({
        root,
        source: "workspace" as const,
      })),
      ...(await installedSkillRoots(activeSkillsRoot(input.userId))).map((root) => ({
        root,
        source: "user-installed" as const,
      })),
    ];
    const loaded: RuntimeSkill[] = [];
    const seen = new Set<string>();

    for (const entry of roots) {
      const skill = await loadSkillFromRoot(entry.root, entry.source);
      if (!skill) {
        continue;
      }
      const key = skill.slug || skill.name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      loaded.push(skill);
    }

    return loaded.sort((a, b) => a.name.localeCompare(b.name));
  }

  async load(input: {
    cwd?: string;
    filePath?: string;
    runId?: string;
    skillName: string;
    userId: string;
  }): Promise<LoadedSkill> {
    const skillName = input.skillName.trim();
    if (!skillName) {
      throw new Error("skillName is required.");
    }
    const skills = await this.list({ cwd: input.cwd, userId: input.userId });
    const lookup = slugify(skillName);
    const skill = skills.find(
      (candidate) =>
        slugify(candidate.name) === lookup ||
        candidate.slug === lookup ||
        candidate.name.toLowerCase() === skillName.toLowerCase(),
    );
    if (!skill) {
      throw new Error(`Skill '${skillName}' is not installed or indexed.`);
    }

    const filePath = input.filePath ? normalizeBundlePath(input.filePath) : "SKILL.md";
    const absolutePath = assertInside(skill.root, join(skill.root, filePath));
    const contentBuffer = await readFile(absolutePath);
    if (contentBuffer.includes(0)) {
      throw new Error(`Skill file '${filePath}' is binary and cannot be loaded into context.`);
    }
    const linkedFiles = (await walk(skill.root))
      .map((path) => relative(skill.root, path).replace(/\\/g, "/"))
      .filter((path) => path !== "SKILL.md")
      .sort((a, b) => a.localeCompare(b));

    if (skill.source === "user-installed") {
      const stored = await skillRepository.getSkillByName({
        name: skill.name,
        userId: input.userId,
      });
      if (stored) {
        await skillRepository.markUsed({
          runId: input.runId,
          skillId: stored.id,
          userId: input.userId,
        });
      }
    }

    return {
      ...skill,
      content: contentBuffer.toString("utf8"),
      filePath,
      linkedFiles,
    };
  }
}

export const skillRuntime = new SkillRuntime();
