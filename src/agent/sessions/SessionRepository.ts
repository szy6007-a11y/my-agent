import { randomUUID } from "crypto";
import postgres from "postgres";

import type {
  AgentEvent,
  AgentMessage,
  AgentRole,
  ModelToolCall,
  RunStatus,
} from "@/agent/runtime/types";
import type { PromptAssembly } from "@/agent/context/PromptAssembler";
import { getSql } from "@/lib/db";
import { serverEnv } from "@/lib/env";

type StoredMessageRow = {
  id: string;
  role: AgentRole;
  content_json: {
    text?: string;
    toolCalls?: ModelToolCall[];
  };
  tool_call_id: string | null;
  tool_name: string | null;
  created_at: Date;
};

type StoredMessageWithSessionRow = StoredMessageRow & {
  rn: number;
  session_created_at: Date;
  session_title: string;
  session_updated_at: Date;
  total_messages: number;
};

type SearchHitRow = StoredMessageRow & {
  rank: number | null;
  session_created_at: Date;
  session_id: string;
  session_title: string;
  session_updated_at: Date;
  snippet: string | null;
};

type StoredSessionRow = {
  id: string;
  title: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  message_count: number;
};

type PromptSnapshotRow = {
  prompt_snapshot_json: unknown;
};

export type StoredChatSession = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type SessionSearchMessage = {
  id: string;
  role: AgentRole;
  content: string;
  toolCallId?: string | null;
  toolName?: string | null;
  createdAt: string;
};

export type SessionWindowResult = {
  bookendEnd: boolean;
  bookendStart: boolean;
  messages: SessionSearchMessage[];
  messagesAfter: number;
  messagesBefore: number;
  session: {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    totalMessages: number;
  };
};

export type SessionDiscoveryResult = SessionWindowResult & {
  match: {
    messageId: string;
    role: AgentRole;
    snippet: string;
  };
  rank: number | null;
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
      tool_name text,
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
    alter table messages
    add column if not exists tool_name text
  `;

  await db`
    alter table sessions
    add column if not exists prompt_snapshot_json jsonb
  `;

  await db`
    alter table sessions
    add column if not exists prompt_snapshot_created_at timestamptz
  `;

  await db`
    create index if not exists messages_session_created_idx
    on messages(session_id, created_at)
  `;

  await db`
    create index if not exists messages_content_fts_idx
    on messages using gin (
      to_tsvector('simple', coalesce(content_json->>'text', ''))
    )
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

function isPromptAssembly(value: unknown): value is PromptAssembly {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<PromptAssembly>;
  return (
    typeof candidate.prompt === "string" &&
    Array.isArray(candidate.sections) &&
    Boolean(candidate.tiers) &&
    typeof candidate.tiers === "object" &&
    typeof candidate.tiers.stable === "string" &&
    typeof candidate.tiers.context === "string" &&
    typeof candidate.tiers.volatile === "string"
  );
}

function toPromptAssembly(value: unknown): PromptAssembly | null {
  return isPromptAssembly(value) ? value : null;
}

function contentText(row: StoredMessageRow): string {
  return typeof row.content_json.text === "string" ? row.content_json.text : "";
}

function toAgentMessage(row: StoredMessageRow): AgentMessage {
  const toolCalls =
    Array.isArray(row.content_json.toolCalls) && row.content_json.toolCalls.length > 0 ?
      row.content_json.toolCalls
    : undefined;

  return {
    id: row.id,
    role: row.role,
    content: contentText(row),
    toolCallId: row.tool_call_id,
    toolCalls,
    toolName: row.tool_name,
    createdAt: row.created_at.toISOString(),
  };
}

function toSearchMessage(row: StoredMessageRow): SessionSearchMessage {
  return {
    id: row.id,
    role: row.role,
    content: contentText(row),
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    createdAt: row.created_at.toISOString(),
  };
}

function compactSnippet(text: string, query: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 260) {
    return normalized;
  }

  const lowerText = normalized.toLowerCase();
  const firstTerm = query
    .toLowerCase()
    .split(/\s+/)
    .find((term) => term.length >= 2);
  const index = firstTerm ? lowerText.indexOf(firstTerm) : -1;
  const start = index > 80 ? Math.max(0, index - 90) : 0;
  const end = Math.min(normalized.length, start + 260);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalized.length ? "..." : "";

  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

function roleFilterFlags(roles: AgentRole[] | undefined) {
  const effective = roles && roles.length > 0 ? roles : (["user", "assistant"] satisfies AgentRole[]);
  return {
    assistant: effective.includes("assistant"),
    tool: effective.includes("tool"),
    user: effective.includes("user"),
  };
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

  async getPromptSnapshot(input: {
    sessionId: string;
    userId: string;
  }): Promise<PromptAssembly | null> {
    await ready();
    const db = getSql();
    const rows = await db<PromptSnapshotRow[]>`
      select prompt_snapshot_json
      from sessions
      where id = ${input.sessionId}
        and user_id = ${input.userId}
        and environment = ${serverEnv.APP_ENV}
      limit 1
    `;

    return toPromptAssembly(rows[0]?.prompt_snapshot_json);
  }

  async savePromptSnapshotIfAbsent(input: {
    sessionId: string;
    snapshot: PromptAssembly;
    userId: string;
  }): Promise<PromptAssembly> {
    await ready();
    const db = getSql();
    const rows = await db<PromptSnapshotRow[]>`
      update sessions
      set
        prompt_snapshot_json = coalesce(
          prompt_snapshot_json,
          ${db.json(toJson(input.snapshot))}
        ),
        prompt_snapshot_created_at = coalesce(prompt_snapshot_created_at, now())
      where id = ${input.sessionId}
        and user_id = ${input.userId}
        and environment = ${serverEnv.APP_ENV}
      returning prompt_snapshot_json
    `;
    const snapshot = toPromptAssembly(rows[0]?.prompt_snapshot_json);

    if (!snapshot) {
      throw new Error("Session not found or prompt snapshot could not be saved");
    }

    return snapshot;
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
    toolCalls?: ModelToolCall[];
    toolName?: string | null;
  }) {
    await ready();
    const db = getSql();
    const id = `msg_${randomUUID()}`;
    const contentJson = {
      text: input.content,
      ...(input.toolCalls && input.toolCalls.length > 0 ? { toolCalls: input.toolCalls } : {}),
    };

    await db`
      insert into messages (id, session_id, role, content_json, tool_call_id, tool_name)
      values (
        ${id},
        ${input.sessionId},
        ${input.role},
        ${db.json(toJson(contentJson))},
        ${input.toolCallId ?? null},
        ${input.toolName ?? null}
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
      select m.id, m.role, m.content_json, m.tool_call_id, m.tool_name, m.created_at
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

    return rows.reverse().map(toAgentMessage);
  }

  async discoverSessions(input: {
    limit?: number;
    query: string;
    roleFilter?: Array<"user" | "assistant" | "tool">;
    sort?: "newest" | "oldest";
    userId: string;
  }): Promise<SessionDiscoveryResult[]> {
    await ready();
    const db = getSql();
    const limit = Math.max(1, Math.min(input.limit ?? 3, 10));
    const query = input.query.trim();
    const roles = roleFilterFlags(input.roleFilter);
    const orderBy =
      input.sort === "oldest" ? db`s.updated_at asc, m.created_at asc`
      : input.sort === "newest" ? db`s.updated_at desc, m.created_at desc`
      : db`rank desc, s.updated_at desc, m.created_at desc`;

    if (!query) {
      return [];
    }

    const hits = await db<SearchHitRow[]>`
      with search_query as (
        select websearch_to_tsquery('simple', ${query}) as query
      )
      select
        s.id as session_id,
        s.title as session_title,
        s.created_at as session_created_at,
        s.updated_at as session_updated_at,
        m.id,
        m.role,
        m.content_json,
        m.tool_call_id,
        m.tool_name,
        m.created_at,
        ts_rank_cd(
          to_tsvector('simple', coalesce(m.content_json->>'text', '')),
          search_query.query
        ) as rank,
        ts_headline(
          'simple',
          coalesce(m.content_json->>'text', ''),
          search_query.query,
          'MaxWords=32, MinWords=8, ShortWord=2, HighlightAll=false, StartSel=<mark>, StopSel=</mark>'
        ) as snippet
      from messages m
      join sessions s on s.id = m.session_id
      cross join search_query
      where s.user_id = ${input.userId}
        and s.environment = ${serverEnv.APP_ENV}
        and (
          (${roles.user} and m.role = 'user')
          or (${roles.assistant} and m.role = 'assistant')
          or (${roles.tool} and m.role = 'tool')
        )
        and (
          to_tsvector('simple', coalesce(m.content_json->>'text', '')) @@ search_query.query
          or coalesce(m.content_json->>'text', '') ilike ${`%${query}%`}
        )
      order by ${orderBy}
      limit ${limit * 6}
    `;

    const results: SessionDiscoveryResult[] = [];
    const seenSessions = new Set<string>();

    for (const hit of hits) {
      if (seenSessions.has(hit.session_id)) {
        continue;
      }

      const window = await this.getMessagesAround({
        aroundMessageId: hit.id,
        sessionId: hit.session_id,
        userId: input.userId,
        window: 4,
      });

      if (!window) {
        continue;
      }

      seenSessions.add(hit.session_id);
      results.push({
        ...window,
        match: {
          messageId: hit.id,
          role: hit.role,
          snippet: hit.snippet?.trim() || compactSnippet(contentText(hit), query),
        },
        rank: hit.rank,
      });

      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }

  async getMessagesAround(input: {
    aroundMessageId: string;
    sessionId: string;
    userId: string;
    window?: number;
  }): Promise<SessionWindowResult | null> {
    await ready();
    const db = getSql();
    const window = Math.max(1, Math.min(input.window ?? 5, 20));
    const rows = await db<StoredMessageWithSessionRow[]>`
      with ordered as (
        select
          m.id,
          m.role,
          m.content_json,
          m.tool_call_id,
          m.tool_name,
          m.created_at,
          s.title as session_title,
          s.created_at as session_created_at,
          s.updated_at as session_updated_at,
          row_number() over (order by m.created_at, m.id)::int as rn,
          count(*) over ()::int as total_messages
        from messages m
        join sessions s on s.id = m.session_id
        where m.session_id = ${input.sessionId}
          and s.user_id = ${input.userId}
          and s.environment = ${serverEnv.APP_ENV}
      ),
      anchor as (
        select rn
        from ordered
        where id = ${input.aroundMessageId}
        limit 1
      )
      select ordered.*
      from ordered
      join anchor on ordered.rn between anchor.rn - ${window} and anchor.rn + ${window}
      order by ordered.rn
    `;

    if (rows.length === 0) {
      return null;
    }

    return this.toWindowResult(input.sessionId, rows);
  }

  async readSessionWindow(input: {
    head?: number;
    sessionId: string;
    tail?: number;
    userId: string;
  }): Promise<SessionWindowResult | null> {
    await ready();
    const db = getSql();
    const head = Math.max(1, Math.min(input.head ?? 20, 80));
    const tail = Math.max(1, Math.min(input.tail ?? 10, 80));
    const rows = await db<StoredMessageWithSessionRow[]>`
      with ordered as (
        select
          m.id,
          m.role,
          m.content_json,
          m.tool_call_id,
          m.tool_name,
          m.created_at,
          s.title as session_title,
          s.created_at as session_created_at,
          s.updated_at as session_updated_at,
          row_number() over (order by m.created_at, m.id)::int as rn,
          count(*) over ()::int as total_messages
        from messages m
        join sessions s on s.id = m.session_id
        where m.session_id = ${input.sessionId}
          and s.user_id = ${input.userId}
          and s.environment = ${serverEnv.APP_ENV}
      )
      select *
      from ordered
      where rn <= ${head}
        or rn > total_messages - ${tail}
      order by rn
    `;

    if (rows.length === 0) {
      return null;
    }

    return this.toWindowResult(input.sessionId, rows);
  }

  private toWindowResult(
    sessionId: string,
    rows: StoredMessageWithSessionRow[],
  ): SessionWindowResult {
    const first = rows[0];
    const last = rows[rows.length - 1];
    const totalMessages = Number(first.total_messages);
    const firstIndex = Number(first.rn);
    const lastIndex = Number(last.rn);

    return {
      bookendEnd: lastIndex >= totalMessages,
      bookendStart: firstIndex <= 1,
      messages: rows.map(toSearchMessage),
      messagesAfter: Math.max(0, totalMessages - lastIndex),
      messagesBefore: Math.max(0, firstIndex - 1),
      session: {
        id: sessionId,
        title: first.session_title,
        createdAt: first.session_created_at.toISOString(),
        updatedAt: first.session_updated_at.toISOString(),
        totalMessages,
      },
    };
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
