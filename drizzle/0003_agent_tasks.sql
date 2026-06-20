create table if not exists "agent_tasks" (
  "id" text primary key,
  "environment" text not null,
  "user_id" text not null,
  "parent_session_id" text not null references "sessions"("id") on delete cascade,
  "parent_run_id" text references "agent_runs"("id") on delete set null,
  "child_session_id" text references "sessions"("id") on delete set null,
  "child_run_id" text references "agent_runs"("id") on delete set null,
  "kind" text not null default 'task',
  "status" text not null default 'pending',
  "subject" text not null,
  "description" text not null default '',
  "active_form" text,
  "goal" text not null default '',
  "context" text not null default '',
  "role" text not null default 'leaf',
  "background" boolean not null default false,
  "toolsets_json" jsonb not null default '[]'::jsonb,
  "model" text,
  "metadata_json" jsonb not null default '{}'::jsonb,
  "result_json" jsonb,
  "error_json" jsonb,
  "created_at" timestamp with time zone not null default now(),
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone not null default now()
);

create index if not exists "agent_tasks_env_user_parent_updated_idx"
  on "agent_tasks" ("environment", "user_id", "parent_session_id", "updated_at" desc);

create index if not exists "agent_tasks_parent_run_created_idx"
  on "agent_tasks" ("parent_run_id", "created_at");

create index if not exists "agent_tasks_child_run_idx"
  on "agent_tasks" ("child_run_id");
