import { randomUUID } from "crypto";
import { setTimeout as sleep } from "timers/promises";
import postgres from "postgres";

import type {
  AgentArtifact,
  ContextSummaryMetadata,
  AgentEvent,
  AgentMessage,
  AgentMessageContentKind,
  AgentRole,
  ModelToolCall,
  RunStatus,
  SequencedAgentEvent,
  ToolApprovalStatus,
  ToolRisk,
} from "@/agent/runtime/types";
import type { PromptAssembly } from "@/agent/context/PromptAssembler";
import { CONTEXT_SUMMARY_KIND } from "@/agent/context/ContextSummary";
import { isTerminalRunStatus } from "@/agent/runtime/RunEvents";
import { getSql } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { assertDatabaseMigrated } from "@/server/db/readiness";
import {
  SYSTEM_REMINDER_CLOSE_TAG,
  TRUSTED_SYSTEM_REMINDER_SENTINEL,
  stripTrustedRuntimeReminder,
} from "@/shared/runtime-reminder";

type StoredMessageRow = {
  id: string;
  role: AgentRole;
  content_json: {
    artifacts?: AgentArtifact[];
    kind?: AgentMessageContentKind;
    summary?: ContextSummaryMetadata;
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
  searchable_text: string;
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

type StoredAgentRunRow = {
  id: string;
  session_id: string;
  status: string;
  model: string;
  permission_mode: string;
  started_at: Date | null;
  ended_at: Date | null;
  error_json: unknown;
  created_at: Date;
};

type StoredRunEventRow = {
  id: number;
  payload_json: unknown;
  created_at: Date;
};

type ToolApprovalRow = {
  id: string;
  status: ToolApprovalStatus;
  run_id: string;
  session_id: string;
  user_id: string;
  tool_call_id: string;
  tool_name: string;
  risk: ToolRisk;
  reason: string;
  request_json: unknown;
  decision_json: unknown;
  created_at: Date;
  resolved_at: Date | null;
};

export type StoredChatSession = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type StoredAgentRun = {
  id: string;
  sessionId: string;
  status: RunStatus;
  model: string;
  permissionMode: string;
  startedAt: string | null;
  endedAt: string | null;
  error: unknown;
  createdAt: string;
};

export type StoredRunEvent = {
  id: number;
  event: SequencedAgentEvent;
  createdAt: string;
};

export type SessionSearchMessage = {
  anchor?: boolean;
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
  bookendEndMessages: SessionSearchMessage[];
  bookendStartMessages: SessionSearchMessage[];
  match: {
    messageId: string;
    role: AgentRole;
    snippet: string;
  };
  rank: number | null;
};

export type StoredToolApproval = {
  id: string;
  status: ToolApprovalStatus;
  runId: string;
  sessionId: string;
  userId: string;
  toolCallId: string;
  toolName: string;
  risk: ToolRisk;
  reason: string;
  request: unknown;
  decision: unknown;
  createdAt: string;
  resolvedAt: string | null;
};

export type ToolApprovalDecision = Extract<ToolApprovalStatus, "approved" | "rejected">;

const APPROVAL_POLL_INTERVAL_MS = 250;
const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const RUN_TURN_POLL_INTERVAL_MS = 250;
const ACTIVE_RUN_STATUSES_SQL = [
  "preparing",
  "streaming_model",
  "waiting_approval",
  "executing_tools",
  "compacting",
  "finalizing",
];
const TERMINAL_RUN_STATUSES_SQL = ["completed", "failed", "aborted", "expired"];

async function ready() {
  await assertDatabaseMigrated();
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

function isToolApprovalStatus(value: unknown): value is ToolApprovalStatus {
  return (
    value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "expired"
  );
}

function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === "queued" ||
    value === "preparing" ||
    value === "streaming_model" ||
    value === "waiting_approval" ||
    value === "executing_tools" ||
    value === "compacting" ||
    value === "finalizing" ||
    value === "completed" ||
    value === "failed" ||
    value === "aborted" ||
    value === "expired"
  );
}

function toStoredRun(row: StoredAgentRunRow): StoredAgentRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: isRunStatus(row.status) ? row.status : "failed",
    model: row.model,
    permissionMode: row.permission_mode,
    startedAt: row.started_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    error: row.error_json,
    createdAt: row.created_at.toISOString(),
  };
}

function toStoredRunEvent(row: StoredRunEventRow): StoredRunEvent {
  return {
    id: row.id,
    event: {
      ...(row.payload_json as AgentEvent),
      seq: row.id,
    },
    createdAt: row.created_at.toISOString(),
  };
}

function toToolApproval(row: ToolApprovalRow): StoredToolApproval {
  return {
    id: row.id,
    status: isToolApprovalStatus(row.status) ? row.status : "pending",
    runId: row.run_id,
    sessionId: row.session_id,
    userId: row.user_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    risk: row.risk,
    reason: row.reason,
    request: row.request_json,
    decision: row.decision_json,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  };
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
    artifacts:
      Array.isArray(row.content_json.artifacts) && row.content_json.artifacts.length > 0 ?
        row.content_json.artifacts
      : undefined,
    contentKind: row.content_json.kind,
    contextSummary: row.content_json.summary,
    toolCallId: row.tool_call_id,
    toolCalls,
    toolName: row.tool_name,
    createdAt: row.created_at.toISOString(),
  };
}

function toSearchMessage(row: StoredMessageRow, anchorId?: string): SessionSearchMessage {
  return {
    ...(anchorId && row.id === anchorId ? { anchor: true } : {}),
    id: row.id,
    role: row.role,
    content: stripTrustedRuntimeReminder(contentText(row)),
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

  async savePromptSnapshot(input: {
    sessionId: string;
    snapshot: PromptAssembly;
    userId: string;
  }): Promise<PromptAssembly> {
    await ready();
    const db = getSql();
    const rows = await db<PromptSnapshotRow[]>`
      update sessions
      set
        prompt_snapshot_json = ${db.json(toJson(input.snapshot))},
        prompt_snapshot_created_at = now()
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

  async listSessions(
    userId: string,
    limit = 50,
    input: { excludeSessionId?: string } = {},
  ): Promise<StoredChatSession[]> {
    await ready();
    const db = getSql();
    const rows = await db<StoredSessionRow[]>`
      select
        s.id,
        s.title,
        s.status,
        s.created_at,
        s.updated_at,
        count(m.id) filter (
          where coalesce(m.content_json->>'kind', '') <> ${CONTEXT_SUMMARY_KIND}
        )::int as message_count
      from sessions s
      left join messages m on m.session_id = s.id
      where s.user_id = ${userId}
        and s.environment = ${serverEnv.APP_ENV}
        ${
          input.excludeSessionId ?
            db`and s.id <> ${input.excludeSessionId}`
          : db``
        }
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
    artifacts?: AgentArtifact[];
    contentKind?: AgentMessageContentKind;
    contextSummary?: ContextSummaryMetadata;
    toolCallId?: string | null;
    toolCalls?: ModelToolCall[];
    toolName?: string | null;
  }) {
    await ready();
    const db = getSql();
    const id = `msg_${randomUUID()}`;
    const contentJson = {
      ...(input.artifacts && input.artifacts.length > 0 ? { artifacts: input.artifacts } : {}),
      ...(input.contentKind ? { kind: input.contentKind } : {}),
      ...(input.contextSummary ? { summary: input.contextSummary } : {}),
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

  async updateMessageContent(input: {
    content: string;
    messageId: string;
    sessionId: string;
    userId: string;
  }) {
    await ready();
    const db = getSql();
    const rows = await db<{ id: string }[]>`
      update messages m
      set content_json = jsonb_set(
        m.content_json,
        '{text}',
        to_jsonb(${input.content}::text),
        true
      )
      where m.id = ${input.messageId}
        and m.session_id = ${input.sessionId}
        and exists (
          select 1
          from sessions s
          where s.id = m.session_id
            and s.user_id = ${input.userId}
            and s.environment = ${serverEnv.APP_ENV}
        )
      returning m.id
    `;

    if (!rows[0]) {
      throw new Error("Message not found or not writable by user");
    }
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
    currentSessionId?: string;
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
    const searchableTextExpression = db`
      case
        when position(${TRUSTED_SYSTEM_REMINDER_SENTINEL} in coalesce(m.content_json->>'text', '')) > 0
          and position(${SYSTEM_REMINDER_CLOSE_TAG} in coalesce(m.content_json->>'text', '')) > 0
        then ltrim(substr(
          coalesce(m.content_json->>'text', ''),
          position(${SYSTEM_REMINDER_CLOSE_TAG} in coalesce(m.content_json->>'text', ''))
            + char_length(${SYSTEM_REMINDER_CLOSE_TAG})
        ))
        else coalesce(m.content_json->>'text', '')
      end
    `;
    const orderBy =
      input.sort === "oldest" ? db`session_updated_at asc, created_at asc`
      : input.sort === "newest" ? db`session_updated_at desc, created_at desc`
      : db`rank desc, session_updated_at desc, created_at desc`;

    if (!query) {
      return [];
    }

    const hits = await db<SearchHitRow[]>`
      with message_text as (
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
          ${searchableTextExpression} as searchable_text
        from messages m
        join sessions s on s.id = m.session_id
        where s.user_id = ${input.userId}
          and s.environment = ${serverEnv.APP_ENV}
          ${
            input.currentSessionId ?
              db`and s.id <> ${input.currentSessionId}`
            : db``
          }
          and (
            (${roles.user} and m.role = 'user')
            or (${roles.assistant} and m.role = 'assistant')
            or (${roles.tool} and m.role = 'tool')
          )
          and coalesce(m.content_json->>'kind', '') <> ${CONTEXT_SUMMARY_KIND}
      ),
      search_query as (
        select websearch_to_tsquery('simple', ${query}) as query
      )
      select
        session_id,
        session_title,
        session_created_at,
        session_updated_at,
        id,
        role,
        content_json,
        tool_call_id,
        tool_name,
        created_at,
        searchable_text,
        ts_rank_cd(
          to_tsvector('simple', searchable_text),
          search_query.query
        ) as rank,
        ts_headline(
          'simple',
          searchable_text,
          search_query.query,
          'MaxWords=32, MinWords=8, ShortWord=2, HighlightAll=false, StartSel=<mark>, StopSel=</mark>'
        ) as snippet
      from message_text
      cross join search_query
      where to_tsvector('simple', searchable_text) @@ search_query.query
        or searchable_text ilike ${`%${query}%`}
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
        window: 5,
      });

      if (!window) {
        continue;
      }

      const bookends = await this.getSessionBookends({
        bookend: 3,
        sessionId: hit.session_id,
        userId: input.userId,
      });

      seenSessions.add(hit.session_id);
      results.push({
        ...window,
        bookendEndMessages: bookends?.end ?? [],
        bookendStartMessages: bookends?.start ?? [],
        match: {
          messageId: hit.id,
          role: hit.role,
          snippet: hit.snippet?.trim() || compactSnippet(hit.searchable_text, query),
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
          and coalesce(m.content_json->>'kind', '') <> ${CONTEXT_SUMMARY_KIND}
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

    return this.toWindowResult(input.sessionId, rows, input.aroundMessageId);
  }

  async getSessionBookends(input: {
    bookend?: number;
    sessionId: string;
    userId: string;
  }): Promise<{ end: SessionSearchMessage[]; start: SessionSearchMessage[] } | null> {
    await ready();
    const db = getSql();
    const bookend = Math.max(1, Math.min(input.bookend ?? 3, 20));
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
          and coalesce(m.content_json->>'kind', '') <> ${CONTEXT_SUMMARY_KIND}
      )
      select *
      from ordered
      where rn <= ${bookend}
        or rn > total_messages - ${bookend}
      order by rn
    `;

    if (rows.length === 0) {
      return null;
    }

    return {
      end: rows
        .filter((row) => Number(row.rn) > Number(row.total_messages) - bookend)
        .map((row) => toSearchMessage(row)),
      start: rows
        .filter((row) => Number(row.rn) <= bookend)
        .map((row) => toSearchMessage(row)),
    };
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
          and coalesce(m.content_json->>'kind', '') <> ${CONTEXT_SUMMARY_KIND}
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
    anchorId?: string,
  ): SessionWindowResult {
    const first = rows[0];
    const last = rows[rows.length - 1];
    const totalMessages = Number(first.total_messages);
    const firstIndex = Number(first.rn);
    const lastIndex = Number(last.rn);

    return {
      bookendEnd: lastIndex >= totalMessages,
      bookendStart: firstIndex <= 1,
      messages: rows.map((row) => toSearchMessage(row, anchorId)),
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

  async getRunForUser(input: {
    runId: string;
    userId: string;
  }): Promise<StoredAgentRun | null> {
    await ready();
    const db = getSql();
    const rows = await db<StoredAgentRunRow[]>`
      select
        id,
        session_id,
        status,
        model,
        permission_mode,
        started_at,
        ended_at,
        error_json,
        created_at
      from agent_runs
      where id = ${input.runId}
        and user_id = ${input.userId}
        and environment = ${serverEnv.APP_ENV}
      limit 1
    `;

    return rows[0] ? toStoredRun(rows[0]) : null;
  }

  async getRunStatus(runId: string): Promise<RunStatus | null> {
    await ready();
    const db = getSql();
    const rows = await db<{ status: string }[]>`
      select status
      from agent_runs
      where id = ${runId}
        and environment = ${serverEnv.APP_ENV}
      limit 1
    `;
    const status = rows[0]?.status;

    return isRunStatus(status) ? status : null;
  }

  private async claimRunTurn(input: {
    runId: string;
    userId: string;
  }): Promise<StoredAgentRun | null> {
    await ready();
    const db = getSql();
    const rows = await db<StoredAgentRunRow[]>`
      update agent_runs current_run
      set
        status = 'preparing',
        started_at = coalesce(started_at, now())
      where current_run.id = ${input.runId}
        and current_run.user_id = ${input.userId}
        and current_run.environment = ${serverEnv.APP_ENV}
        and current_run.status = 'queued'
        and not exists (
          select 1
          from agent_runs active_run
          where active_run.environment = current_run.environment
            and active_run.session_id = current_run.session_id
            and active_run.status in ${db(ACTIVE_RUN_STATUSES_SQL)}
        )
        and not exists (
          select 1
          from agent_runs older_queued
          where older_queued.environment = current_run.environment
            and older_queued.session_id = current_run.session_id
            and older_queued.status = 'queued'
            and (
              older_queued.created_at < current_run.created_at
              or (
                older_queued.created_at = current_run.created_at
                and older_queued.id < current_run.id
              )
            )
        )
      returning
        id,
        session_id,
        status,
        model,
        permission_mode,
        started_at,
        ended_at,
        error_json,
        created_at
    `;

    return rows[0] ? toStoredRun(rows[0]) : null;
  }

  async waitForRunTurn(input: {
    runId: string;
    signal: AbortSignal;
    userId: string;
  }): Promise<StoredAgentRun> {
    while (true) {
      if (input.signal.aborted) {
        const aborted = await this.abortRunForUser({
          reason: "client_aborted",
          runId: input.runId,
          userId: input.userId,
        });

        if (!aborted) {
          throw new Error("Run not found or not writable by user");
        }

        return aborted;
      }

      const claimed = await this.claimRunTurn({
        runId: input.runId,
        userId: input.userId,
      });

      if (claimed) {
        return claimed;
      }

      const current = await this.getRunForUser({
        runId: input.runId,
        userId: input.userId,
      });

      if (!current) {
        throw new Error("Run not found or not writable by user");
      }

      if (isTerminalRunStatus(current.status)) {
        return current;
      }

      try {
        await sleep(RUN_TURN_POLL_INTERVAL_MS, undefined, { signal: input.signal });
      } catch (error) {
        if (!input.signal.aborted) {
          throw error;
        }
      }
    }
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
        and (
          status not in ('completed', 'failed', 'aborted', 'expired')
          or status = ${status}
        )
    `;
  }

  async appendRunEvent(runId: string, event: AgentEvent): Promise<number | null> {
    await ready();
    const db = getSql();

    if (event.type === "tool.approval.resolved") {
      const rows = await db<{ id: number }[]>`
        with inserted as (
          insert into run_events (run_id, type, payload_json)
          select id, ${event.type}, ${db.json(toJson(event))}
          from agent_runs
          where id = ${runId}
            and environment = ${serverEnv.APP_ENV}
            and not exists (
              select 1
              from run_events existing
              where existing.run_id = agent_runs.id
                and existing.type = ${event.type}
                and existing.payload_json->>'approvalId' = ${event.approvalId}
            )
          returning id
        )
        select id
        from inserted
        union all
        select existing.id
        from run_events existing
        join agent_runs r on r.id = existing.run_id
        where r.id = ${runId}
          and r.environment = ${serverEnv.APP_ENV}
          and existing.type = ${event.type}
          and existing.payload_json->>'approvalId' = ${event.approvalId}
        limit 1
      `;
      return rows[0]?.id ?? null;
    }

    if (event.type === "run.aborted") {
      const rows = await db<{ id: number }[]>`
        with inserted as (
          insert into run_events (run_id, type, payload_json)
          select id, ${event.type}, ${db.json(toJson(event))}
          from agent_runs
          where id = ${runId}
            and environment = ${serverEnv.APP_ENV}
            and not exists (
              select 1
              from run_events existing
              where existing.run_id = agent_runs.id
                and existing.type = ${event.type}
            )
          returning id
        )
        select id
        from inserted
        union all
        select existing.id
        from run_events existing
        join agent_runs r on r.id = existing.run_id
        where r.id = ${runId}
          and r.environment = ${serverEnv.APP_ENV}
          and existing.type = ${event.type}
        limit 1
      `;
      return rows[0]?.id ?? null;
    }

    const rows = await db<{ id: number }[]>`
      insert into run_events (run_id, type, payload_json)
      select id, ${event.type}, ${db.json(toJson(event))}
      from agent_runs
      where id = ${runId}
        and environment = ${serverEnv.APP_ENV}
      returning id
    `;

    return rows[0]?.id ?? null;
  }

  async listRunEvents(input: {
    afterId?: number;
    limit?: number;
    runId: string;
    userId: string;
  }): Promise<StoredRunEvent[]> {
    await ready();
    const db = getSql();
    const afterId = input.afterId ?? 0;
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const rows = await db<StoredRunEventRow[]>`
      select e.id, e.payload_json, e.created_at
      from run_events e
      join agent_runs r on r.id = e.run_id
      where r.id = ${input.runId}
        and r.user_id = ${input.userId}
        and r.environment = ${serverEnv.APP_ENV}
        and e.id > ${afterId}
      order by e.id asc
      limit ${limit}
    `;

    return rows.map(toStoredRunEvent);
  }

  async abortRunForUser(input: {
    reason?: string;
    runId: string;
    userId: string;
  }): Promise<StoredAgentRun | null> {
    await ready();
    const db = getSql();
    const current = await this.getRunForUser({
      runId: input.runId,
      userId: input.userId,
    });

    if (!current) {
      return null;
    }

    if (!isTerminalRunStatus(current.status)) {
      const reason = input.reason?.trim() || "user_cancelled";
      const updated = await db<{ id: string }[]>`
        update agent_runs
        set
          status = 'aborted',
          ended_at = now(),
          error_json = ${db.json(toJson({ reason }))}
        where id = ${input.runId}
          and user_id = ${input.userId}
          and environment = ${serverEnv.APP_ENV}
          and status not in ('completed', 'failed', 'aborted', 'expired')
        returning id
      `;
      if (updated[0]) {
        await db`
          update tool_approvals
          set
            status = 'expired',
            decision_json = ${db.json(toJson({
              decision: "expired",
              reason: "Run was cancelled before approval resolved.",
            }))},
            resolved_at = now()
          where run_id = ${input.runId}
            and user_id = ${input.userId}
            and environment = ${serverEnv.APP_ENV}
            and status = 'pending'
        `;
        await this.appendRunEvent(input.runId, {
          type: "run.aborted",
          runId: input.runId,
          reason,
        });
      }
    }

    return this.getRunForUser({
      runId: input.runId,
      userId: input.userId,
    });
  }

  async abortOpenRunsForSession(input: {
    reason?: string;
    sessionId: string;
    userId: string;
  }): Promise<StoredAgentRun[]> {
    await ready();
    const db = getSql();
    const reason = input.reason?.trim() || "interrupted_by_new_run";
    const rows = await db<StoredAgentRunRow[]>`
      update agent_runs
      set
        status = 'aborted',
        ended_at = now(),
        error_json = ${db.json(toJson({ reason }))}
      where session_id = ${input.sessionId}
        and user_id = ${input.userId}
        and environment = ${serverEnv.APP_ENV}
        and status not in ${db(TERMINAL_RUN_STATUSES_SQL)}
      returning
        id,
        session_id,
        status,
        model,
        permission_mode,
        started_at,
        ended_at,
        error_json,
        created_at
    `;

    if (rows.length > 0) {
      await db`
        update tool_approvals
        set
          status = 'expired',
          decision_json = ${db.json(toJson({
            decision: "expired",
            reason: "Run was interrupted before approval resolved.",
          }))},
          resolved_at = now()
        where session_id = ${input.sessionId}
          and user_id = ${input.userId}
          and environment = ${serverEnv.APP_ENV}
          and status = 'pending'
      `;

      for (const row of rows) {
        await this.appendRunEvent(row.id, {
          type: "run.aborted",
          runId: row.id,
          reason,
        });
      }
    }

    return rows.map(toStoredRun);
  }

  async createToolApproval(input: {
    reason: string;
    request: unknown;
    risk: ToolRisk;
    runId: string;
    sessionId: string;
    toolCallId: string;
    toolName: string;
    userId: string;
  }): Promise<StoredToolApproval> {
    await ready();
    const db = getSql();
    const id = `approval_${randomUUID()}`;
    const rows = await db<ToolApprovalRow[]>`
      insert into tool_approvals (
        id,
        environment,
        run_id,
        session_id,
        user_id,
        tool_call_id,
        tool_name,
        risk,
        status,
        reason,
        request_json
      )
      select
        ${id},
        ${serverEnv.APP_ENV},
        r.id,
        r.session_id,
        r.user_id,
        ${input.toolCallId},
        ${input.toolName},
        ${input.risk},
        'pending',
        ${input.reason},
        ${db.json(toJson(input.request))}
      from agent_runs r
      where r.id = ${input.runId}
        and r.session_id = ${input.sessionId}
        and r.user_id = ${input.userId}
        and r.environment = ${serverEnv.APP_ENV}
      returning
        id,
        status,
        run_id,
        session_id,
        user_id,
        tool_call_id,
        tool_name,
        risk,
        reason,
        request_json,
        decision_json,
        created_at,
        resolved_at
    `;

    if (!rows[0]) {
      throw new Error("Run not found or not writable by user");
    }

    return toToolApproval(rows[0]);
  }

  async getToolApprovalForUser(input: {
    approvalId: string;
    userId: string;
  }): Promise<StoredToolApproval | null> {
    await ready();
    const db = getSql();
    const rows = await db<ToolApprovalRow[]>`
      select
        id,
        status,
        run_id,
        session_id,
        user_id,
        tool_call_id,
        tool_name,
        risk,
        reason,
        request_json,
        decision_json,
        created_at,
        resolved_at
      from tool_approvals
      where id = ${input.approvalId}
        and user_id = ${input.userId}
        and environment = ${serverEnv.APP_ENV}
      limit 1
    `;

    return rows[0] ? toToolApproval(rows[0]) : null;
  }

  async resolveToolApproval(input: {
    approvalId: string;
    decision: ToolApprovalDecision;
    decisionReason?: string;
    userId: string;
  }): Promise<StoredToolApproval | null> {
    await ready();
    const db = getSql();
    const rows = await db<ToolApprovalRow[]>`
      update tool_approvals
      set
        status = ${input.decision},
        decision_json = ${db.json(toJson({
          decision: input.decision,
          reason: input.decisionReason ?? null,
          resolvedBy: input.userId,
        }))},
        resolved_at = now()
      where id = ${input.approvalId}
        and user_id = ${input.userId}
        and environment = ${serverEnv.APP_ENV}
        and status = 'pending'
      returning
        id,
        status,
        run_id,
        session_id,
        user_id,
        tool_call_id,
        tool_name,
        risk,
        reason,
        request_json,
        decision_json,
        created_at,
        resolved_at
    `;

    return rows[0] ? toToolApproval(rows[0]) : null;
  }

  async waitForToolApproval(input: {
    approvalId: string;
    signal: AbortSignal;
    timeoutMs?: number;
    userId: string;
  }): Promise<StoredToolApproval> {
    const startedAt = Date.now();
    const timeoutMs = input.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

    while (Date.now() - startedAt < timeoutMs) {
      const approval = await this.getToolApprovalForUser({
        approvalId: input.approvalId,
        userId: input.userId,
      });

      if (!approval) {
        throw new Error("Tool approval not found");
      }

      if (approval.status !== "pending") {
        return approval;
      }

      await sleep(APPROVAL_POLL_INTERVAL_MS, undefined, { signal: input.signal });
    }

    const db = getSql();
    const rows = await db<ToolApprovalRow[]>`
      update tool_approvals
      set
        status = 'expired',
        decision_json = ${db.json(toJson({
          decision: "expired",
          reason: "Approval timed out before the user responded.",
        }))},
        resolved_at = now()
      where id = ${input.approvalId}
        and user_id = ${input.userId}
        and environment = ${serverEnv.APP_ENV}
        and status = 'pending'
      returning
        id,
        status,
        run_id,
        session_id,
        user_id,
        tool_call_id,
        tool_name,
        risk,
        reason,
        request_json,
        decision_json,
        created_at,
        resolved_at
    `;

    return rows[0] ? toToolApproval(rows[0]) : (
      await this.getToolApprovalForUser({
        approvalId: input.approvalId,
        userId: input.userId,
      })
    ) ?? {
      id: input.approvalId,
      status: "expired",
      runId: "",
      sessionId: "",
      userId: input.userId,
      toolCallId: "",
      toolName: "",
      risk: "write",
      reason: "Approval timed out before the user responded.",
      request: {},
      decision: { decision: "expired" },
      createdAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
    };
  }
}

export const sessionRepository = new SessionRepository();
