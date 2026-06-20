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
    "agent_tasks",
    "auth_login_attempts",
    "auth_sessions",
    "beta_users",
    "installed_skills",
    "messages",
    "run_events",
    "sessions",
    "skill_audit_events",
    "skill_files",
    "skill_permissions",
    "skill_versions",
    "tool_approvals",
  ]);

  assert.deepEqual([...schema.get("agent_tasks") ?? []].sort(), [
    "active_form",
    "background",
    "child_run_id",
    "child_session_id",
    "completed_at",
    "context",
    "created_at",
    "description",
    "environment",
    "error_json",
    "goal",
    "id",
    "kind",
    "metadata_json",
    "model",
    "parent_run_id",
    "parent_session_id",
    "result_json",
    "role",
    "started_at",
    "status",
    "subject",
    "toolsets_json",
    "updated_at",
    "user_id",
  ]);

  assert.deepEqual([...schema.get("sessions") ?? []].sort(), [
    "created_at",
    "end_reason",
    "ended_at",
    "environment",
    "id",
    "parent_session_id",
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
  assert.equal(REQUIRED_DATABASE_INDEXES.length, 22);
});
