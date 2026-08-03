-- Return a restock price request to its requester without losing its audit trail.
begin;

alter table public.restock_approval_requests
  drop constraint if exists restock_approval_requests_status_check;
alter table public.restock_approval_requests
  add constraint restock_approval_requests_status_check
  check(status in('PENDING','REVISION_REQUIRED','APPROVED','REJECTED','RECEIVED','CANCELLED'));

alter table public.restock_approval_requests
  add column if not exists revision_history_json jsonb not null default '[]'::jsonb
  check(jsonb_typeof(revision_history_json)='array');

drop index if exists public.restock_approval_active_document_idx;
create unique index restock_approval_active_document_idx
  on public.restock_approval_requests(tenant_id,supplier_id,document_no)
  where status in('PENDING','REVISION_REQUIRED','APPROVED');

create or replace function public.decide_restock_approval_v1(
  p_tenant_id uuid,p_actor_id uuid,p_request_id uuid,p_decision text,
  p_approved_prices jsonb default '[]'::jsonb,p_note text default ''
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_request restock_approval_requests%rowtype;v_decision text:=upper(trim(p_decision));v_price jsonb;v_status text;
begin
  if not exists(select 1 from profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role in('OWNER','ADMIN')) then raise exception 'Hanya Owner/Admin yang dapat memutuskan';end if;
  select * into v_request from restock_approval_requests where tenant_id=p_tenant_id and id=p_request_id for update;
  if not found then raise exception 'Permintaan tidak ditemukan';end if;
  if v_request.status<>'PENDING' then raise exception 'Permintaan tidak sedang menunggu keputusan';end if;
  if v_request.requester_id=p_actor_id then raise exception 'Pemohon tidak dapat memutuskan permintaannya sendiri';end if;
  if v_decision='APPROVE' then
    if jsonb_typeof(p_approved_prices)<>'array' then raise exception 'Harga persetujuan tidak valid';end if;
    for v_price in select value from jsonb_array_elements(p_approved_prices) loop
      if coalesce((v_price->>'minBaseQty')::integer,0)<1 or coalesce((v_price->>'unitPriceBase')::numeric,0)<=0 then raise exception 'Harga jual harus lebih dari nol';end if;
    end loop;
    update restock_approval_requests set status='APPROVED',approver_id=p_actor_id,approved_prices_json=p_approved_prices,
      decision_note=nullif(trim(p_note),''),decided_at=now(),updated_at=now() where id=p_request_id;
    v_status:='APPROVED';
  elsif v_decision='REJECT' then
    update restock_approval_requests set status='REJECTED',approver_id=p_actor_id,decision_note=nullif(trim(p_note),''),decided_at=now(),updated_at=now() where id=p_request_id;
    v_status:='REJECTED';
  elsif v_decision='REVISE' then
    if nullif(trim(p_note),'') is null then raise exception 'Alasan revisi wajib diisi';end if;
    update restock_approval_requests set status='REVISION_REQUIRED',approver_id=p_actor_id,decision_note=trim(p_note),decided_at=now(),updated_at=now(),
      revision_history_json=revision_history_json||jsonb_build_array(jsonb_build_object('action','REVISION_REQUESTED','actorId',p_actor_id,'note',trim(p_note),'at',now()))
      where id=p_request_id;
    v_status:='REVISION_REQUIRED';
  else raise exception 'Keputusan tidak valid';end if;
  insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'RESTOCK_PRICE_APPROVAL_DECIDED','restock_approval',p_request_id,jsonb_build_object('decision',v_decision,'note',nullif(trim(p_note),'')));
  return jsonb_build_object('id',p_request_id,'status',v_status);
end $$;

create or replace function public.resubmit_restock_approval_v1(
  p_tenant_id uuid,p_actor_id uuid,p_request_id uuid,p_items jsonb,p_note text default ''
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_request restock_approval_requests%rowtype;v_item jsonb;
begin
  select * into v_request from restock_approval_requests where tenant_id=p_tenant_id and id=p_request_id for update;
  if not found then raise exception 'Permintaan tidak ditemukan';end if;
  if v_request.requester_id<>p_actor_id then raise exception 'Hanya pengaju semula yang dapat mengirim revisi';end if;
  if v_request.status<>'REVISION_REQUIRED' then raise exception 'Permintaan tidak memerlukan revisi';end if;
  if not public.profile_can_receive_purchase_v1(p_tenant_id,p_actor_id) then raise exception 'Akun tidak memiliki hak mengajukan penerimaan';end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Daftar barang revisi tidak valid';end if;
  if jsonb_array_length(p_items)<>jsonb_array_length(v_request.items_json) then raise exception 'Jumlah baris pengajuan tidak boleh berubah saat revisi';end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if coalesce((v_item->>'baseQty')::numeric,0)<=0 then raise exception 'Jumlah barang harus lebih dari nol';end if;
    if coalesce((v_item->>'unitCost')::numeric,-1)<0 then raise exception 'Modal barang tidak valid';end if;
  end loop;
  update restock_approval_requests set items_json=p_items,status='PENDING',approver_id=null,approved_prices_json=null,
    requester_note=coalesce(nullif(trim(p_note),''),requester_note),decision_note=null,decided_at=null,updated_at=now(),
    revision_history_json=revision_history_json||jsonb_build_array(jsonb_build_object('action','REVISION_RESUBMITTED','actorId',p_actor_id,'note',nullif(trim(p_note),''),'at',now()))
    where id=p_request_id;
  insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'RESTOCK_PRICE_APPROVAL_RESUBMITTED','restock_approval',p_request_id,jsonb_build_object('itemCount',jsonb_array_length(p_items)));
  return jsonb_build_object('id',p_request_id,'status','PENDING');
end $$;

revoke all on function public.resubmit_restock_approval_v1(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.resubmit_restock_approval_v1(uuid,uuid,uuid,jsonb,text) to service_role;

commit;
