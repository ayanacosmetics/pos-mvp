-- Midtrans accounts belong to each tenant. Credentials are encrypted by the
-- application before they reach Postgres; the encryption master key exists
-- only as a Cloudflare Worker secret.

create table if not exists public.payment_gateway_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null default 'MIDTRANS' check (provider in ('MIDTRANS')),
  environment text not null check (environment in ('SANDBOX','PRODUCTION')),
  status text not null default 'CONFIGURED' check (status in ('CONFIGURED','VERIFIED','DISABLED')),
  merchant_id text,
  server_key_ciphertext text,
  server_key_iv text,
  encryption_key_version integer not null default 1 check (encryption_key_version > 0),
  configured_by uuid references public.profiles(user_id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,provider,environment),
  check (
    status='DISABLED'
    or (server_key_ciphertext is not null and server_key_iv is not null)
  )
);

create index if not exists payment_gateway_accounts_tenant_idx
  on public.payment_gateway_accounts(tenant_id,provider,environment,status);

alter table public.payment_gateway_accounts enable row level security;
revoke all on table public.payment_gateway_accounts from public,anon,authenticated;
grant select,insert,update,delete on table public.payment_gateway_accounts to service_role;

alter table public.payment_gateway_intents
  add column if not exists gateway_account_id uuid
  references public.payment_gateway_accounts(id) on delete restrict;

create index if not exists payment_gateway_intents_account_created_idx
  on public.payment_gateway_intents(gateway_account_id,created_at desc);

comment on table public.payment_gateway_accounts is
  'Tenant-owned payment account metadata and application-encrypted credentials. Never expose ciphertext through tenant APIs or backups.';
comment on column public.payment_gateway_accounts.server_key_ciphertext is
  'AES-256-GCM ciphertext. The master key is stored only in the Worker secret PAYMENT_CREDENTIALS_MASTER_KEY.';
