-- Close an outstanding PO remainder without posting stock or pretending that
-- the missing quantities were received. Intended for exceptional cases where
-- the physical goods were already recorded through a separate direct receipt.

begin;

alter table public.purchase_orders
  drop constraint if exists purchase_orders_status_check;

alter table public.purchase_orders
  add constraint purchase_orders_status_check
  check(status in(
    'DRAFT','SUBMITTED','APPROVED','PARTIALLY_RECEIVED',
    'RECEIVED','CLOSED_PARTIAL','CANCELLED'
  ));

alter table public.purchase_orders
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by uuid references public.profiles(user_id),
  add column if not exists close_reason text;

create or replace function public.close_purchase_order_remainder_v1(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_order_id uuid,
  p_reason text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_order public.purchase_orders%rowtype;
  v_role text;
  v_ordered numeric;
  v_received numeric;
  v_remaining numeric;
  v_reason text:=btrim(coalesce(p_reason,''));
begin
  select role into v_role from public.profiles
    where tenant_id=p_tenant_id and user_id=p_actor_id and active;
  if coalesce(v_role,'') not in('OWNER','ADMIN') then
    raise exception 'Hanya Owner/Admin dapat menutup sisa Purchase Order';
  end if;
  if length(v_reason)<8 then
    raise exception 'Tuliskan alasan penutupan dan nomor faktur penerimaan Tanpa PO';
  end if;

  select * into v_order from public.purchase_orders
    where tenant_id=p_tenant_id and id=p_order_id for update;
  if not found then raise exception 'Purchase Order tidak ditemukan'; end if;
  if v_order.status<>'PARTIALLY_RECEIVED' then
    raise exception 'Hanya Purchase Order yang diterima sebagian yang dapat ditutup';
  end if;
  if exists(
    select 1 from public.restock_approval_requests
    where tenant_id=p_tenant_id and source_purchase_order_id=p_order_id
      and status in('PENDING','REVISION_REQUIRED','APPROVED')
  ) or exists(
    select 1
    from public.restock_approval_requests approval
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(approval.items_json)='array'
        then approval.items_json else '[]'::jsonb end
    ) item
    where approval.tenant_id=p_tenant_id
      and approval.status in('PENDING','REVISION_REQUIRED','APPROVED')
      and item->>'purchaseOrderId'=p_order_id::text
  ) then
    raise exception 'Selesaikan atau batalkan pengajuan penerimaan Owner terlebih dahulu';
  end if;

  select coalesce(sum(ordered_qty),0),coalesce(sum(received_qty),0)
    into v_ordered,v_received
  from public.purchase_order_items
  where tenant_id=p_tenant_id and order_id=p_order_id;
  v_remaining:=greatest(0,v_ordered-v_received);
  if v_remaining<=0 then
    raise exception 'Purchase Order tidak memiliki sisa untuk ditutup';
  end if;

  update public.purchase_orders set
    status='CLOSED_PARTIAL',closed_at=now(),closed_by=p_actor_id,
    close_reason=v_reason,updated_at=now()
  where tenant_id=p_tenant_id and id=p_order_id;

  delete from public.purchase_receipt_drafts
  where tenant_id=p_tenant_id and purchase_order_id=p_order_id;

  insert into public.audit_logs(
    tenant_id,actor_id,action,entity_type,entity_id,details_json
  ) values(
    p_tenant_id,p_actor_id,'PURCHASE_ORDER_REMAINDER_CLOSED','purchase_order',p_order_id,
    jsonb_build_object(
      'poNo',v_order.po_no,'fromStatus',v_order.status,'toStatus','CLOSED_PARTIAL',
      'orderedQty',v_ordered,'receivedQty',v_received,'closedRemainingQty',v_remaining,
      'reason',v_reason,'stockChanged',false
    )
  );

  return jsonb_build_object(
    'id',p_order_id,'po_no',v_order.po_no,'status','CLOSED_PARTIAL',
    'orderedQty',v_ordered,'receivedQty',v_received,
    'closedRemainingQty',v_remaining,'stockChanged',false
  );
end $$;

revoke all on function public.close_purchase_order_remainder_v1(uuid,uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.close_purchase_order_remainder_v1(uuid,uuid,uuid,text)
  to service_role;

commit;
