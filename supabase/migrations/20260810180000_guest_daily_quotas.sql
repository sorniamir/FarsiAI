-- Persistent guest quotas: 5 chat messages and 2 images per UTC day.

create table if not exists public.guest_daily_usage (
  actor_key text not null,
  usage_date date not null default (now() at time zone 'utc')::date,
  chat_used integer not null default 0 check (chat_used between 0 and 5),
  image_used integer not null default 0 check (image_used between 0 and 2),
  updated_at timestamptz not null default now(),
  primary key (actor_key, usage_date)
);

create table if not exists public.guest_daily_quota_events (
  id uuid primary key default gen_random_uuid(),
  actor_key text not null,
  usage_date date not null,
  mode text not null check (mode in ('chat', 'image')),
  reference_id text not null,
  refunded boolean not null default false,
  created_at timestamptz not null default now(),
  unique (actor_key, reference_id)
);

alter table public.guest_daily_usage enable row level security;
alter table public.guest_daily_quota_events enable row level security;
revoke all on public.guest_daily_usage from anon, authenticated;
revoke all on public.guest_daily_quota_events from anon, authenticated;

create or replace function public.use_guest_daily_quota(
  p_actor_key text,
  p_mode text,
  p_reference_id text
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_usage public.guest_daily_usage%rowtype;
  v_inserted uuid;
begin
  if nullif(trim(p_actor_key), '') is null then raise exception 'actor_required'; end if;
  if p_mode not in ('chat', 'image') then raise exception 'invalid_quota_mode'; end if;
  if nullif(trim(p_reference_id), '') is null then raise exception 'reference_required'; end if;

  insert into public.guest_daily_quota_events(actor_key, usage_date, mode, reference_id)
  values (p_actor_key, v_day, p_mode, p_reference_id)
  on conflict (actor_key, reference_id) do nothing
  returning id into v_inserted;

  insert into public.guest_daily_usage(actor_key, usage_date)
  values (p_actor_key, v_day)
  on conflict (actor_key, usage_date) do nothing;

  if v_inserted is null then
    select * into v_usage from public.guest_daily_usage where actor_key = p_actor_key and usage_date = v_day;
  elsif p_mode = 'chat' then
    update public.guest_daily_usage
    set chat_used = chat_used + 1, updated_at = now()
    where actor_key = p_actor_key and usage_date = v_day and chat_used < 5
    returning * into v_usage;
    if v_usage.actor_key is null then raise exception 'daily_chat_limit'; end if;
  else
    update public.guest_daily_usage
    set image_used = image_used + 1, updated_at = now()
    where actor_key = p_actor_key and usage_date = v_day and image_used < 2
    returning * into v_usage;
    if v_usage.actor_key is null then raise exception 'daily_image_limit'; end if;
  end if;

  return jsonb_build_object(
    'chatRemaining', 5 - v_usage.chat_used,
    'imageRemaining', 2 - v_usage.image_used,
    'resetsAt', ((v_day + 1)::timestamp at time zone 'utc')
  );
end;
$$;

create or replace function public.refund_guest_daily_quota(
  p_actor_key text,
  p_reference_id text
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_event public.guest_daily_quota_events%rowtype;
  v_usage public.guest_daily_usage%rowtype;
begin
  update public.guest_daily_quota_events
  set refunded = true
  where actor_key = p_actor_key and reference_id = p_reference_id and refunded = false
  returning * into v_event;

  if v_event.id is not null then
    update public.guest_daily_usage
    set
      chat_used = greatest(0, chat_used - case when v_event.mode = 'chat' then 1 else 0 end),
      image_used = greatest(0, image_used - case when v_event.mode = 'image' then 1 else 0 end),
      updated_at = now()
    where actor_key = p_actor_key and usage_date = v_event.usage_date;
  end if;

  insert into public.guest_daily_usage(actor_key, usage_date)
  values (p_actor_key, (now() at time zone 'utc')::date)
  on conflict (actor_key, usage_date) do nothing;

  select * into v_usage from public.guest_daily_usage
  where actor_key = p_actor_key and usage_date = (now() at time zone 'utc')::date;

  return jsonb_build_object(
    'chatRemaining', 5 - v_usage.chat_used,
    'imageRemaining', 2 - v_usage.image_used,
    'resetsAt', (((now() at time zone 'utc')::date + 1)::timestamp at time zone 'utc')
  );
end;
$$;

revoke all on function public.use_guest_daily_quota(text, text, text) from public, anon, authenticated;
revoke all on function public.refund_guest_daily_quota(text, text) from public, anon, authenticated;
grant execute on function public.use_guest_daily_quota(text, text, text) to service_role;
grant execute on function public.refund_guest_daily_quota(text, text) to service_role;
