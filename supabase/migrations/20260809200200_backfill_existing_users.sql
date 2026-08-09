-- Ensure users created before the product schema was deployed receive profiles and wallets.

insert into public.profiles (id, display_name)
select
  id,
  coalesce(raw_user_meta_data ->> 'display_name', split_part(email, '@', 1))
from auth.users
on conflict (id) do nothing;

insert into public.credit_wallets (user_id, balance)
select id, 150
from auth.users
on conflict (user_id) do nothing;

insert into public.credit_ledger (user_id, delta, reason)
select u.id, 150, 'welcome_credit'
from auth.users u
where not exists (
  select 1
  from public.credit_ledger l
  where l.user_id = u.id and l.reason = 'welcome_credit'
);
