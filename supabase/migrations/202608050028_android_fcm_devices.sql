-- Native Android notification registrations. A device is always rebound to the
-- currently authenticated user, preventing tokens from leaking across tenants
-- when staff accounts are switched on the same cashier device.

create table if not exists public.native_push_devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  installation_id uuid not null unique,
  platform text not null default 'ANDROID' check (platform in ('ANDROID')),
  push_token text not null unique check (char_length(push_token) between 20 and 4096),
  device_label text,
  app_version text,
  active boolean not null default true,
  failure_count integer not null default 0 check (failure_count >= 0),
  last_seen_at timestamptz not null default now(),
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists native_push_devices_recipient_idx
  on public.native_push_devices(tenant_id,user_id,active);

alter table public.native_push_devices enable row level security;
revoke all on table public.native_push_devices from public,anon,authenticated;
grant select,insert,update,delete on table public.native_push_devices to service_role;

comment on table public.native_push_devices is
  'Private FCM registrations. The API binds each installation to the authenticated user and tenant.';
