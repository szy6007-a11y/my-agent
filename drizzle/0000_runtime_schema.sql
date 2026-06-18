create table if not exists beta_users (
  id text primary key,
  environment text not null,
  invite_code_hash text not null,
  login_id_hash text,
  display_name text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
--> statement-breakpoint
alter table beta_users
add column if not exists login_id_hash text;
--> statement-breakpoint
update beta_users
set login_id_hash = md5(environment || ':legacy-login:' || id)
where login_id_hash is null;
--> statement-breakpoint
alter table beta_users
alter column login_id_hash set not null;
--> statement-breakpoint
alter table beta_users
drop constraint if exists beta_users_environment_invite_code_hash_key;
--> statement-breakpoint
create unique index if not exists beta_users_environment_login_id_hash_idx
on beta_users(environment, login_id_hash);
--> statement-breakpoint
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
);
--> statement-breakpoint
update auth_sessions s
set revoked_at = now()
from beta_users u
where s.user_id = u.id
  and s.environment = u.environment
  and u.login_id_hash = md5(u.environment || ':legacy-login:' || u.id)
  and s.revoked_at is null;
--> statement-breakpoint
create table if not exists auth_login_attempts (
  id bigserial primary key,
  environment text not null,
  bucket text not null,
  success boolean not null,
  attempted_at timestamptz not null default now()
);
--> statement-breakpoint
create unique index if not exists auth_sessions_environment_token_idx
on auth_sessions(environment, token_hash);
--> statement-breakpoint
create index if not exists auth_sessions_user_active_idx
on auth_sessions(environment, user_id, expires_at)
where revoked_at is null;
--> statement-breakpoint
create index if not exists auth_login_attempts_bucket_idx
on auth_login_attempts(environment, bucket, attempted_at desc);
--> statement-breakpoint
create table if not exists sessions (
  id text primary key,
  environment text,
  user_id text not null,
  title text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  prompt_snapshot_json jsonb,
  prompt_snapshot_created_at timestamptz
);
--> statement-breakpoint
alter table sessions
add column if not exists environment text;
--> statement-breakpoint
update sessions
set environment = coalesce(nullif(current_setting('my_agent.app_env', true), ''), 'dev')
where environment is null;
--> statement-breakpoint
alter table sessions
alter column environment set not null;
--> statement-breakpoint
alter table sessions
add column if not exists prompt_snapshot_json jsonb;
--> statement-breakpoint
alter table sessions
add column if not exists prompt_snapshot_created_at timestamptz;
--> statement-breakpoint
create table if not exists messages (
  id text primary key,
  session_id text not null references sessions(id) on delete cascade,
  role text not null,
  content_json jsonb not null,
  tool_call_id text,
  tool_name text,
  token_count integer,
  created_at timestamptz not null default now()
);
--> statement-breakpoint
alter table messages
add column if not exists tool_name text;
--> statement-breakpoint
create table if not exists agent_runs (
  id text primary key,
  environment text,
  session_id text not null references sessions(id) on delete cascade,
  user_id text not null,
  status text not null,
  model text not null,
  permission_mode text not null,
  started_at timestamptz,
  ended_at timestamptz,
  error_json jsonb,
  created_at timestamptz not null default now()
);
--> statement-breakpoint
alter table agent_runs
add column if not exists environment text;
--> statement-breakpoint
update agent_runs
set environment = coalesce(nullif(current_setting('my_agent.app_env', true), ''), 'dev')
where environment is null;
--> statement-breakpoint
alter table agent_runs
alter column environment set not null;
--> statement-breakpoint
create table if not exists run_events (
  id bigserial primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  type text not null,
  payload_json jsonb not null,
  created_at timestamptz not null default now()
);
--> statement-breakpoint
create index if not exists messages_session_created_idx
on messages(session_id, created_at);
--> statement-breakpoint
create index if not exists messages_content_fts_idx
on messages using gin (
  to_tsvector('simple', coalesce(content_json->>'text', ''))
);
--> statement-breakpoint
create index if not exists run_events_run_created_idx
on run_events(run_id, created_at);
--> statement-breakpoint
create index if not exists sessions_environment_user_updated_idx
on sessions(environment, user_id, updated_at desc);
--> statement-breakpoint
create index if not exists agent_runs_environment_session_created_idx
on agent_runs(environment, session_id, created_at desc);
