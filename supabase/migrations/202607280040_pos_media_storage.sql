-- Kasir Nusa POS v2.6.1 - direct gallery uploads for product photos

insert into storage.buckets(
  id,name,public,file_size_limit,allowed_mime_types
) values(
  'pos-media','pos-media',true,1048576,
  array['image/jpeg','image/png','image/webp']
)
on conflict(id) do update set
  public=true,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;
