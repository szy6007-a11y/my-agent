import { randomUUID } from "crypto";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join, resolve, sep } from "path";

import { GithubSkillSource } from "@/agent/skills/GithubSkillSource";
import type { ParsedSkillBundle } from "@/agent/skills/SkillManifest";
import {
  skillRepository,
  type SkillInstallProposal,
  type StoredSkill,
} from "@/agent/skills/SkillRepository";
import { validateSkillBundle } from "@/agent/skills/SkillBundleValidator";
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
