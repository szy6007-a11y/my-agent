import { randomUUID } from "crypto";
import postgres from "postgres";

import type { AgentEvent, AgentMessage, RunStatus } from "@/agent/runtime/types";
import { getSql } from "@/lib/db";
import { serverEnv } from "@/lib/env";

type StoredMessageRow = {
  id: string;
  role: AgentMessage["role"];
  content_json: { text?: string };
  tool_call_id: string | null;
  created_at: Date;
};

type StoredSessionRow = {
  id: string;
  title: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  message_count: number;
};

export type StoredChatSession = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

let schemaPromise: Promise<void> | null = null;

async function ensureSchema() {
  const db = getSql();

  await db`
    create table if not exists sessions (
      id text primary key,
      environment text not null,
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
      environment text not null,
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
    alter table sessions
    add column if not exists environment text
  `;

  await db`
    update sessions
    set environment = ${serverEnv.APP_ENV}
    where environment is null
  `;

  await db`
    alter table sessions
    alter column environment set not null
  `;

  await db`
    alter table agent_runs
    add column if not exists environment text
  `;

  await db`
    update agent_runs
    set environment = ${serverEnv.APP_ENV}
    where environment is null
  `;

  await db`
    alter table agent_runs
    alter column environment set not null
  `;

  await db`
    create index if not exists messages_session_created_idx
    on messages(session_id, created_at)
  `;

  await db`
    create index if not exists run_events_run_created_idx
    on run_events(run_id, created_at)
  `;

  await db`
    create index if not exists sessions_environment_user_updated_idx
    on sessions(environment, user_id, updated_at desc)
  `;

  await db`
    create index if not exists agent_runs_environment_session_created_idx
    on agent_runs(environment, session_id, created_at desc)
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
      insert into sessions (id, environment, user_id, title)
      values (${id}, ${serverEnv.APP_ENV}, ${input.userId}, ${input.title})
    `;

    return { id };
  }

  async getSessionForUser(sessionId: string, userId: string) {
    await ready();
    const db = getSql();
    const rows = await db<{ id: string; title: string }[]>`
      select id, title
      from sessions
      where id = ${sessionId}
        and user_id = ${userId}
        and environment = ${serverEnv.APP_ENV}
      limit 1
    `;

    return rows[0] ?? null;
  }

  async listSessions(userId: string, limit = 50): Promise<StoredChatSession[]> {
    await ready();
    const db = getSql();
    const rows = await db<StoredSessionRow[]>`
      select
        s.id,
        s.title,
        s.status,
        s.created_at,
        s.updated_at,
        count(m.id)::int as message_count
      from sessions s
      left join messages m on m.session_id = s.id
      where s.user_id = ${userId}
        and s.environment = ${serverEnv.APP_ENV}
      group by s.id
      order by s.updated_at desc
      limit ${limit}
    `;

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      messageCount: row.message_count,
    }));
  }

  async touchSession(sessionId: string, userId: string, title?: string) {
    await ready();
    const db = getSql();

    if (title) {
      await db`
        update sessions
        set title = ${title}, updated_at = now()
        where id = ${sessionId}
          and user_id = ${userId}
          and environment = ${serverEnv.APP_ENV}
      `;
      return;
    }

    await db`
      update sessions
      set updated_at = now()
      where id = ${sessionId}
        and user_id = ${userId}
        and environment = ${serverEnv.APP_ENV}
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

  async listMessages(
    sessionId: string,
    input: { userId?: string; limit?: number } = {},
  ): Promise<AgentMessage[]> {
    await ready();
    const db = getSql();
    const limit = input.limit ?? 40;
    const rows = await db<StoredMessageRow[]>`
      select m.id, m.role, m.content_json, m.tool_call_id, m.created_at
      from messages m
      join sessions s on s.id = m.session_id
      where m.session_id = ${sessionId}
        and s.environment = ${serverEnv.APP_ENV}
        ${
          input.userId ?
            db`and s.user_id = ${input.userId}`
          : db``
        }
      order by m.created_at desc
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
      insert into agent_runs (
        id,
        environment,
        session_id,
        user_id,
        status,
        model,
        permission_mode
      )
      values (
        ${id},
        ${serverEnv.APP_ENV},
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
        and environment = ${serverEnv.APP_ENV}
    `;
  }

  async appendRunEvent(runId: string, event: AgentEvent) {
    await ready();
    const db = getSql();

    await db`
      insert into run_events (run_id, type, payload_json)
      select id, ${event.type}, ${db.json(toJson(event))}
      from agent_runs
      where id = ${runId}
        and environment = ${serverEnv.APP_ENV}
    `;
  }
}

export const sessionRepository = new SessionRepository();
