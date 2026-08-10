-- Separate daily quotas for authenticated users: 10 chat messages and 4 images.

create table if not exists public.daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null default (now() at time zone 'utc')::date,
  chat_used integer not null default 0 check (chat_used between 0 and 10),
  image_used integer not null default 0 check (image_used between 0 and 4),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date)
);

create table if not exists public.daily_quota_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  mode text not null check (mode in ('chat', 'image')),
  reference_id text not null,
  refunded boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, reference_id)
);

alter table public.daily_usage enable row level security;
alter table public.daily_quota_events enable row level security;

drop policy if exists "daily usage own read" on public.daily_usage;
create policy "daily usage own read" on public.daily_usage
for select using (auth.uid() = user_id);

revoke all on public.daily_quota_events from anon, authenticated;

create or replace function public.use_daily_quota(
  p_user_id uuid,
  p_mode text,
  p_reference_id text
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_usage public.daily_usage%rowtype;
  v_inserted uuid;
begin
  if p_mode not in ('chat', 'image') then raise exception 'invalid_quota_mode'; end if;
  if nullif(trim(p_reference_id), '') is null then raise exception 'reference_required'; end if;

  insert into public.daily_quota_events(user_id, usage_date, mode, reference_id)
  values (p_user_id, v_day, p_mode, p_reference_id)
  on conflict (user_id, reference_id) do nothing
  returning id into v_inserted;

  insert into public.daily_usage(user_id, usage_date)
  values (p_user_id, v_day)
  on conflict (user_id, usage_date) do nothing;

  if v_inserted is null then
    select * into v_usage from public.daily_usage where user_id = p_user_id and usage_date = v_day;
  elsif p_mode = 'chat' then
    update public.daily_usage
    set chat_used = chat_used + 1, updated_at = now()
    where user_id = p_user_id and usage_date = v_day and chat_used < 10
    returning * into v_usage;
    if v_usage.user_id is null then raise exception 'daily_chat_limit'; end if;
  else
    update public.daily_usage
    set image_used = image_used + 1, updated_at = now()
    where user_id = p_user_id and usage_date = v_day and image_used < 4
    returning * into v_usage;
    if v_usage.user_id is null then raise exception 'daily_image_limit'; end if;
  end if;

  return jsonb_build_object(
    'chatRemaining', 10 - v_usage.chat_used,
    'imageRemaining', 4 - v_usage.image_used,
    'resetsAt', ((v_day + 1)::timestamp at time zone 'utc')
  );
end;
$$;

create or replace function public.refund_daily_quota(
  p_user_id uuid,
  p_reference_id text
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_event public.daily_quota_events%rowtype;
  v_usage public.daily_usage%rowtype;
begin
  update public.daily_quota_events
  set refunded = true
  where user_id = p_user_id and reference_id = p_reference_id and refunded = false
  returning * into v_event;

  if v_event.id is not null then
    update public.daily_usage
    set
      chat_used = greatest(0, chat_used - case when v_event.mode = 'chat' then 1 else 0 end),
      image_used = greatest(0, image_used - case when v_event.mode = 'image' then 1 else 0 end),
      updated_at = now()
    where user_id = p_user_id and usage_date = v_event.usage_date;
  end if;

  insert into public.daily_usage(user_id, usage_date)
  values (p_user_id, (now() at time zone 'utc')::date)
  on conflict (user_id, usage_date) do nothing;

  select * into v_usage from public.daily_usage
  where user_id = p_user_id and usage_date = (now() at time zone 'utc')::date;

  return jsonb_build_object(
    'chatRemaining', 10 - v_usage.chat_used,
    'imageRemaining', 4 - v_usage.image_used,
    'resetsAt', (((now() at time zone 'utc')::date + 1)::timestamp at time zone 'utc')
  );
end;
$$;

revoke all on function public.use_daily_quota(uuid, text, text) from public, anon, authenticated;
revoke all on function public.refund_daily_quota(uuid, text) from public, anon, authenticated;
grant execute on function public.use_daily_quota(uuid, text, text) to service_role;
grant execute on function public.refund_daily_quota(uuid, text) to service_role;
