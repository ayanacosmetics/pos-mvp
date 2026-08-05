-- Durable in-app notifications and per-device Web Push subscriptions.
-- Notification delivery is best-effort; business transactions remain the
-- source of truth and never depend on a push provider being available.

create table if not exists public.app_notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  recipient_user_id uuid not null references public.profiles(user_id) on delete cascade,
  type text not null check (type in (
    'SALE_COMPLETED','ATTENDANCE_CLOCK_IN','ATTENDANCE_CLOCK_OUT',
    'RESTOCK_APPROVAL','SYSTEM'
  )),
  severity text not null default 'INFO' check (severity in ('INFO','SUCCESS','WARNING','CRITICAL')),
  title text not null check (char_length(title) between 1 and 120),
  message text not null check (char_length(message) between 1 and 500),
  entity_type text,
  entity_id text,
  action_page text,
  data_json jsonb not null default '{}'::jsonb,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id,recipient_user_id,dedupe_key)
);

create index if not exists app_notifications_recipient_created_idx
  on public.app_notifications(tenant_id,recipient_user_id,created_at desc);
create index if not exists app_notifications_recipient_unread_idx
  on public.app_notifications(tenant_id,recipient_user_id,created_at desc)
  where read_at is null;

create table if not exists public.web_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  expiration_time numeric,
  user_agent text,
  device_label text,
  active boolean not null default true,
  failure_count integer not null default 0 check (failure_count >= 0),
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists web_push_subscriptions_recipient_idx
  on public.web_push_subscriptions(tenant_id,user_id,active);

alter table public.app_notifications enable row level security;
alter table public.web_push_subscriptions enable row level security;
revoke all on table public.app_notifications from public,anon,authenticated;
revoke all on table public.web_push_subscriptions from public,anon,authenticated;
grant select,insert,update,delete on table public.app_notifications to service_role;
grant select,insert,update,delete on table public.web_push_subscriptions to service_role;

create or replace function public.create_owner_notifications_v1(
  p_tenant_id uuid,
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
  v_rows jsonb;
begin
  if p_type not in ('SALE_COMPLETED','ATTENDANCE_CLOCK_IN','ATTENDANCE_CLOCK_OUT','RESTOCK_APPROVAL','SYSTEM') then
    raise exception 'Jenis notifikasi tidak valid';
  end if;
  if p_severity not in ('INFO','SUCCESS','WARNING','CRITICAL') then
    raise exception 'Tingkat notifikasi tidak valid';
  end if;

  with inserted as (
    insert into public.app_notifications(
      tenant_id,recipient_user_id,type,severity,title,message,
      entity_type,entity_id,action_page,data_json,dedupe_key
    )
    select p_tenant_id,p.user_id,p_type,p_severity,left(p_title,120),left(p_message,500),
      p_entity_type,p_entity_id,p_action_page,coalesce(p_data_json,'{}'::jsonb),
      case when p_dedupe_key is null then null else p_dedupe_key end
    from public.profiles p
    where p.tenant_id=p_tenant_id and p.role='OWNER' and p.active=true
    on conflict (tenant_id,recipient_user_id,dedupe_key) do nothing
    returning id,recipient_user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'recipientUserId',recipient_user_id)),'[]'::jsonb)
  into v_rows from inserted;
  return v_rows;
end;
$$;

revoke all on function public.create_owner_notifications_v1(uuid,text,text,text,text,text,text,text,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.create_owner_notifications_v1(uuid,text,text,text,text,text,text,text,jsonb,text)
  to service_role;

comment on table public.app_notifications is
  'Private per-user notification inbox. Generated only after the related business event succeeds.';
comment on table public.web_push_subscriptions is
  'Encrypted push endpoints and browser keys for devices explicitly authorized by their signed-in user.';
