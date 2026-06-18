import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as schema from "@/server/db/schema";

export type ExpectedDatabaseSchema = Map<string, Set<string>>;

export const REQUIRED_DATABASE_INDEXES = [
  "agent_runs_environment_session_created_idx",
  "auth_login_attempts_bucket_idx",
  "auth_sessions_environment_token_idx",
  "auth_sessions_user_active_idx",
  "beta_users_environment_login_id_hash_idx",
  "messages_content_fts_idx",
  "messages_session_created_idx",
  "run_events_run_created_idx",
  "sessions_environment_user_updated_idx",
] as const;

export function expectedDatabaseSchema(): ExpectedDatabaseSchema {
  const expected = new Map<string, Set<string>>();

  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) {
      continue;
    }

    const config = getTableConfig(value);
    expected.set(config.name, new Set(config.columns.map((column) => column.name)));
  }

  return expected;
}
