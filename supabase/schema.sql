create extension if not exists pgcrypto;

create table if not exists public.app_users (
  id uuid primary key,
  email text not null unique,
  password_hash text not null,
  salt text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.app_sessions (
  token_hash text primary key,
  user_id uuid not null references public.app_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists app_sessions_user_id_idx
  on public.app_sessions(user_id);

create index if not exists app_sessions_expires_at_idx
  on public.app_sessions(expires_at);

create table if not exists public.user_states (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_daily_usage (
  user_id uuid not null references public.app_users(id) on delete cascade,
  usage_date date not null default current_date,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (user_id, usage_date)
);

create or replace function public.consume_ai_quota(
  p_user_id uuid,
  p_limit integer default 50
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  insert into public.ai_daily_usage (user_id, usage_date, request_count)
  values (p_user_id, current_date, 1)
  on conflict (user_id, usage_date)
  do update
    set request_count = public.ai_daily_usage.request_count + 1
    where public.ai_daily_usage.request_count < p_limit
  returning request_count into updated_count;

  return updated_count is not null and updated_count <= p_limit;
end;
$$;

alter table public.app_users enable row level security;
alter table public.app_sessions enable row level security;
alter table public.user_states enable row level security;
alter table public.ai_daily_usage enable row level security;

revoke all on public.app_users from anon, authenticated;
revoke all on public.app_sessions from anon, authenticated;
revoke all on public.user_states from anon, authenticated;
revoke all on public.ai_daily_usage from anon, authenticated;
revoke all on function public.consume_ai_quota(uuid, integer) from public, anon, authenticated;
grant execute on function public.consume_ai_quota(uuid, integer) to service_role;

-- The Vercel Function uses SUPABASE_SERVICE_ROLE_KEY and therefore bypasses RLS.
-- Never expose that key in app.js, index.html, or any VITE_/PUBLIC_ environment variable.
