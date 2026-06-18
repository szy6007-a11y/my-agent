import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const betaUsers = pgTable(
  "beta_users",
  {
    id: text("id").primaryKey(),
    environment: text("environment").notNull(),
    inviteCodeHash: text("invite_code_hash").notNull(),
    loginIdHash: text("login_id_hash").notNull(),
    displayName: text("display_name"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("beta_users_environment_login_id_hash_idx").on(
      table.environment,
      table.loginIdHash,
    ),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    environment: text("environment").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => betaUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    userAgent: text("user_agent"),
  },
  (table) => [
    uniqueIndex("auth_sessions_environment_token_idx").on(
      table.environment,
      table.tokenHash,
    ),
    index("auth_sessions_user_active_idx")
      .on(table.environment, table.userId, table.expiresAt)
      .where(sql`${table.revokedAt} is null`),
  ],
);

export const authLoginAttempts = pgTable(
  "auth_login_attempts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    environment: text("environment").notNull(),
    bucket: text("bucket").notNull(),
    success: boolean("success").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("auth_login_attempts_bucket_idx").on(
      table.environment,
      table.bucket,
      table.attemptedAt.desc(),
    ),
  ],
);
