-- Keep the daily quota ledger server-only.
-- Quota mutations are performed by the API Worker through service-role RPC calls;
-- browser roles must never read or write the underlying event ledger directly.

alter table if exists public.daily_quota_events enable row level security;

revoke all on table public.daily_quota_events from anon, authenticated;
grant all on table public.daily_quota_events to service_role;

drop policy if exists service_role_only_daily_quota_events on public.daily_quota_events;
create policy service_role_only_daily_quota_events
  on public.daily_quota_events
  for all
  to service_role
  using (true)
  with check (true);
