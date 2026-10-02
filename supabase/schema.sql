-- Job Scout storage. Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- The app talks to these tables only from the server with the service_role key,
-- so row level security is on with no public policies (nobody else can read them).

create table if not exists public.employers (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  name text not null,
  board_url text,
  board_domains text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists employers_session_idx on public.employers (session_id);

create table if not exists public.role_searches (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  role text not null,
  results jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists role_searches_session_idx on public.role_searches (session_id, created_at desc);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_session_idx on public.chat_messages (session_id, created_at);

alter table public.employers enable row level security;
alter table public.role_searches enable row level security;
alter table public.chat_messages enable row level security;
