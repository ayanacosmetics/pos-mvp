-- Global Supabase Storage usage for the private Platform Admin dashboard.
begin;

create or replace function public.platform_storage_snapshot_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path=public,storage
as $$
declare
  v_total_bytes bigint:=0;
  v_total_files bigint:=0;
  v_attendance_bytes bigint:=0;
  v_attendance_files bigint:=0;
  v_media_bytes bigint:=0;
  v_media_files bigint:=0;
begin
  select
    count(*)::bigint,
    coalesce(sum(case when coalesce(metadata->>'size','')~'^\d+$' then (metadata->>'size')::bigint else 0 end),0)::bigint
  into v_total_files,v_total_bytes
  from storage.objects;

  select
    count(*)::bigint,
    coalesce(sum(case when coalesce(metadata->>'size','')~'^\d+$' then (metadata->>'size')::bigint else 0 end),0)::bigint
  into v_attendance_files,v_attendance_bytes
  from storage.objects
  where bucket_id='attendance-media';

  select
    count(*)::bigint,
    coalesce(sum(case when coalesce(metadata->>'size','')~'^\d+$' then (metadata->>'size')::bigint else 0 end),0)::bigint
  into v_media_files,v_media_bytes
  from storage.objects
  where bucket_id='pos-media';

  return jsonb_build_object(
    'totalBytes',v_total_bytes,
    'totalFiles',v_total_files,
    'attendanceBytes',v_attendance_bytes,
    'attendanceFiles',v_attendance_files,
    'mediaBytes',v_media_bytes,
    'mediaFiles',v_media_files,
    'otherBytes',greatest(0,v_total_bytes-v_attendance_bytes-v_media_bytes),
    'otherFiles',greatest(0,v_total_files-v_attendance_files-v_media_files)
  );
end $$;

revoke all on function public.platform_storage_snapshot_v1() from public,anon,authenticated;
grant execute on function public.platform_storage_snapshot_v1() to service_role;

commit;
