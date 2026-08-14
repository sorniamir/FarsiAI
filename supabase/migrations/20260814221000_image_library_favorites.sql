-- Cloud-synced favorites for generated images.
-- Messages stay immutable; favorites are modeled separately with least-privilege RLS.

create table if not exists public.image_favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

create index if not exists image_favorites_user_created_idx
  on public.image_favorites(user_id, created_at desc);

alter table public.image_favorites enable row level security;

revoke all on table public.image_favorites from anon;
revoke all on table public.image_favorites from authenticated;
grant select, insert, delete on table public.image_favorites to authenticated;
grant all on table public.image_favorites to service_role;

drop policy if exists "image favorites own read" on public.image_favorites;
drop policy if exists "image favorites own insert" on public.image_favorites;
drop policy if exists "image favorites own delete" on public.image_favorites;

create policy "image favorites own read"
on public.image_favorites
for select
to authenticated
using (auth.uid() = user_id);

create policy "image favorites own insert"
on public.image_favorites
for insert
to authenticated
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.messages m
    where m.id = message_id
      and m.user_id = auth.uid()
      and m.role = 'assistant'
      and m.image_url is not null
  )
);

create policy "image favorites own delete"
on public.image_favorites
for delete
to authenticated
using (auth.uid() = user_id);
