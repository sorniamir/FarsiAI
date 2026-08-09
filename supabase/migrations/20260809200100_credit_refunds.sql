-- Server-only credit refunds for failed AI jobs and idempotent ledger references.

create unique index if not exists credit_ledger_reference_unique_idx
on public.credit_ledger(user_id, reason, reference_id)
where reference_id is not null;

create or replace function public.refund_credits(
  p_user_id uuid,
  p_amount integer,
  p_reason text,
  p_reference_id text default null
)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_balance integer;
begin
  if p_amount <= 0 then raise exception 'amount must be positive'; end if;

  update public.credit_wallets
  set balance = balance + p_amount, updated_at = now()
  where user_id = p_user_id
  returning balance into v_balance;

  if v_balance is null then raise exception 'wallet_not_found'; end if;

  insert into public.credit_ledger(user_id, delta, reason, reference_id)
  values (p_user_id, p_amount, p_reason, p_reference_id);

  return v_balance;
end;
$$;

revoke all on function public.refund_credits(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.refund_credits(uuid, integer, text, text) to service_role;
