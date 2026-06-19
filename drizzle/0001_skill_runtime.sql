create table if not exists installed_skills (
  id text primary key,
  environment text not null,
  user_id text not null,
  scope text not null default 'user',
  name text not null,
  slug text not null,
  description text not null default '',
  source_type text not null,
  source_url text not null,
  github_owner text not null default '',
  github_repo text not null default '',
  github_path text not null default '',
  requested_ref text not null default '',
  commit_sha text not null,
  active_version_id text,
  trust_level text not null default 'community',
  status text not null default 'quarantined',
  enabled boolean not null default false,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz
);
--> statement-breakpoint
create table if not exists skill_versions (
  id text primary key,
  skill_id text not null references installed_skills(id) on delete cascade,
  version_number integer not null,
  commit_sha text not null,
  content_hash text not null,
  install_dir text not null,
  manifest_json jsonb not null default '{}'::jsonb,
  frontmatter_json jsonb not null default '{}'::jsonb,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
--> statement-breakpoint
create table if not exists skill_files (
  id bigserial primary key,
  version_id text not null references skill_versions(id) on delete cascade,
  path text not null,
  kind text not null,
  size_bytes integer not null,
  sha256 text not null,
  mime text not null,
  storage_path text not null
);
--> statement-breakpoint
create table if not exists skill_permissions (
  id text primary key,
  environment text not null,
  user_id text not null,
  skill_id text references installed_skills(id) on delete cascade,
  scope text not null,
  source_pattern text,
  status text not null,
  policy_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
--> statement-breakpoint
create table if not exists skill_audit_events (
  id bigserial primary key,
  environment text not null,
  user_id text not null,
  skill_id text references installed_skills(id) on delete set null,
  run_id text,
  event_type text not null,
  payload_json jsonb not null,
  created_at timestamptz not null default now()
);
--> statement-breakpoint
create index if not exists installed_skills_env_user_status_idx
on installed_skills(environment, user_id, status, updated_at desc);
--> statement-breakpoint
create index if not exists installed_skills_env_user_slug_idx
on installed_skills(environment, user_id, slug);
--> statement-breakpoint
create index if not exists skill_versions_skill_created_idx
on skill_versions(skill_id, created_at desc);
--> statement-breakpoint
create index if not exists skill_files_version_path_idx
on skill_files(version_id, path);
--> statement-breakpoint
create index if not exists skill_permissions_env_user_status_idx
on skill_permissions(environment, user_id, status);
--> statement-breakpoint
create index if not exists skill_audit_events_env_user_created_idx
on skill_audit_events(environment, user_id, created_at desc);
--> statement-breakpoint
create index if not exists skill_audit_events_skill_created_idx
on skill_audit_events(skill_id, created_at desc);
