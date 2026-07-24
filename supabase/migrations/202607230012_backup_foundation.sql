-- Kasir Nusa POS - operational backup registry and audit foundation

create table if not exists public.backup_exports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  actor_id uuid not null references public.profiles(user_id),
  file_name text not null,
  schema_version integer not null,
  checksum_sha256 text not null check(length(checksum_sha256)=64),
  total_rows bigint not null default 0,
  row_counts jsonb not null default '{}',
  status text not null default 'COMPLETED' check(status in ('COMPLETED','FAILED')),
  created_at timestamptz not null default now()
);

alter table public.backup_exports enable row level security;
drop policy if exists tenant_isolation on public.backup_exports;
create policy tenant_isolation on public.backup_exports for select to authenticated
  using(tenant_id=public.current_tenant_id());

grant select on public.backup_exports to authenticated;
grant select,insert,update on public.backup_exports to service_role;
create index if not exists backup_exports_recent_idx on public.backup_exports(tenant_id,created_at desc);
