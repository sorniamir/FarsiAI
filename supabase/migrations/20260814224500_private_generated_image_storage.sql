-- Private object storage for generated images.
-- New images are stored as objects instead of multi-megabyte Base64 strings in Postgres.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'generated-images',
  'generated-images',
  false,
  12582912,
  array['image/png', 'image/jpeg', 'image/webp']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Only authenticated users may read objects in their own top-level UUID folder.
drop policy if exists "generated images own read" on storage.objects;
create policy "generated images own read"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'generated-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Client-side writes are intentionally not allowed. The Worker uploads with the secret/service role.
