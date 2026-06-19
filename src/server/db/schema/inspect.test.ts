import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_DATABASE_INDEXES,
  expectedDatabaseSchema,
} from "@/server/db/schema/inspect";

test("expectedDatabaseSchema covers runtime tables and required indexes", () => {
  const schema = expectedDatabaseSchema();

  assert.deepEqual([...schema.keys()].sort(), [
    "agent_runs",
    "auth_login_attempts",
    "auth_sessions",
    "beta_users",
    "messages",
    "run_events",
    "sessions",
    "tool_approvals",
  ]);

  assert.deepEqual([...schema.get("sessions") ?? []].sort(), [
    "created_at",
    "environment",
    "id",
    "prompt_snapshot_created_at",
    "prompt_snapshot_json",
    "status",
    "title",
    "updated_at",
    "user_id",
  ]);
  assert.deepEqual([...schema.get("messages") ?? []].sort(), [
    "content_json",
    "created_at",
    "id",
    "role",
    "session_id",
    "token_count",
    "tool_call_id",
    "tool_name",
  ]);
  assert.deepEqual([...schema.get("tool_approvals") ?? []].sort(), [
    "created_at",
    "decision_json",
    "environment",
    "id",
    "reason",
    "request_json",
    "resolved_at",
    "risk",
    "run_id",
    "session_id",
    "status",
    "tool_call_id",
    "tool_name",
    "user_id",
  ]);
  assert.equal(REQUIRED_DATABASE_INDEXES.length, 11);
});
