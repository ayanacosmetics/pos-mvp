-- Allow the same staff account to continue a PO inspection on a new device.
-- Claiming from the new device replaces the old client token atomically, so
-- the old device immediately loses write access and concurrent edits remain
-- impossible.

begin;

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

  -- A different staff account remains locked out. The same account may move
  -- the work to another device; the token replacement below revokes the old
  -- device before this transaction completes.
  if v_draft.claimed_by is not null
    and v_draft.claim_expires_at>now()
    and v_draft.claimed_by is distinct from p_actor_id then
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
  if v_draft.claimed_by is distinct from p_actor_id then
    raise exception 'Pemeriksaan telah dibuka oleh staff lain. Muat ulang Pesanan supplier.';
  end if;
  if v_draft.claim_token is distinct from p_client_token then
    raise exception 'Pemeriksaan telah dipindahkan ke perangkat lain. Muat ulang Pesanan supplier.';
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

revoke all on function public.claim_purchase_receipt_draft_v1(uuid,uuid,uuid,uuid,jsonb)
  from public,anon,authenticated;
revoke all on function public.save_purchase_receipt_draft_v1(uuid,uuid,uuid,uuid,jsonb,boolean)
  from public,anon,authenticated;
grant execute on function public.claim_purchase_receipt_draft_v1(uuid,uuid,uuid,uuid,jsonb)
  to service_role;
grant execute on function public.save_purchase_receipt_draft_v1(uuid,uuid,uuid,uuid,jsonb,boolean)
  to service_role;

commit;
