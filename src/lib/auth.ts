import { randomBytes, randomUUID, timingSafeEqual, createHmac } from "crypto";
import type { NextRequest, NextResponse } from "next/server";

import { getSql } from "@/lib/db";
import { serverEnv } from "@/lib/env";

const SESSION_TOKEN_BYTES = 32;
const LOGIN_WINDOW_MINUTES = 10;
const MAX_FAILED_LOGIN_ATTEMPTS = 8;

type AuthUserRow = {
  id: string;
  environment: "dev" | "sit" | "prod";
  display_name: string | null;
  created_at: Date;
  last_seen_at: Date | null;
};

type AuthSessionRow = AuthUserRow & {
  session_id: string;
  expires_at: Date;
};

export type AuthUser = {
  id: string;
  environment: "dev" | "sit" | "prod";
  displayName: string | null;
  createdAt: string;
  lastSeenAt: string | null;
};

export type AuthContext = {
  expiresAt: Date;
  sessionId: string;
  user: AuthUser;
};

let schemaPromise: Promise<void> | null = null;

function authCookieName() {
  return `my-agent-session-${serverEnv.APP_ENV}`;
}

function requireAuthSecret() {
  if (!serverEnv.APP_SESSION_SECRET) {
    throw new Error("APP_SESSION_SECRET is required for beta-code auth");
  }

  return serverEnv.APP_SESSION_SECRET;
}

function authSessionTtlMs() {
  return serverEnv.AUTH_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
}

function hashValue(kind: "invite" | "session", value: string) {
  return createHmac("sha256", requireAuthSecret())
    .update(`${serverEnv.APP_ENV}:${kind}:${value}`)
    .digest("hex");
}

function timingSafeHexEqual(a: string, b: string) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");

  return left.length === right.length && timingSafeEqual(left, right);
}

function configuredInviteHashes() {
  return (serverEnv.BETA_INVITE_CODES ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean)
    .map((code) => hashValue("invite", code));
}

function toAuthUser(row: AuthUserRow): AuthUser {
  return {
    id: row.id,
    environment: row.environment,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
  };
}

async function ensureAuthSchema() {
  const db = getSql();

  await db`
    create table if not exists beta_users (
      id text primary key,
      environment text not null,
      invite_code_hash text not null,
      display_name text,
      status text not null default 'active',
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      unique (environment, invite_code_hash)
    )
  `;

  await db`
    create table if not exists auth_sessions (
      id text primary key,
      environment text not null,
      user_id text not null references beta_users(id) on delete cascade,
      token_hash text not null,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      revoked_at timestamptz,
      user_agent text,
      unique (environment, token_hash)
    )
  `;

  await db`
    create table if not exists auth_login_attempts (
      id bigserial primary key,
      environment text not null,
      bucket text not null,
      success boolean not null,
      attempted_at timestamptz not null default now()
    )
  `;

  await db`
    create index if not exists auth_sessions_environment_token_idx
    on auth_sessions(environment, token_hash)
  `;

  await db`
    create index if not exists auth_sessions_user_active_idx
    on auth_sessions(environment, user_id, expires_at)
    where revoked_at is null
  `;

  await db`
    create index if not exists auth_login_attempts_bucket_idx
    on auth_login_attempts(environment, bucket, attempted_at desc)
  `;
}

async function ready() {
  schemaPromise ??= ensureAuthSchema();
  await schemaPromise;
}

async function failedAttemptsInWindow(bucket: string) {
  await ready();
  const db = getSql();
  const rows = await db<{ count: number }[]>`
    select count(*)::int as count
    from auth_login_attempts
    where environment = ${serverEnv.APP_ENV}
      and bucket = ${bucket}
      and success = false
      and attempted_at > now() - (${LOGIN_WINDOW_MINUTES} || ' minutes')::interval
  `;

  return rows[0]?.count ?? 0;
}

async function recordLoginAttempt(bucket: string, success: boolean) {
  await ready();
  const db = getSql();

  await db`
    insert into auth_login_attempts (environment, bucket, success)
    values (${serverEnv.APP_ENV}, ${bucket}, ${success})
  `;
}

export function getClientBucket(request: NextRequest) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.headers.get("x-real-ip") || "unknown";
}

export function isAuthConfigured() {
  return Boolean(serverEnv.APP_SESSION_SECRET && serverEnv.BETA_INVITE_CODES);
}

export function getAuthEnvironment() {
  return serverEnv.APP_ENV;
}

export function applyAuthCookie(
  response: NextResponse,
  token: string,
  expiresAt: Date,
) {
  response.cookies.set(authCookieName(), token, {
    expires: expiresAt,
    httpOnly: true,
    maxAge: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    path: "/",
    sameSite: "lax",
    secure: serverEnv.APP_ENV !== "dev",
  });
}

export function clearAuthCookie(response: NextResponse) {
  response.cookies.set(authCookieName(), "", {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax",
    secure: serverEnv.APP_ENV !== "dev",
  });
}

export async function signInWithInviteCode(input: {
  code: string;
  displayName?: string | null;
  loginBucket: string;
  userAgent?: string | null;
}) {
  if (!isAuthConfigured()) {
    return {
      error: "内测登录尚未配置",
      status: 503,
    } as const;
  }

  if ((await failedAttemptsInWindow(input.loginBucket)) >= MAX_FAILED_LOGIN_ATTEMPTS) {
    return {
      error: "尝试次数过多，请稍后再试",
      status: 429,
    } as const;
  }

  const candidateHash = hashValue("invite", input.code.trim());
  const hasMatchingInviteCode = configuredInviteHashes().some((allowedHash) =>
    timingSafeHexEqual(candidateHash, allowedHash),
  );

  if (!hasMatchingInviteCode) {
    await recordLoginAttempt(input.loginBucket, false);
    return {
      error: "内测码无效",
      status: 401,
    } as const;
  }

  await recordLoginAttempt(input.loginBucket, true);

  const db = getSql();
  const displayName = input.displayName?.trim() || null;
  const users = await db<AuthUserRow[]>`
    insert into beta_users (
      id,
      environment,
      invite_code_hash,
      display_name,
      last_seen_at
    )
    values (
      ${`usr_${randomUUID()}`},
      ${serverEnv.APP_ENV},
      ${candidateHash},
      ${displayName},
      now()
    )
    on conflict (environment, invite_code_hash)
    do update set
      display_name = coalesce(${displayName}, beta_users.display_name),
      last_seen_at = now()
    returning id, environment, display_name, created_at, last_seen_at
  `;

  const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const tokenHash = hashValue("session", token);
  const expiresAt = new Date(Date.now() + authSessionTtlMs());
  const sessionId = `auth_${randomUUID()}`;

  await db`
    insert into auth_sessions (
      id,
      environment,
      user_id,
      token_hash,
      expires_at,
      user_agent
    )
    values (
      ${sessionId},
      ${serverEnv.APP_ENV},
      ${users[0].id},
      ${tokenHash},
      ${expiresAt},
      ${input.userAgent ?? null}
    )
  `;

  return {
    expiresAt,
    sessionId,
    token,
    user: toAuthUser(users[0]),
  } as const;
}

export async function getAuthenticatedUser(
  request: NextRequest,
): Promise<AuthContext | null> {
  if (!isAuthConfigured()) {
    return null;
  }

  const token = request.cookies.get(authCookieName())?.value;

  if (!token) {
    return null;
  }

  await ready();
  const db = getSql();
  const tokenHash = hashValue("session", token);
  const rows = await db<AuthSessionRow[]>`
    select
      u.id,
      u.environment,
      u.display_name,
      u.created_at,
      u.last_seen_at,
      s.id as session_id,
      s.expires_at
    from auth_sessions s
    join beta_users u on u.id = s.user_id
    where s.environment = ${serverEnv.APP_ENV}
      and u.environment = ${serverEnv.APP_ENV}
      and s.token_hash = ${tokenHash}
      and s.revoked_at is null
      and s.expires_at > now()
      and u.status = 'active'
    limit 1
  `;

  const row = rows[0];

  if (!row) {
    return null;
  }

  await db`
    update auth_sessions
    set last_seen_at = now()
    where id = ${row.session_id}
      and environment = ${serverEnv.APP_ENV}
  `;

  await db`
    update beta_users
    set last_seen_at = now()
    where id = ${row.id}
      and environment = ${serverEnv.APP_ENV}
  `;

  return {
    expiresAt: row.expires_at,
    sessionId: row.session_id,
    user: toAuthUser(row),
  };
}

export async function revokeAuthenticatedSession(request: NextRequest) {
  const token = request.cookies.get(authCookieName())?.value;

  if (!token || !serverEnv.APP_SESSION_SECRET) {
    return;
  }

  await ready();
  const db = getSql();

  await db`
    update auth_sessions
    set revoked_at = now()
    where environment = ${serverEnv.APP_ENV}
      and token_hash = ${hashValue("session", token)}
      and revoked_at is null
  `;
}
