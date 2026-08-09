-- Harden message writes so client users cannot inject content into another user's conversation.

-- Replace broad message policy with explicit least-privilege policies.
drop policy if exists "messages own rows" on public.messages;
drop policy if exists "messages own read" on public.messages;
drop policy if exists "messages own insert" on public.messages;
drop policy if exists "messages own delete" on public.messages;

create policy "messages own read"
on public.messages
for select
using (auth.uid() = user_id);

-- Client users may only insert their own user messages into conversations they own.
-- Assistant/system messages are written by the backend secret key (service role bypasses RLS).
create policy "messages own insert"
on public.messages
for insert
with check (
  auth.uid() = user_id
  and role = 'user'
  and exists (
    select 1
    from public.conversations c
    where c.id = conversation_id
      and c.user_id = auth.uid()
  )
);

create policy "messages own delete"
on public.messages
for delete
using (auth.uid() = user_id);

-- No client UPDATE policy is intentionally created. Messages are immutable from clients.
