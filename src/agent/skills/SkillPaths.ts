import { mkdirSync } from "fs";
import { join, resolve } from "path";

import { serverEnv } from "@/lib/env";

const FALLBACK_SKILL_STORAGE_DIR = ".my-agent/skills";

function safeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "default";
}

export function skillStorageRoot(): string {
  return resolve(serverEnv.SKILL_STORAGE_DIR ?? join(process.cwd(), FALLBACK_SKILL_STORAGE_DIR));
}

export function userSkillRoot(userId: string): string {
  return join(skillStorageRoot(), serverEnv.APP_ENV, safeSegment(userId));
}

export function activeSkillsRoot(userId: string): string {
  return join(userSkillRoot(userId), "active");
}

export function skillVersionsRoot(userId: string): string {
  return join(userSkillRoot(userId), "versions");
}

export function skillQuarantineRoot(userId: string): string {
  return join(userSkillRoot(userId), ".hub", "quarantine");
}

export function ensureSkillStorageForUser(userId: string): void {
  mkdirSync(activeSkillsRoot(userId), { recursive: true, mode: 0o700 });
  mkdirSync(skillVersionsRoot(userId), { recursive: true, mode: 0o700 });
  mkdirSync(skillQuarantineRoot(userId), { recursive: true, mode: 0o700 });
}

export function normalizeSkillSlug(value: string): string {
  return safeSegment(value)
    .replace(/[._]+$/g, "")
    .replace(/^[._]+/g, "")
    .slice(0, 80) || "skill";
}
