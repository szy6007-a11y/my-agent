import { createHash, randomUUID } from "crypto";
import type postgres from "postgres";

import type { ParsedSkillBundle, SkillBundleFile } from "@/agent/skills/SkillManifest";
import { getSql } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { assertDatabaseMigrated } from "@/server/db/readiness";

export type SkillInstallStatus = "quarantined" | "active" | "disabled" | "uninstalled";

export type StoredSkill = {
  id: string;
  activeVersionId: string | null;
  commitSha: string;
  description: string;
  enabled: boolean;
  installDir: string | null;
  lastUsedAt: string | null;
  name: string;
  slug: string;
  sourceType: string;
  sourceUrl: string;
  status: SkillInstallStatus;
  trustLevel: string;
  updatedAt: string;
};

export type SkillInstallProposal = StoredSkill & {
  fileCount: number;
  manifest: unknown;
  warnings: string[];
};

type SkillRow = {
  active_version_id: string | null;
  commit_sha: string;
  created_at: Date;
  description: string;
  enabled: boolean;
  id: string;
  install_dir: string | null;
  last_used_at: Date | null;
  metadata_json: unknown;
  name: string;
  slug: string;
  source_url: string;
  source_type: string;
  status: string;
  trust_level: string;
  updated_at: Date;
};

type SkillProposalRow = SkillRow & {
  file_count: number;
  manifest_json: unknown;
};

async function ready() {
  await assertDatabaseMigrated();
}

function toJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function toStoredSkill(row: SkillRow): StoredSkill {
  return {
    activeVersionId: row.active_version_id,
    commitSha: row.commit_sha,
    description: row.description,
    enabled: row.enabled,
    id: row.id,
    installDir: row.install_dir,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    name: row.name,
    slug: row.slug,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    status:
      row.status === "active" ||
      row.status === "disabled" ||
      row.status === "uninstalled" ||
      row.status === "quarantined" ?
        row.status
      : "disabled",
    trustLevel: row.trust_level,
    updatedAt: row.updated_at.toISOString(),
  };
}

function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function mimeForSkillFile(file: SkillBundleFile): string {
  return file.path.endsWith(".md") ? "text/markdown" : "application/octet-stream";
}

function skillFileRecords(files: SkillBundleFile[], installDir: string) {
  return files.map((file) => ({
    kind: file.path === "SKILL.md" ? "entrypoint" : "support",
    mime: mimeForSkillFile(file),
    path: file.path,
    sha256: hashBuffer(file.content),
    size_bytes: file.content.length,
    storage_path: `${installDir}/${file.path}`,
  }));
}

export class SkillRepository {
  async createQuarantinedSkill(input: {
    bundle: ParsedSkillBundle;
    installDir: string;
    quarantineDir: string;
    runId?: string;
    slug: string;
    userId: string;
    warnings: string[];
  }): Promise<SkillInstallProposal> {
    await ready();
    const db = getSql();
    const skillId = `skill_${randomUUID()}`;
    const versionId = `skillver_${randomUUID()}`;
    const metadata = input.bundle.metadata;
    const sourceUrl = String(metadata.sourceUrl ?? input.bundle.identifier);
    const owner = String(metadata.owner ?? "");
    const repo = String(metadata.repo ?? "");
    const path = String(metadata.path ?? "");
    const ref = String(metadata.ref ?? "");
    const commitSha = String(metadata.commitSha ?? "");

    const row = await db.begin(async (tx) => {
      await tx`
        insert into installed_skills (
          id,
          environment,
          user_id,
          scope,
          name,
          slug,
          description,
          source_type,
          source_url,
          github_owner,
          github_repo,
          github_path,
          requested_ref,
          commit_sha,
          trust_level,
          status,
          enabled,
          metadata_json
        )
        values (
          ${skillId},
          ${serverEnv.APP_ENV},
          ${input.userId},
          'user',
          ${input.bundle.manifest.name},
          ${input.slug},
          ${input.bundle.manifest.description},
          'github',
          ${sourceUrl},
          ${owner},
          ${repo},
          ${path},
          ${ref},
          ${commitSha},
          ${input.bundle.trustLevel},
          'quarantined',
          false,
          ${db.json(toJson({
            identifier: input.bundle.identifier,
            quarantineDir: input.quarantineDir,
            warnings: input.warnings,
          }))}
        )
      `;

      await tx`
        insert into skill_versions (
          id,
          skill_id,
          version_number,
          commit_sha,
          content_hash,
          install_dir,
          manifest_json,
          frontmatter_json,
          metadata_json
        )
        values (
          ${versionId},
          ${skillId},
          1,
          ${commitSha},
          ${input.bundle.contentHash},
          ${input.installDir},
          ${db.json(toJson(input.bundle.manifest))},
          ${db.json(toJson(input.bundle.manifest.frontmatter))},
          ${db.json(toJson(metadata))}
        )
      `;

      await tx`
        insert into skill_files (
          version_id,
          path,
          kind,
          size_bytes,
          sha256,
          mime,
          storage_path
        )
        select
          ${versionId},
          file_record.path,
          file_record.kind,
          file_record.size_bytes,
          file_record.sha256,
          file_record.mime,
          file_record.storage_path
        from jsonb_to_recordset(${db.json(
          toJson(skillFileRecords(input.bundle.files, input.installDir)),
        )}::jsonb) as file_record(
          path text,
          kind text,
          size_bytes integer,
          sha256 text,
          mime text,
          storage_path text
        )
      `;

      await tx`
        update installed_skills
        set active_version_id = ${versionId}, updated_at = now()
        where id = ${skillId}
      `;

      await tx`
        insert into skill_audit_events (
          environment,
          user_id,
          skill_id,
          run_id,
          event_type,
          payload_json
        )
        values (
          ${serverEnv.APP_ENV},
          ${input.userId},
          ${skillId},
          ${input.runId ?? null},
          'skill.install.proposed',
          ${db.json(toJson({
            commitSha,
            files: input.bundle.files.map((file) => file.path),
            sourceUrl,
            warnings: input.warnings,
          }))}
        )
      `;

      const rows = await tx<SkillProposalRow[]>`
        select
          s.*,
          v.install_dir,
          (select count(*)::int from skill_files where version_id = ${versionId}) as file_count,
          v.manifest_json
        from installed_skills s
        join skill_versions v on v.id = ${versionId}
        where s.id = ${skillId}
        limit 1
      `;
      return rows[0] ?? null;
    });

    if (!row) {
      throw new Error("Skill proposal could not be recorded.");
    }

    return {
      ...toStoredSkill(row),
      fileCount: row.file_count,
      manifest: row.manifest_json,
      warnings: input.warnings,
    };
  }

  async saveAgentManagedSkill(input: {
    bundle: ParsedSkillBundle;
    installDir: string;
    operation: "create" | "edit" | "patch" | "remove_file" | "write_file";
    runId?: string;
    slug: string;
    userId: string;
  }): Promise<StoredSkill> {
    await ready();
    const db = getSql();
    const versionId = `skillver_${randomUUID()}`;
    const metadata = {
      ...input.bundle.metadata,
      files: input.bundle.files.map((file) => file.path),
      identifier: input.bundle.identifier,
      operation: input.operation,
      source: "agent",
    };
    const sourceUrl = `agent://skills/${input.slug}`;
    const commitSha = input.bundle.contentHash;

    const row = await db.begin(async (tx) => {
      const existingRows = await tx<SkillRow[]>`
        select s.*, v.install_dir
        from installed_skills s
        left join skill_versions v on v.id = s.active_version_id
        where s.user_id = ${input.userId}
          and s.environment = ${serverEnv.APP_ENV}
          and s.slug = ${input.slug}
          and s.status <> 'uninstalled'
        order by s.updated_at desc
        limit 1
      `;
      const existing = existingRows[0] ?? null;
      const skillId = existing?.id ?? `skill_${randomUUID()}`;
      const versionRows = existing ?
        await tx<{ next_version: number }[]>`
          select (coalesce(max(version_number), 0) + 1)::int as next_version
          from skill_versions
          where skill_id = ${skillId}
        `
      : [{ next_version: 1 }];
      const versionNumber = versionRows[0]?.next_version ?? 1;

      if (existing) {
        await tx`
          update installed_skills
          set
            name = ${input.bundle.manifest.name},
            slug = ${input.slug},
            description = ${input.bundle.manifest.description},
            source_type = 'agent',
            source_url = ${sourceUrl},
            commit_sha = ${commitSha},
            trust_level = 'community',
            status = 'active',
            enabled = true,
            metadata_json = ${db.json(toJson(metadata))},
            updated_at = now()
          where id = ${skillId}
            and user_id = ${input.userId}
            and environment = ${serverEnv.APP_ENV}
        `;
      } else {
        await tx`
          insert into installed_skills (
            id,
            environment,
            user_id,
            scope,
            name,
            slug,
            description,
            source_type,
            source_url,
            commit_sha,
            trust_level,
            status,
            enabled,
            metadata_json
          )
          values (
            ${skillId},
            ${serverEnv.APP_ENV},
            ${input.userId},
            'user',
            ${input.bundle.manifest.name},
            ${input.slug},
            ${input.bundle.manifest.description},
            'agent',
            ${sourceUrl},
            ${commitSha},
            'community',
            'active',
            true,
            ${db.json(toJson(metadata))}
          )
        `;
      }

      await tx`
        insert into skill_versions (
          id,
          skill_id,
          version_number,
          commit_sha,
          content_hash,
          install_dir,
          manifest_json,
          frontmatter_json,
          metadata_json
        )
        values (
          ${versionId},
          ${skillId},
          ${versionNumber},
          ${commitSha},
          ${input.bundle.contentHash},
          ${input.installDir},
          ${db.json(toJson(input.bundle.manifest))},
          ${db.json(toJson(input.bundle.manifest.frontmatter))},
          ${db.json(toJson(metadata))}
        )
      `;

      await tx`
        insert into skill_files (
          version_id,
          path,
          kind,
          size_bytes,
          sha256,
          mime,
          storage_path
        )
        select
          ${versionId},
          file_record.path,
          file_record.kind,
          file_record.size_bytes,
          file_record.sha256,
          file_record.mime,
          file_record.storage_path
        from jsonb_to_recordset(${db.json(
          toJson(skillFileRecords(input.bundle.files, input.installDir)),
        )}::jsonb) as file_record(
          path text,
          kind text,
          size_bytes integer,
          sha256 text,
          mime text,
          storage_path text
        )
      `;

      await tx`
        update installed_skills
        set active_version_id = ${versionId}, updated_at = now()
        where id = ${skillId}
          and user_id = ${input.userId}
          and environment = ${serverEnv.APP_ENV}
      `;

      await tx`
        insert into skill_audit_events (
          environment,
          user_id,
          skill_id,
          run_id,
          event_type,
          payload_json
        )
        values (
          ${serverEnv.APP_ENV},
          ${input.userId},
          ${skillId},
          ${input.runId ?? null},
          ${`skill.agent.${input.operation}`},
          ${db.json(toJson({
            commitSha,
            files: input.bundle.files.map((file) => file.path),
            sourceUrl,
          }))}
        )
      `;

      const rows = await tx<SkillRow[]>`
        select s.*, v.install_dir
        from installed_skills s
        left join skill_versions v on v.id = s.active_version_id
        where s.id = ${skillId}
        limit 1
      `;
      return rows[0] ?? null;
    });

    if (!row) {
      throw new Error("Agent-managed skill could not be saved.");
    }

    return toStoredSkill(row);
  }

  async activateSkill(input: {
    installDir: string;
    runId?: string;
    skillId: string;
    userId: string;
  }): Promise<StoredSkill | null> {
    await ready();
    const db = getSql();
    const rows = await db<SkillRow[]>`
      update installed_skills
      set
        status = 'active',
        enabled = true,
        updated_at = now()
      where id = ${input.skillId}
        and user_id = ${input.userId}
        and environment = ${serverEnv.APP_ENV}
        and status in ('quarantined', 'disabled', 'active')
      returning *
    `;

    if (!rows[0]) {
      return null;
    }

    await this.audit({
      eventType: "skill.install.activated",
      payload: { installDir: input.installDir },
      runId: input.runId,
      skillId: input.skillId,
      userId: input.userId,
    });

    return this.getSkill({
      skillId: input.skillId,
      userId: input.userId,
    });
  }

  async getSkill(input: { skillId: string; userId: string }): Promise<StoredSkill | null> {
    await ready();
    const db = getSql();
    const rows = await db<SkillRow[]>`
      select s.*, v.install_dir
      from installed_skills s
      left join skill_versions v on v.id = s.active_version_id
      where s.id = ${input.skillId}
        and s.user_id = ${input.userId}
        and s.environment = ${serverEnv.APP_ENV}
      limit 1
    `;

    return rows[0] ? toStoredSkill(rows[0]) : null;
  }

  async getSkillByName(input: { name: string; userId: string }): Promise<StoredSkill | null> {
    await ready();
    const db = getSql();
    const key = input.name.trim().toLowerCase();
    const rows = await db<SkillRow[]>`
      select s.*, v.install_dir
      from installed_skills s
      left join skill_versions v on v.id = s.active_version_id
      where s.user_id = ${input.userId}
        and s.environment = ${serverEnv.APP_ENV}
        and s.status = 'active'
        and s.enabled = true
        and (lower(s.name) = ${key} or s.slug = ${key})
      order by s.updated_at desc
      limit 1
    `;

    return rows[0] ? toStoredSkill(rows[0]) : null;
  }

  async listActiveSkills(userId: string): Promise<StoredSkill[]> {
    await ready();
    const db = getSql();
    const rows = await db<SkillRow[]>`
      select s.*, v.install_dir
      from installed_skills s
      left join skill_versions v on v.id = s.active_version_id
      where s.user_id = ${userId}
        and s.environment = ${serverEnv.APP_ENV}
        and s.status in ('active', 'disabled', 'quarantined')
      order by s.updated_at desc
      limit 200
    `;

    return rows.map(toStoredSkill);
  }

  async markUsed(input: {
    runId?: string;
    skillId: string;
    userId: string;
  }): Promise<void> {
    await ready();
    const db = getSql();
    await db`
      update installed_skills
      set last_used_at = now(), updated_at = now()
      where id = ${input.skillId}
        and user_id = ${input.userId}
        and environment = ${serverEnv.APP_ENV}
    `;
    await this.audit({
      eventType: "skill.runtime.invoked",
      payload: {},
      runId: input.runId,
      skillId: input.skillId,
      userId: input.userId,
    });
  }

  async setSkillEnabled(input: {
    enabled: boolean;
    runId?: string;
    skillId: string;
    userId: string;
  }): Promise<StoredSkill | null> {
    await ready();
    const db = getSql();
    const rows = await db<SkillRow[]>`
      update installed_skills
      set
        enabled = ${input.enabled},
        status = case when ${input.enabled} then 'active' else 'disabled' end,
        updated_at = now()
      where id = ${input.skillId}
        and user_id = ${input.userId}
        and environment = ${serverEnv.APP_ENV}
        and status in ('active', 'disabled')
      returning *
    `;

    if (!rows[0]) {
      return null;
    }
    await this.audit({
      eventType: input.enabled ? "skill.enabled" : "skill.disabled",
      payload: {},
      runId: input.runId,
      skillId: input.skillId,
      userId: input.userId,
    });
    return this.getSkill({
      skillId: input.skillId,
      userId: input.userId,
    });
  }

  async markUninstalled(input: {
    runId?: string;
    skillId: string;
    userId: string;
  }): Promise<StoredSkill | null> {
    await ready();
    const db = getSql();
    const rows = await db<SkillRow[]>`
      update installed_skills
      set
        enabled = false,
        status = 'uninstalled',
        updated_at = now()
      where id = ${input.skillId}
        and user_id = ${input.userId}
        and environment = ${serverEnv.APP_ENV}
      returning *
    `;
    if (!rows[0]) {
      return null;
    }
    await this.audit({
      eventType: "skill.uninstalled",
      payload: {},
      runId: input.runId,
      skillId: input.skillId,
      userId: input.userId,
    });
    return this.getSkill({
      skillId: input.skillId,
      userId: input.userId,
    });
  }

  private async audit(input: {
    eventType: string;
    payload: unknown;
    runId?: string;
    skillId: string;
    userId: string;
  }): Promise<void> {
    const db = getSql();
    await db`
      insert into skill_audit_events (
        environment,
        user_id,
        skill_id,
        run_id,
        event_type,
        payload_json
      )
      values (
        ${serverEnv.APP_ENV},
        ${input.userId},
        ${input.skillId},
        ${input.runId ?? null},
        ${input.eventType},
        ${db.json(toJson(input.payload))}
      )
    `;
  }
}

export const skillRepository = new SkillRepository();
