-- Midtrans QRIS Sandbox foundation.
-- This migration stores technical simulations only. It deliberately has no
-- foreign key to sales and no function that can mutate stock or accounting.

create table if not exists public.payment_gateway_intents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  outlet_id uuid references public.outlets(id) on delete set null,
  cashier_id uuid references public.profiles(user_id) on delete set null,
  provider text not null default 'MIDTRANS' check (provider in ('MIDTRANS')),
  environment text not null check (environment in ('SANDBOX','PRODUCTION')),
  channel text not null check (channel in ('QRIS_DYNAMIC')),
  order_id text not null,
  gateway_transaction_id text,
  gross_amount bigint not null check (gross_amount between 1 and 1000000000),
  currency text not null default 'IDR' check (currency='IDR'),
  status text not null default 'CREATING' check (status in (
    'CREATING','PENDING','SETTLEMENT','EXPIRED','DENIED','CANCELLED','ERROR'
  )),
  qr_url text,
  gateway_status_code text,
  gateway_status_message text,
  last_gateway_payload jsonb not null default '{}'::jsonb,
  failure_code text,
  failure_message text,
  expires_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider,environment,order_id)
);

create index if not exists payment_gateway_intents_tenant_created_idx
  on public.payment_gateway_intents(tenant_id,created_at desc);
create index if not exists payment_gateway_intents_status_idx
  on public.payment_gateway_intents(provider,environment,status,updated_at);

create table if not exists public.payment_gateway_events (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null references public.payment_gateway_intents(id) on delete cascade,
  source text not null check (source in ('CHARGE','WEBHOOK','STATUS_CHECK','SYSTEM')),
  event_status text,
  signature_verified boolean,
  payload_hash text not null,
  sanitized_payload jsonb not null default '{}'::jsonb,
  processing_result text not null,
  created_at timestamptz not null default now()
);

create index if not exists payment_gateway_events_intent_created_idx
  on public.payment_gateway_events(intent_id,created_at desc);

alter table public.payment_gateway_intents enable row level security;
alter table public.payment_gateway_events enable row level security;

revoke all on table public.payment_gateway_intents from public,anon,authenticated;
revoke all on table public.payment_gateway_events from public,anon,authenticated;
grant select,insert,update,delete on table public.payment_gateway_intents to service_role;
grant select,insert on table public.payment_gateway_events to service_role;

comment on table public.payment_gateway_intents is
  'Payment gateway technical intents. SANDBOX rows never create sales or stock movements.';
comment on table public.payment_gateway_events is
  'Append-only sanitized gateway event audit without credentials or customer data.';
