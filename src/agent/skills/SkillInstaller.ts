import { randomUUID } from "crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "fs/promises";
import { dirname, join, relative, resolve, sep } from "path";

import { GithubSkillSource } from "@/agent/skills/GithubSkillSource";
import type { ParsedSkillBundle, SkillBundleFile } from "@/agent/skills/SkillManifest";
import {
  skillRepository,
  type SkillInstallProposal,
  type StoredSkill,
} from "@/agent/skills/SkillRepository";
import { normalizeBundlePath, validateSkillBundle } from "@/agent/skills/SkillBundleValidator";
import {
  activeSkillsRoot,
  ensureSkillStorageForUser,
  normalizeSkillSlug,
  skillQuarantineRoot,
  skillVersionsRoot,
} from "@/agent/skills/SkillPaths";

function assertInside(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Refusing to write outside skill directory: ${target}`);
  }
  return resolvedTarget;
}

async function writeBundleFiles(root: string, bundle: ParsedSkillBundle): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of bundle.files) {
    const target = assertInside(root, join(root, file.path));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.content, { flag: "wx", mode: 0o600 });
  }
}

async function readInstalledSkillName(installDir: string): Promise<string> {
  const raw = await readFile(join(installDir, "SKILL.md"), "utf8");
  const match = /^name:\s*['"]?([^'"\n]+)['"]?/m.exec(raw);
  return match?.[1]?.trim() || "";
}

function renderAgentSkillContent(input: {
  content: string;
  description?: string;
  name: string;
}): string {
  const content = input.content.trim();
  if (content.startsWith("---") && /\n---\s*(\r?\n|$)/.test(content)) {
    return `${content}\n`;
  }

  const description = (input.description ?? "").trim() || `Agent-created skill for ${input.name}.`;
  return `---
name: ${normalizeSkillSlug(input.name)}
description: ${description.replace(/\r?\n/g, " ").slice(0, 240)}
---

${content}
`;
}

function assertSupportFilePath(rawPath: string): string {
  const filePath = normalizeBundlePath(rawPath);
  if (filePath === "SKILL.md") {
    throw new Error("Use action='edit' or action='patch' to modify SKILL.md.");
  }
  const allowed = ["assets/", "references/", "scripts/", "templates/"];
  if (!allowed.some((prefix) => filePath.startsWith(prefix))) {
    throw new Error(
      "Support files must live under references/, templates/, scripts/, or assets/.",
    );
  }
  return filePath;
}

async function readBundleFiles(root: string): Promise<SkillBundleFile[]> {
  const files: SkillBundleFile[] = [];
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
        files.push({
          content: await readFile(path),
          path: relative(root, path).replace(/\\/g, "/"),
        });
      }
    }
  };
  await visit(root);
  return files;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function replaceFile(files: SkillBundleFile[], filePath: string, content: Buffer): SkillBundleFile[] {
  const next = files.filter((file) => file.path !== filePath);
  next.push({ content, path: filePath });
  return next.sort((a, b) => a.path.localeCompare(b.path));
}

function patchFileContent(content: Buffer, filePath: string, oldString: string, newString: string): Buffer {
  if (!oldString) {
    throw new Error("old_string is required for patch.");
  }
  const text = content.toString("utf8");
  const first = text.indexOf(oldString);
  if (first === -1) {
    throw new Error(`old_string was not found in ${filePath}.`);
  }
  if (text.indexOf(oldString, first + oldString.length) !== -1) {
    throw new Error(`old_string appears more than once in ${filePath}; use a more specific patch.`);
  }
  return Buffer.from(text.replace(oldString, newString), "utf8");
}

export class SkillInstaller {
  constructor(
    private readonly github = new GithubSkillSource(),
    private readonly repository = skillRepository,
  ) {}

  async proposeGithubInstall(input: {
    runId?: string;
    source: string;
    userId: string;
    signal?: AbortSignal;
  }): Promise<SkillInstallProposal> {
    ensureSkillStorageForUser(input.userId);
    const location = await this.github.resolve(input.source, input.signal);
    const rawBundle = await this.github.fetchBundle(location, input.signal);
    const validation = validateSkillBundle(rawBundle);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    const slug = normalizeSkillSlug(validation.bundle.manifest.name);
    const nonce = randomUUID();
    const quarantineDir = join(skillQuarantineRoot(input.userId), `${slug}-${nonce}`);
    const installDir = join(
      skillVersionsRoot(input.userId),
      slug,
      `${location.commitSha.slice(0, 12)}-${validation.bundle.contentHash.slice(0, 12)}`,
    );

    await rm(quarantineDir, { force: true, recursive: true });
    await rm(installDir, { force: true, recursive: true });
    await writeBundleFiles(quarantineDir, validation.bundle);
    await writeBundleFiles(installDir, validation.bundle);

    return this.repository.createQuarantinedSkill({
      bundle: validation.bundle,
      installDir,
      quarantineDir,
      runId: input.runId,
      slug,
      userId: input.userId,
      warnings: validation.warnings,
    });
  }

  async activate(input: {
    runId?: string;
    skillId: string;
    userId: string;
  }): Promise<StoredSkill> {
    ensureSkillStorageForUser(input.userId);
    const skill = await this.repository.getSkill({
      skillId: input.skillId,
      userId: input.userId,
    });
    if (!skill) {
      throw new Error("Skill install proposal was not found.");
    }
    if (!skill.installDir) {
      throw new Error("Skill install proposal is missing an install directory.");
    }

    const activeRoot = activeSkillsRoot(input.userId);
    const activeDir = join(activeRoot, skill.slug);
    const tempDir = join(activeRoot, `.tmp-${skill.slug}-${randomUUID()}`);
    const backupDir = join(activeRoot, `.old-${skill.slug}-${randomUUID()}`);
    const installedName = await readInstalledSkillName(skill.installDir);
    if (installedName && installedName !== skill.name) {
      throw new Error("Skill manifest changed between proposal and activation.");
    }

    await rm(tempDir, { force: true, recursive: true });
    await mkdir(dirname(tempDir), { recursive: true, mode: 0o700 });
    await copyDirectory(skill.installDir, tempDir);

    await rm(backupDir, { force: true, recursive: true });
    try {
      await renameIfExists(activeDir, backupDir);
      await renameDirectory(tempDir, activeDir);
      await rm(backupDir, { force: true, recursive: true });
    } catch (error) {
      await rm(activeDir, { force: true, recursive: true });
      await renameIfExists(backupDir, activeDir);
      await rm(tempDir, { force: true, recursive: true });
      throw error;
    }

    const activated = await this.repository.activateSkill({
      installDir: activeDir,
      runId: input.runId,
      skillId: input.skillId,
      userId: input.userId,
    });
    if (!activated) {
      throw new Error("Skill install proposal could not be activated.");
    }
    return activated;
  }

  async setEnabled(input: {
    enabled: boolean;
    runId?: string;
    skillId: string;
    userId: string;
  }): Promise<StoredSkill> {
    const updated = await this.repository.setSkillEnabled(input);
    if (!updated) {
      throw new Error("Skill was not found or cannot be enabled/disabled.");
    }
    return updated;
  }

  async uninstall(input: {
    runId?: string;
    skillId: string;
    userId: string;
  }): Promise<StoredSkill> {
    const skill = await this.repository.getSkill({
      skillId: input.skillId,
      userId: input.userId,
    });
    if (!skill) {
      throw new Error("Skill was not found.");
    }
    await rm(join(activeSkillsRoot(input.userId), skill.slug), { force: true, recursive: true });
    const updated = await this.repository.markUninstalled(input);
    if (!updated) {
      throw new Error("Skill could not be uninstalled.");
    }
    return updated;
  }

  async createAgentSkill(input: {
    content: string;
    description?: string;
    name: string;
    runId?: string;
    userId: string;
  }): Promise<StoredSkill> {
    ensureSkillStorageForUser(input.userId);
    const slug = normalizeSkillSlug(input.name);
    if (await directoryExists(join(activeSkillsRoot(input.userId), slug))) {
      throw new Error("Skill already exists. Use action='edit' or action='patch'.");
    }

    return this.saveAgentBundle({
      files: [
        {
          content: Buffer.from(
            renderAgentSkillContent({
              content: input.content,
              description: input.description,
              name: input.name,
            }),
            "utf8",
          ),
          path: "SKILL.md",
        },
      ],
      identifier: `agent:${slug}`,
      operation: "create",
      runId: input.runId,
      slug,
      userId: input.userId,
    });
  }

  async editAgentSkill(input: {
    content: string;
    name: string;
    runId?: string;
    userId: string;
  }): Promise<StoredSkill> {
    ensureSkillStorageForUser(input.userId);
    const skill = await this.requireActiveSkill(input);
    const files = await readBundleFiles(join(activeSkillsRoot(input.userId), skill.slug));

    return this.saveAgentBundle({
      files: replaceFile(files, "SKILL.md", Buffer.from(`${input.content.trim()}\n`, "utf8")),
      identifier: `agent:${skill.slug}`,
      operation: "edit",
      runId: input.runId,
      slug: skill.slug,
      userId: input.userId,
    });
  }

  async patchAgentSkill(input: {
    filePath?: string;
    name: string;
    newString: string;
    oldString: string;
    runId?: string;
    userId: string;
  }): Promise<StoredSkill> {
    ensureSkillStorageForUser(input.userId);
    const skill = await this.requireActiveSkill(input);
    const filePath = input.filePath ? normalizeBundlePath(input.filePath) : "SKILL.md";
    const files = await readBundleFiles(join(activeSkillsRoot(input.userId), skill.slug));
    const target = files.find((file) => file.path === filePath);
    if (!target) {
      throw new Error(`Skill file '${filePath}' was not found.`);
    }

    return this.saveAgentBundle({
      files: replaceFile(
        files,
        filePath,
        patchFileContent(target.content, filePath, input.oldString, input.newString),
      ),
      identifier: `agent:${skill.slug}`,
      operation: "patch",
      runId: input.runId,
      slug: skill.slug,
      userId: input.userId,
    });
  }

  async writeAgentSkillFile(input: {
    content: string;
    filePath: string;
    name: string;
    runId?: string;
    userId: string;
  }): Promise<StoredSkill> {
    ensureSkillStorageForUser(input.userId);
    const skill = await this.requireActiveSkill(input);
    const filePath = assertSupportFilePath(input.filePath);
    const files = await readBundleFiles(join(activeSkillsRoot(input.userId), skill.slug));

    return this.saveAgentBundle({
      files: replaceFile(files, filePath, Buffer.from(input.content, "utf8")),
      identifier: `agent:${skill.slug}`,
      operation: "write_file",
      runId: input.runId,
      slug: skill.slug,
      userId: input.userId,
    });
  }

  async removeAgentSkillFile(input: {
    filePath: string;
    name: string;
    runId?: string;
    userId: string;
  }): Promise<StoredSkill> {
    ensureSkillStorageForUser(input.userId);
    const skill = await this.requireActiveSkill(input);
    const filePath = assertSupportFilePath(input.filePath);
    const currentFiles = await readBundleFiles(join(activeSkillsRoot(input.userId), skill.slug));
    if (!currentFiles.some((file) => file.path === filePath)) {
      throw new Error(`Skill support file '${filePath}' was not found.`);
    }
    const files = currentFiles.filter((file) => file.path !== filePath);

    return this.saveAgentBundle({
      files,
      identifier: `agent:${skill.slug}`,
      operation: "remove_file",
      runId: input.runId,
      slug: skill.slug,
      userId: input.userId,
    });
  }

  private async requireActiveSkill(input: { name: string; userId: string }): Promise<StoredSkill> {
    const skill = await this.repository.getSkillByName({
      name: input.name,
      userId: input.userId,
    });
    if (!skill) {
      throw new Error("Skill was not found. Use action='create' for a new skill.");
    }
    return skill;
  }

  private async saveAgentBundle(input: {
    files: SkillBundleFile[];
    identifier: string;
    operation: "create" | "edit" | "patch" | "remove_file" | "write_file";
    runId?: string;
    slug: string;
    userId: string;
  }): Promise<StoredSkill> {
    const validation = validateSkillBundle({
      files: input.files,
      identifier: input.identifier,
      metadata: {
        name: input.slug,
        operation: input.operation,
      },
      source: "agent",
      trustLevel: "community",
    });
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    const skillSlug = normalizeSkillSlug(validation.bundle.manifest.name || input.slug);
    if (input.operation !== "create" && skillSlug !== input.slug) {
      throw new Error("Editing an existing skill cannot change its name/slug.");
    }
    const versionDir = join(
      skillVersionsRoot(input.userId),
      skillSlug,
      `agent-${validation.bundle.contentHash.slice(0, 12)}-${randomUUID()}`,
    );
    const activeDir = join(activeSkillsRoot(input.userId), skillSlug);
    const tempDir = join(activeSkillsRoot(input.userId), `.tmp-${skillSlug}-${randomUUID()}`);
    const backupDir = join(activeSkillsRoot(input.userId), `.old-${skillSlug}-${randomUUID()}`);

    await rm(versionDir, { force: true, recursive: true });
    await rm(tempDir, { force: true, recursive: true });
    await writeBundleFiles(versionDir, validation.bundle);
    await writeBundleFiles(tempDir, validation.bundle);

    try {
      await renameIfExists(activeDir, backupDir);
      await renameDirectory(tempDir, activeDir);
      await rm(backupDir, { force: true, recursive: true });
    } catch (error) {
      await rm(activeDir, { force: true, recursive: true });
      await renameIfExists(backupDir, activeDir);
      await rm(tempDir, { force: true, recursive: true });
      throw error;
    }

    return this.repository.saveAgentManagedSkill({
      bundle: validation.bundle,
      installDir: versionDir,
      operation: input.operation,
      runId: input.runId,
      slug: skillSlug,
      userId: input.userId,
    });
  }
}

async function copyDirectory(source: string, target: string): Promise<void> {
  const { cp } = await import("fs/promises");
  await cp(source, target, {
    dereference: false,
    errorOnExist: true,
    force: false,
    recursive: true,
  });
}

async function renameDirectory(source: string, target: string): Promise<void> {
  const { rename } = await import("fs/promises");
  await rename(source, target);
}

async function renameIfExists(source: string, target: string): Promise<void> {
  const { rename } = await import("fs/promises");
  try {
    await rename(source, target);
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      (error as { code?: unknown }).code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

export const skillInstaller = new SkillInstaller();
