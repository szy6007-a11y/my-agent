alter table sessions
add column if not exists parent_session_id text references sessions(id) on delete set null;
--> statement-breakpoint
alter table sessions
add column if not exists ended_at timestamptz;
--> statement-breakpoint
alter table sessions
add column if not exists end_reason text;
--> statement-breakpoint
create index if not exists sessions_parent_idx
on sessions(parent_session_id);
