-- FarsiAI v0.2 database foundation
-- Run in a Supabase project SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  plan text not null default 'free' check (plan in ('free', 'pro', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance integer not null default 150 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  delta integer not null,
  reason text not null,
  reference_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'گفتگوی جدید',
  mode text not null default 'chat' check (mode in ('chat', 'image', 'mixed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text,
  image_url text,
  created_at timestamptz not null default now(),
  check (content is not null or image_url is not null)
);

create index if not exists conversations_user_updated_idx on public.conversations(user_id, updated_at desc);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id, created_at asc);
create index if not exists credit_ledger_user_created_idx on public.credit_ledger(user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.credit_wallets enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;

-- Profiles: users may read their row and only edit public-facing fields.
drop policy if exists "profiles own row" on public.profiles;
drop policy if exists "profiles own read" on public.profiles;
drop policy if exists "profiles own update" on public.profiles;
create policy "profiles own read" on public.profiles for select using (auth.uid() = id);
create policy "profiles own update" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
revoke update on public.profiles from authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;

-- Credit state is read-only from the client. Mutations happen on the server.
drop policy if exists "wallet own read" on public.credit_wallets;
create policy "wallet own read" on public.credit_wallets for select using (auth.uid() = user_id);

drop policy if exists "ledger own read" on public.credit_ledger;
create policy "ledger own read" on public.credit_ledger for select using (auth.uid() = user_id);

-- Conversation data is isolated per authenticated user.
drop policy if exists "conversations own rows" on public.conversations;
create policy "conversations own rows" on public.conversations for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "messages own rows" on public.messages;
create policy "messages own rows" on public.messages for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;

  insert into public.credit_wallets (user_id, balance)
  values (new.id, 150)
  on conflict (user_id) do nothing;

  insert into public.credit_ledger (user_id, delta, reason)
  values (new.id, 150, 'welcome_credit');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Atomic credit spending. Only the server service role may execute this RPC.
create or replace function public.spend_credits(p_user_id uuid, p_amount integer, p_reason text, p_reference_id text default null)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_balance integer;
begin
  if p_amount <= 0 then raise exception 'amount must be positive'; end if;

  update public.credit_wallets
  set balance = balance - p_amount, updated_at = now()
  where user_id = p_user_id and balance >= p_amount
  returning balance into v_balance;

  if v_balance is null then raise exception 'insufficient_credits'; end if;

  insert into public.credit_ledger(user_id, delta, reason, reference_id)
  values (p_user_id, -p_amount, p_reason, p_reference_id);

  return v_balance;
end;
$$;

revoke all on function public.spend_credits(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.spend_credits(uuid, integer, text, text) to service_role;
