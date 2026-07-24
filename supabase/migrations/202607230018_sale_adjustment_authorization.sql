-- Kasir Nusa v1.13
-- Otorisasi supervisor untuk diskon manual dan penurunan harga di POS.

create table if not exists public.sale_adjustment_authorizations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  outlet_id uuid not null references public.outlets(id),
  cashier_id uuid not null,
  approved_by uuid not null,
  basket_fingerprint text not null,
  approval_token_hash text not null,
  adjustment_json jsonb not null,
  discount_amount numeric(19,4) not null check (discount_amount > 0),
  status text not null default 'APPROVED'
    check (status in ('APPROVED','CONSUMED','EXPIRED','CANCELLED')),
  expires_at timestamptz not null,
  consumed_sale_id uuid references public.sales(id),
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  constraint sale_adjustment_authorization_expiry check (expires_at > created_at)
);

create index if not exists sale_adjustment_authorizations_cashier_idx
  on public.sale_adjustment_authorizations(tenant_id,outlet_id,cashier_id,status,expires_at desc);
create unique index if not exists sale_adjustment_authorizations_token_idx
  on public.sale_adjustment_authorizations(tenant_id,approval_token_hash);

alter table public.sale_adjustment_authorizations enable row level security;

create or replace function public.create_sale_adjustment_authorization(
  p_tenant_id uuid,
  p_outlet_id uuid,
  p_cashier_id uuid,
  p_approved_by uuid,
  p_basket_fingerprint text,
  p_approval_token_hash text,
  p_adjustment jsonb,
  p_discount_amount numeric,
  p_valid_minutes integer default 5
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_authorization public.sale_adjustment_authorizations%rowtype;
  v_approver public.profiles%rowtype;
begin
  select * into v_approver
  from public.profiles
  where tenant_id=p_tenant_id and user_id=p_approved_by and active=true
    and role in ('OWNER','ADMIN');
  if not found then raise exception 'Pemberi persetujuan bukan Owner atau Admin aktif'; end if;

  if not exists(
    select 1 from public.profiles
    where tenant_id=p_tenant_id and user_id=p_cashier_id and active=true
      and role in ('OWNER','ADMIN','CASHIER')
  ) then raise exception 'Kasir tidak aktif atau tidak memiliki akses POS'; end if;

  if not exists(
    select 1 from public.outlets where id=p_outlet_id and tenant_id=p_tenant_id and active=true
  ) then raise exception 'Outlet tidak aktif'; end if;

  if length(coalesce(p_basket_fingerprint,''))<32 or length(coalesce(p_approval_token_hash,''))<32
    then raise exception 'Identitas persetujuan tidak valid';
  end if;
  if coalesce(p_discount_amount,0)<=0 then raise exception 'Nilai diskon persetujuan harus lebih dari nol'; end if;

  update public.sale_adjustment_authorizations
  set status='EXPIRED'
  where tenant_id=p_tenant_id and cashier_id=p_cashier_id
    and status='APPROVED' and expires_at<=now();

  insert into public.sale_adjustment_authorizations(
    tenant_id,outlet_id,cashier_id,approved_by,basket_fingerprint,
    approval_token_hash,adjustment_json,discount_amount,expires_at
  ) values (
    p_tenant_id,p_outlet_id,p_cashier_id,p_approved_by,p_basket_fingerprint,
    p_approval_token_hash,p_adjustment,p_discount_amount,
    now() + make_interval(mins=>greatest(1,least(coalesce(p_valid_minutes,5),15)))
  ) returning * into v_authorization;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(
    p_tenant_id,p_approved_by,'SALE_ADJUSTMENT_APPROVED','sale_adjustment',v_authorization.id,
    jsonb_build_object(
      'cashierId',p_cashier_id,'outletId',p_outlet_id,
      'discountAmount',p_discount_amount,'adjustment',p_adjustment,
      'expiresAt',v_authorization.expires_at
    )
  );

  return jsonb_build_object(
    'id',v_authorization.id,
    'status',v_authorization.status,
    'expiresAt',v_authorization.expires_at,
    'approvedBy',v_approver.display_name,
    'discountAmount',v_authorization.discount_amount
  );
end $$;

create or replace function public.complete_sale_v4(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_idempotency_key text,
  p_outlet_id uuid,
  p_shift_id uuid,
  p_customer_id uuid,
  p_customer_group_id text,
  p_payments jsonb,
  p_quote jsonb,
  p_authorization_id uuid,
  p_basket_fingerprint text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_authorization public.sale_adjustment_authorizations%rowtype;
  v_existing public.sales%rowtype;
  v_result jsonb;
  v_sale_id uuid;
begin
  select * into v_existing
  from public.sales
  where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then
    return jsonb_build_object(
      'id',v_existing.id,'receiptNo',v_existing.receipt_no,
      'status',v_existing.status,'duplicate',true,'change',0
    );
  end if;

  if p_authorization_id is null then
    if p_quote ? 'manualAdjustment' then
      raise exception 'Diskon manual memerlukan persetujuan supervisor';
    end if;
  else
    select * into v_authorization
    from public.sale_adjustment_authorizations
    where id=p_authorization_id for update;
    if not found then raise exception 'Persetujuan diskon tidak ditemukan'; end if;
    if v_authorization.tenant_id<>p_tenant_id
      or v_authorization.outlet_id<>p_outlet_id
      or v_authorization.cashier_id<>p_actor_id
      then raise exception 'Persetujuan bukan untuk kasir atau outlet ini';
    end if;
    if v_authorization.status<>'APPROVED' then raise exception 'Persetujuan diskon sudah digunakan atau dibatalkan'; end if;
    if v_authorization.expires_at<=now() then
      update public.sale_adjustment_authorizations set status='EXPIRED' where id=p_authorization_id;
      raise exception 'Persetujuan diskon sudah kedaluwarsa; minta persetujuan baru';
    end if;
    if v_authorization.basket_fingerprint<>p_basket_fingerprint
      then raise exception 'Keranjang berubah setelah disetujui';
    end if;
    if not (p_quote ? 'manualAdjustment')
      then raise exception 'Rincian diskon manual tidak terdapat pada transaksi';
    end if;
    if abs(
      coalesce((p_quote->'manualAdjustment'->>'discountAmount')::numeric,0)
      - v_authorization.discount_amount
    )>0.01 then raise exception 'Nilai diskon berbeda dari yang disetujui'; end if;
  end if;

  v_result:=public.complete_sale_v3(
    p_tenant_id,p_actor_id,p_idempotency_key,p_outlet_id,p_shift_id,
    p_customer_id,p_customer_group_id,p_payments,p_quote
  );

  if p_authorization_id is not null then
    v_sale_id:=(v_result->>'id')::uuid;
    update public.sale_adjustment_authorizations
    set status='CONSUMED',consumed_sale_id=v_sale_id,consumed_at=now()
    where id=p_authorization_id;
    insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(
      p_tenant_id,p_actor_id,'SALE_ADJUSTMENT_CONSUMED','sale',v_sale_id,
      jsonb_build_object(
        'authorizationId',p_authorization_id,
        'approvedBy',v_authorization.approved_by,
        'discountAmount',v_authorization.discount_amount,
        'adjustment',v_authorization.adjustment_json
      )
    );
  end if;

  return v_result;
end $$;

revoke all on function public.create_sale_adjustment_authorization(uuid,uuid,uuid,uuid,text,text,jsonb,numeric,integer) from public,anon,authenticated;
revoke all on function public.complete_sale_v4(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.create_sale_adjustment_authorization(uuid,uuid,uuid,uuid,text,text,jsonb,numeric,integer) to service_role;
grant execute on function public.complete_sale_v4(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,jsonb,uuid,text) to service_role;
grant select,insert,update on public.sale_adjustment_authorizations to service_role;
