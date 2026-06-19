import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
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
