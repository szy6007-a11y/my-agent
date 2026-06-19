import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  type AnyPgColumn,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    environment: text("environment").notNull(),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("active"),
    parentSessionId: text("parent_session_id").references((): AnyPgColumn => sessions.id, {
      onDelete: "set null",
    }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endReason: text("end_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    promptSnapshotJson: jsonb("prompt_snapshot_json"),
    promptSnapshotCreatedAt: timestamp("prompt_snapshot_created_at", { withTimezone: true }),
  },
  (table) => [
    index("sessions_environment_user_updated_idx").on(
      table.environment,
      table.userId,
      table.updatedAt.desc(),
    ),
    index("sessions_parent_idx").on(table.parentSessionId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    contentJson: jsonb("content_json").notNull(),
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
    tokenCount: integer("token_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("messages_session_created_idx").on(table.sessionId, table.createdAt),
    index("messages_content_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${table.contentJson}->>'text', ''))`,
    ),
  ],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    environment: text("environment").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    status: text("status").notNull(),
    model: text("model").notNull(),
    permissionMode: text("permission_mode").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    errorJson: jsonb("error_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_runs_environment_session_created_idx").on(
      table.environment,
      table.sessionId,
      table.createdAt.desc(),
    ),
  ],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("run_events_run_created_idx").on(table.runId, table.createdAt)],
);

export const toolApprovals = pgTable(
  "tool_approvals",
  {
    id: text("id").primaryKey(),
    environment: text("environment").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    risk: text("risk").notNull(),
    status: text("status").notNull().default("pending"),
    reason: text("reason").notNull(),
    requestJson: jsonb("request_json").notNull(),
    decisionJson: jsonb("decision_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("tool_approvals_environment_user_status_idx").on(
      table.environment,
      table.userId,
      table.status,
      table.createdAt.desc(),
    ),
    index("tool_approvals_run_created_idx").on(table.runId, table.createdAt),
  ],
);

export const installedSkills = pgTable(
  "installed_skills",
  {
    id: text("id").primaryKey(),
    activeVersionId: text("active_version_id"),
    commitSha: text("commit_sha").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    description: text("description").notNull().default(""),
    enabled: boolean("enabled").notNull().default(false),
    environment: text("environment").notNull(),
    githubOwner: text("github_owner").notNull().default(""),
    githubPath: text("github_path").notNull().default(""),
    githubRepo: text("github_repo").notNull().default(""),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    metadataJson: jsonb("metadata_json").notNull().default(sql`'{}'::jsonb`),
    name: text("name").notNull(),
    requestedRef: text("requested_ref").notNull().default(""),
    scope: text("scope").notNull().default("user"),
    slug: text("slug").notNull(),
    sourceType: text("source_type").notNull(),
    sourceUrl: text("source_url").notNull(),
    status: text("status").notNull().default("quarantined"),
    trustLevel: text("trust_level").notNull().default("community"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    index("installed_skills_env_user_status_idx").on(
      table.environment,
      table.userId,
      table.status,
      table.updatedAt.desc(),
    ),
    index("installed_skills_env_user_slug_idx").on(table.environment, table.userId, table.slug),
  ],
);

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: text("id").primaryKey(),
    commitSha: text("commit_sha").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    frontmatterJson: jsonb("frontmatter_json").notNull().default(sql`'{}'::jsonb`),
    installDir: text("install_dir").notNull(),
    manifestJson: jsonb("manifest_json").notNull().default(sql`'{}'::jsonb`),
    metadataJson: jsonb("metadata_json").notNull().default(sql`'{}'::jsonb`),
    skillId: text("skill_id")
      .notNull()
      .references(() => installedSkills.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
  },
  (table) => [
    index("skill_versions_skill_created_idx").on(table.skillId, table.createdAt.desc()),
  ],
);

export const skillFiles = pgTable(
  "skill_files",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind").notNull(),
    mime: text("mime").notNull(),
    path: text("path").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storagePath: text("storage_path").notNull(),
    versionId: text("version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),
  },
  (table) => [index("skill_files_version_path_idx").on(table.versionId, table.path)],
);

export const skillPermissions = pgTable(
  "skill_permissions",
  {
    id: text("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    environment: text("environment").notNull(),
    policyJson: jsonb("policy_json").notNull().default(sql`'{}'::jsonb`),
    scope: text("scope").notNull(),
    skillId: text("skill_id").references(() => installedSkills.id, { onDelete: "cascade" }),
    sourcePattern: text("source_pattern"),
    status: text("status").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    index("skill_permissions_env_user_status_idx").on(
      table.environment,
      table.userId,
      table.status,
    ),
  ],
);

export const skillAuditEvents = pgTable(
  "skill_audit_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    environment: text("environment").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    runId: text("run_id"),
    skillId: text("skill_id").references(() => installedSkills.id, { onDelete: "set null" }),
    userId: text("user_id").notNull(),
  },
  (table) => [
    index("skill_audit_events_env_user_created_idx").on(
      table.environment,
      table.userId,
      table.createdAt.desc(),
    ),
    index("skill_audit_events_skill_created_idx").on(table.skillId, table.createdAt.desc()),
  ],
);
