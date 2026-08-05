-- Private restock decision notifications for the staff member who submitted
-- the request. Other staff cannot receive or read these rows.

alter table public.app_notifications
  drop constraint if exists app_notifications_type_check;
alter table public.app_notifications
  add constraint app_notifications_type_check check (type in (
    'SALE_COMPLETED','ATTENDANCE_CLOCK_IN','ATTENDANCE_CLOCK_OUT',
    'RESTOCK_APPROVAL','RESTOCK_APPROVAL_DECISION','SYSTEM'
  ));

create or replace function public.create_user_notification_v1(
  p_tenant_id uuid,
  p_recipient_user_id uuid,
  p_type text,
  p_title text,
  p_message text,
  p_severity text default 'INFO',
  p_entity_type text default null,
  p_entity_id text default null,
  p_action_page text default null,
  p_data_json jsonb default '{}'::jsonb,
  p_dedupe_key text default null
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_id uuid;
begin
  if p_type not in ('SALE_COMPLETED','ATTENDANCE_CLOCK_IN','ATTENDANCE_CLOCK_OUT','RESTOCK_APPROVAL','RESTOCK_APPROVAL_DECISION','SYSTEM') then
    raise exception 'Jenis notifikasi tidak valid';
  end if;
  if p_severity not in ('INFO','SUCCESS','WARNING','CRITICAL') then
    raise exception 'Tingkat notifikasi tidak valid';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.tenant_id=p_tenant_id and p.user_id=p_recipient_user_id and p.active=true
  ) then
    raise exception 'Penerima notifikasi tidak aktif pada usaha ini';
  end if;

  insert into public.app_notifications(
    tenant_id,recipient_user_id,type,severity,title,message,
    entity_type,entity_id,action_page,data_json,dedupe_key
  ) values (
    p_tenant_id,p_recipient_user_id,p_type,p_severity,left(p_title,120),left(p_message,500),
    p_entity_type,p_entity_id,p_action_page,coalesce(p_data_json,'{}'::jsonb),p_dedupe_key
  )
  on conflict (tenant_id,recipient_user_id,dedupe_key) do nothing
  returning id into v_id;

  if v_id is null then return '[]'::jsonb; end if;
  return jsonb_build_array(jsonb_build_object('id',v_id,'recipientUserId',p_recipient_user_id));
end;
$$;

revoke all on function public.create_user_notification_v1(uuid,uuid,text,text,text,text,text,text,text,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.create_user_notification_v1(uuid,uuid,text,text,text,text,text,text,text,jsonb,text)
  to service_role;

