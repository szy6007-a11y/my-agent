import { randomUUID } from "crypto";
import postgres, { type Sql } from "postgres";

import type { AgentEvent, AgentMessage, RunStatus } from "@/agent/runtime/types";
import { serverEnv } from "@/lib/env";

type StoredMessageRow = {
  id: string;
  role: AgentMessage["role"];
  content_json: { text?: string };
  tool_call_id: string | null;
  created_at: Date;
};

let sql: Sql | null = null;
let schemaPromise: Promise<void> | null = null;

function getSql() {
  if (!serverEnv.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for agent persistence");
  }

  sql ??= postgres(serverEnv.DATABASE_URL, {
    max: 5,
    onnotice: () => undefined,
  });

  return sql;
}

async function ensureSchema() {
  const db = getSql();

  await db`
    create table if not exists sessions (
      id text primary key,
      user_id text not null,
      title text not null,
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await db`
    create table if not exists messages (
      id text primary key,
      session_id text not null references sessions(id) on delete cascade,
      role text not null,
      content_json jsonb not null,
      tool_call_id text,
      token_count integer,
      created_at timestamptz not null default now()
    )
  `;

  await db`
    create table if not exists agent_runs (
      id text primary key,
      session_id text not null references sessions(id) on delete cascade,
      user_id text not null,
      status text not null,
      model text not null,
      permission_mode text not null,
      started_at timestamptz,
      ended_at timestamptz,
      error_json jsonb,
      created_at timestamptz not null default now()
    )
  `;

  await db`
    create table if not exists run_events (
      id bigserial primary key,
      run_id text not null references agent_runs(id) on delete cascade,
      type text not null,
      payload_json jsonb not null,
      created_at timestamptz not null default now()
    )
  `;

  await db`
    create index if not exists messages_session_created_idx
    on messages(session_id, created_at)
  `;

  await db`
    create index if not exists run_events_run_created_idx
    on run_events(run_id, created_at)
  `;
}

async function ready() {
  schemaPromise ??= ensureSchema();
  await schemaPromise;
}

function toJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

export class SessionRepository {
  async createSession(input: { userId: string; title: string }) {
    await ready();
    const db = getSql();
    const id = `sess_${randomUUID()}`;

    await db`
      insert into sessions (id, user_id, title)
      values (${id}, ${input.userId}, ${input.title})
    `;

    return { id };
  }

  async touchSession(sessionId: string, title?: string) {
    await ready();
    const db = getSql();

    if (title) {
      await db`
        update sessions
        set title = ${title}, updated_at = now()
        where id = ${sessionId}
      `;
      return;
    }

    await db`
      update sessions
      set updated_at = now()
      where id = ${sessionId}
    `;
  }

  async appendMessage(input: {
    sessionId: string;
    role: AgentMessage["role"];
    content: string;
    toolCallId?: string | null;
  }) {
    await ready();
    const db = getSql();
    const id = `msg_${randomUUID()}`;

    await db`
      insert into messages (id, session_id, role, content_json, tool_call_id)
      values (
        ${id},
        ${input.sessionId},
        ${input.role},
        ${db.json({ text: input.content })},
        ${input.toolCallId ?? null}
      )
    `;

    return { id };
  }

  async listMessages(sessionId: string, limit = 40): Promise<AgentMessage[]> {
    await ready();
    const db = getSql();
    const rows = await db<StoredMessageRow[]>`
      select id, role, content_json, tool_call_id, created_at
      from messages
      where session_id = ${sessionId}
      order by created_at desc
      limit ${limit}
    `;

    return rows
      .reverse()
      .map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content_json.text ?? "",
        toolCallId: row.tool_call_id,
        createdAt: row.created_at.toISOString(),
      }));
  }

  async createRun(input: {
    sessionId: string;
    userId: string;
    model: string;
    permissionMode: string;
  }) {
    await ready();
    const db = getSql();
    const id = `run_${randomUUID()}`;

    await db`
      insert into agent_runs (id, session_id, user_id, status, model, permission_mode)
      values (
        ${id},
        ${input.sessionId},
        ${input.userId},
        'queued',
        ${input.model},
        ${input.permissionMode}
      )
    `;

    return { id };
  }

  async updateRunStatus(runId: string, status: RunStatus, error?: unknown) {
    await ready();
    const db = getSql();

    await db`
      update agent_runs
      set
        status = ${status},
        started_at = case
          when started_at is null and ${status} <> 'queued' then now()
          else started_at
        end,
        ended_at = case
          when ${status} in ('completed', 'failed', 'aborted', 'expired') then now()
          else ended_at
        end,
        error_json = ${error ? db.json(toJson(error)) : null}
      where id = ${runId}
    `;
  }

  async appendRunEvent(runId: string, event: AgentEvent) {
    await ready();
    const db = getSql();

    await db`
      insert into run_events (run_id, type, payload_json)
      values (${runId}, ${event.type}, ${db.json(toJson(event))})
    `;
  }
}

export const sessionRepository = new SessionRepository();
