-- Commercial release hardening for privileged admin audit data and auth bootstrap trigger.
-- Keep these controls in source so future environments match the production database.

alter table if exists public.admin_audit_log enable row level security;

revoke all on table public.admin_audit_log from anon, authenticated;
grant all on table public.admin_audit_log to service_role;

drop policy if exists service_role_only_admin_audit_log on public.admin_audit_log;
create policy service_role_only_admin_audit_log
  on public.admin_audit_log
  for all
  to service_role
  using (true)
  with check (true);

-- handle_new_user is a SECURITY DEFINER trigger function. It is invoked by the
-- auth.users trigger and must not be callable directly from untrusted API roles.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to service_role;
