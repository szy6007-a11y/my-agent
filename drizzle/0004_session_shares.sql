create table if not exists "session_share_tokens" (
  "id" text primary key,
  "environment" text not null,
  "user_id" text not null,
  "session_id" text not null references "sessions"("id") on delete cascade,
  "up_to_message_id" text not null references "messages"("id") on delete cascade,
  "token" text not null,
  "created_at" timestamp with time zone not null default now(),
  "revoked_at" timestamp with time zone
);

create unique index if not exists "session_share_tokens_token_idx"
  on "session_share_tokens" ("token");

create index if not exists "session_share_tokens_env_user_session_idx"
  on "session_share_tokens" ("environment", "user_id", "session_id", "created_at" desc);
