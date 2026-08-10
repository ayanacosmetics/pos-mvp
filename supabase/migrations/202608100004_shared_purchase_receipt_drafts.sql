-- Shared PO receiving drafts with an expiring exclusive editing lease.
-- Every purchasing receiver can see/resume a paused draft, while only one
-- browser may actively edit a PO at a time.

begin;

create table if not exists public.purchase_receipt_drafts(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  location_id uuid not null references public.stock_locations(id),
  payload jsonb not null default '{}'::jsonb check(jsonb_typeof(payload)='object'),
  version bigint not null default 1,
  created_by uuid not null,
  updated_by uuid not null,
  claimed_by uuid,
  claim_token uuid,
  claim_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,purchase_order_id)
);

create index if not exists purchase_receipt_drafts_location_idx
  on public.purchase_receipt_drafts(tenant_id,location_id,updated_at desc);

create or replace function public.claim_purchase_receipt_draft_v1(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_purchase_order_id uuid,
  p_client_token uuid,
  p_payload jsonb default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_order public.purchase_orders%rowtype;
  v_draft public.purchase_receipt_drafts%rowtype;
  v_claimant text;
begin
  if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'purchasing.receive') then
    raise exception 'Akun tidak memiliki izin menerima barang';
  end if;
  if p_client_token is null then raise exception 'Token pemeriksaan tidak valid'; end if;
  if p_payload is not null and jsonb_typeof(p_payload)<>'object' then
    raise exception 'Draft pemeriksaan tidak valid';
  end if;

  select * into v_order from public.purchase_orders
  where tenant_id=p_tenant_id and id=p_purchase_order_id
    and status in ('APPROVED','PARTIALLY_RECEIVED') for update;
  if not found then raise exception 'PO tidak siap diterima'; end if;

  insert into public.purchase_receipt_drafts(
    tenant_id,purchase_order_id,location_id,payload,created_by,updated_by,
    claimed_by,claim_token,claim_expires_at
  ) values(
    p_tenant_id,p_purchase_order_id,v_order.location_id,coalesce(p_payload,'{}'::jsonb),
    p_actor_id,p_actor_id,p_actor_id,p_client_token,now()+interval '3 minutes'
  ) on conflict(tenant_id,purchase_order_id) do nothing;

  select * into v_draft from public.purchase_receipt_drafts
  where tenant_id=p_tenant_id and purchase_order_id=p_purchase_order_id for update;

  if v_draft.claimed_by is not null
    and v_draft.claim_expires_at>now()
    and (v_draft.claimed_by is distinct from p_actor_id or v_draft.claim_token is distinct from p_client_token) then
    select display_name into v_claimant from public.profiles
      where tenant_id=p_tenant_id and user_id=v_draft.claimed_by;
    raise exception 'Pemeriksaan sedang dikerjakan oleh %. Coba lagi setelah pemeriksaan dijeda.',coalesce(v_claimant,'staff lain');
  end if;

  update public.purchase_receipt_drafts set
    payload=case when p_payload is null then payload else p_payload end,
    updated_by=p_actor_id,claimed_by=p_actor_id,claim_token=p_client_token,
    claim_expires_at=now()+interval '3 minutes',version=version+1,updated_at=now()
  where id=v_draft.id returning * into v_draft;

  return jsonb_build_object(
    'id',v_draft.id,'purchaseOrderId',v_draft.purchase_order_id,
    'locationId',v_draft.location_id,'payload',v_draft.payload,
    'version',v_draft.version,'claimedBy',v_draft.claimed_by,
    'claimExpiresAt',v_draft.claim_expires_at,'updatedAt',v_draft.updated_at
  );
end $$;

create or replace function public.save_purchase_receipt_draft_v1(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_purchase_order_id uuid,
  p_client_token uuid,
  p_payload jsonb,
  p_release boolean default false
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_draft public.purchase_receipt_drafts%rowtype;
begin
  if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'purchasing.receive') then
    raise exception 'Akun tidak memiliki izin menerima barang';
  end if;
  if jsonb_typeof(p_payload)<>'object' then raise exception 'Draft pemeriksaan tidak valid'; end if;

  select * into v_draft from public.purchase_receipt_drafts
  where tenant_id=p_tenant_id and purchase_order_id=p_purchase_order_id for update;
  if not found then raise exception 'Draft pemeriksaan tidak ditemukan'; end if;
  if v_draft.claimed_by is distinct from p_actor_id or v_draft.claim_token is distinct from p_client_token then
    raise exception 'Pemeriksaan telah dibuka oleh staff lain. Muat ulang Pesanan supplier.';
  end if;

  update public.purchase_receipt_drafts set
    payload=p_payload,updated_by=p_actor_id,version=version+1,updated_at=now(),
    claimed_by=case when p_release then null else p_actor_id end,
    claim_token=case when p_release then null else p_client_token end,
    claim_expires_at=case when p_release then null else now()+interval '3 minutes' end
  where id=v_draft.id returning * into v_draft;

  return jsonb_build_object(
    'id',v_draft.id,'purchaseOrderId',v_draft.purchase_order_id,
    'version',v_draft.version,'released',p_release,'updatedAt',v_draft.updated_at
  );
end $$;

create or replace function public.validate_purchase_receipt_draft_lock_v1(
  p_tenant_id uuid,p_actor_id uuid,p_purchase_order_id uuid,p_client_token uuid
) returns boolean language sql stable security definer set search_path=public as $$
  select public.profile_has_permission_v1(p_tenant_id,p_actor_id,'purchasing.receive')
    and exists(
      select 1 from public.purchase_receipt_drafts
      where tenant_id=p_tenant_id and purchase_order_id=p_purchase_order_id
        and claimed_by=p_actor_id and claim_token=p_client_token
        and claim_expires_at>now()
    )
$$;

create or replace function public.delete_purchase_receipt_draft_v1(
  p_tenant_id uuid,p_actor_id uuid,p_purchase_order_id uuid,p_client_token uuid
) returns boolean language plpgsql security definer set search_path=public as $$
declare v_draft public.purchase_receipt_drafts%rowtype;
begin
  if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'purchasing.receive') then
    raise exception 'Akun tidak memiliki izin menerima barang';
  end if;
  select * into v_draft from public.purchase_receipt_drafts
    where tenant_id=p_tenant_id and purchase_order_id=p_purchase_order_id for update;
  if not found then return false; end if;
  if v_draft.claimed_by is not null and v_draft.claim_expires_at>now()
    and (v_draft.claimed_by is distinct from p_actor_id or v_draft.claim_token is distinct from p_client_token) then
    raise exception 'Draft sedang diperiksa staff lain dan tidak dapat dibatalkan';
  end if;
  delete from public.purchase_receipt_drafts where id=v_draft.id;
  return true;
end $$;

revoke all on table public.purchase_receipt_drafts from public,anon,authenticated;
grant select,insert,update,delete on table public.purchase_receipt_drafts to service_role;
revoke all on function public.claim_purchase_receipt_draft_v1(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.save_purchase_receipt_draft_v1(uuid,uuid,uuid,uuid,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.validate_purchase_receipt_draft_lock_v1(uuid,uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.delete_purchase_receipt_draft_v1(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_purchase_receipt_draft_v1(uuid,uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.save_purchase_receipt_draft_v1(uuid,uuid,uuid,uuid,jsonb,boolean) to service_role;
grant execute on function public.validate_purchase_receipt_draft_lock_v1(uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.delete_purchase_receipt_draft_v1(uuid,uuid,uuid,uuid) to service_role;

commit;
