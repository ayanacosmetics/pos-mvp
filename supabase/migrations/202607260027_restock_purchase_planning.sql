-- Kasir Nusa POS v1.22 - restock planning and value-based purchase approval
-- This migration also applies the pending v1.21 receipt guard idempotently, so
-- production only needs this single SQL file.

create or replace function public.guard_sale_receipt_number_v1()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare v_prefix text; v_next bigint;
begin
  if not exists(select 1 from public.sales where tenant_id=new.tenant_id and receipt_no=new.receipt_no) then return new; end if;
  select receipt_prefix into v_prefix from public.outlets where id=new.outlet_id and tenant_id=new.tenant_id;
  if nullif(trim(v_prefix),'') is null then raise exception 'Awalan nomor struk outlet tidak ditemukan'; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text||':SALE:'||v_prefix,0));
  select coalesce(max(case
    when left(receipt_no,length(v_prefix)+1)=v_prefix||'-'
      and substring(receipt_no from length(v_prefix)+2) ~ '^[0-9]+$'
    then substring(receipt_no from length(v_prefix)+2)::bigint else 0 end),0)+1
  into v_next from public.sales where tenant_id=new.tenant_id;
  new.receipt_no:=v_prefix||'-'||lpad(v_next::text,6,'0');
  insert into public.document_sequences(tenant_id,kind,next_value)
  values(new.tenant_id,'SALE:'||new.outlet_id::text,v_next+1)
  on conflict(tenant_id,kind) do update
    set next_value=greatest(public.document_sequences.next_value,excluded.next_value);
  return new;
end $$;

drop trigger if exists guard_sale_receipt_number on public.sales;
create trigger guard_sale_receipt_number
before insert on public.sales
for each row execute function public.guard_sale_receipt_number_v1();

with outlet_maximums as (
  select o.tenant_id,o.id outlet_id,
    coalesce(max(case
      when left(s.receipt_no,length(o.receipt_prefix)+1)=o.receipt_prefix||'-'
        and substring(s.receipt_no from length(o.receipt_prefix)+2) ~ '^[0-9]+$'
      then substring(s.receipt_no from length(o.receipt_prefix)+2)::bigint else 0 end),0)+1 required_next
  from public.outlets o left join public.sales s on s.tenant_id=o.tenant_id
  group by o.tenant_id,o.id,o.receipt_prefix
)
insert into public.document_sequences(tenant_id,kind,next_value)
select tenant_id,'SALE:'||outlet_id::text,required_next from outlet_maximums
on conflict(tenant_id,kind) do update
  set next_value=greatest(public.document_sequences.next_value,excluded.next_value);

revoke all on function public.guard_sale_receipt_number_v1() from public,anon,authenticated;

create table if not exists public.purchase_planning_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  approval_threshold numeric(19,4) not null default 5000000 check(approval_threshold >= 0),
  default_lookback_days integer not null default 30 check(default_lookback_days between 7 and 365),
  updated_by uuid references public.profiles(user_id),
  updated_at timestamptz not null default now()
);

create table if not exists public.restock_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  location_id uuid not null references public.stock_locations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id),
  minimum_stock numeric(19,6) not null default 0 check(minimum_stock >= 0),
  maximum_stock numeric(19,6) not null default 0 check(maximum_stock >= 0),
  safety_stock numeric(19,6) not null default 0 check(safety_stock >= 0),
  lead_time_days integer not null default 7 check(lead_time_days between 0 and 365),
  preferred boolean not null default true,
  active boolean not null default true,
  updated_by uuid references public.profiles(user_id),
  updated_at timestamptz not null default now(),
  unique(tenant_id,location_id,product_id,supplier_id),
  check(maximum_stock=0 or maximum_stock >= minimum_stock)
);

create unique index if not exists one_preferred_restock_supplier
  on public.restock_policies(tenant_id,location_id,product_id)
  where preferred and active;
create index if not exists restock_policies_supplier_idx
  on public.restock_policies(tenant_id,supplier_id,location_id);

alter table public.purchase_orders
  add column if not exists approval_required boolean not null default true,
  add column if not exists approval_threshold numeric(19,4),
  add column if not exists planning_source text not null default 'MANUAL'
    check(planning_source in ('MANUAL','RESTOCK_PLAN'));

alter table public.purchase_planning_settings enable row level security;
alter table public.restock_policies enable row level security;
drop policy if exists tenant_isolation on public.purchase_planning_settings;
drop policy if exists tenant_isolation on public.restock_policies;
create policy tenant_isolation on public.purchase_planning_settings for all to authenticated
  using(tenant_id=public.current_tenant_id()) with check(tenant_id=public.current_tenant_id());
create policy tenant_isolation on public.restock_policies for all to authenticated
  using(tenant_id=public.current_tenant_id()) with check(tenant_id=public.current_tenant_id());

insert into public.purchase_planning_settings(tenant_id)
select id from public.tenants
on conflict(tenant_id) do nothing;

create or replace function public.save_purchase_planning_settings_v1(
  p_tenant_id uuid,p_actor_id uuid,p_approval_threshold numeric,p_lookback_days integer
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_role text;
begin
  select role into v_role from public.profiles
  where user_id=p_actor_id and tenant_id=p_tenant_id and active;
  if v_role is null or v_role not in ('OWNER','ADMIN') then
    raise exception 'Hanya Owner/Admin yang dapat mengubah batas persetujuan pembelian';
  end if;
  if p_approval_threshold is null or p_approval_threshold<0 then raise exception 'Batas persetujuan tidak valid'; end if;
  if p_lookback_days is null or p_lookback_days not between 7 and 365 then raise exception 'Periode analisis harus 7 sampai 365 hari'; end if;
  insert into public.purchase_planning_settings(tenant_id,approval_threshold,default_lookback_days,updated_by,updated_at)
  values(p_tenant_id,p_approval_threshold,p_lookback_days,p_actor_id,now())
  on conflict(tenant_id) do update set
    approval_threshold=excluded.approval_threshold,default_lookback_days=excluded.default_lookback_days,
    updated_by=excluded.updated_by,updated_at=now();
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,details_json)
  values(p_tenant_id,p_actor_id,'PURCHASE_PLANNING_SETTINGS_UPDATED','purchase_planning_settings',
    jsonb_build_object('approval_threshold',p_approval_threshold,'lookback_days',p_lookback_days));
  return jsonb_build_object('approvalThreshold',p_approval_threshold,'lookbackDays',p_lookback_days);
end $$;

create or replace function public.save_restock_policy_v1(
  p_tenant_id uuid,p_actor_id uuid,p_location_id uuid,p_product_id uuid,p_supplier_id uuid,
  p_minimum_stock numeric,p_maximum_stock numeric,p_safety_stock numeric,p_lead_time_days integer,
  p_preferred boolean default true
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_role text; v_id uuid;
begin
  select role into v_role from public.profiles
  where user_id=p_actor_id and tenant_id=p_tenant_id and active;
  if v_role is null or v_role not in ('OWNER','ADMIN','PURCHASING') then raise exception 'Akun tidak memiliki hak mengatur rencana restok'; end if;
  if not exists(select 1 from public.stock_locations where id=p_location_id and tenant_id=p_tenant_id and active) then raise exception 'Lokasi stok tidak valid'; end if;
  if not exists(select 1 from public.products where id=p_product_id and tenant_id=p_tenant_id and active) then raise exception 'Produk tidak valid'; end if;
  if not exists(select 1 from public.suppliers where id=p_supplier_id and tenant_id=p_tenant_id and active) then raise exception 'Supplier tidak valid'; end if;
  if least(p_minimum_stock,p_maximum_stock,p_safety_stock)<0 or p_lead_time_days not between 0 and 365 then raise exception 'Parameter stok atau lead time tidak valid'; end if;
  if p_maximum_stock>0 and p_maximum_stock<p_minimum_stock then raise exception 'Stok maksimum tidak boleh di bawah minimum'; end if;
  if coalesce(p_preferred,true) then
    update public.restock_policies set preferred=false,updated_at=now(),updated_by=p_actor_id
    where tenant_id=p_tenant_id and location_id=p_location_id and product_id=p_product_id and preferred;
  end if;
  insert into public.restock_policies(
    tenant_id,location_id,product_id,supplier_id,minimum_stock,maximum_stock,safety_stock,
    lead_time_days,preferred,active,updated_by,updated_at
  ) values (
    p_tenant_id,p_location_id,p_product_id,p_supplier_id,p_minimum_stock,p_maximum_stock,p_safety_stock,
    p_lead_time_days,coalesce(p_preferred,true),true,p_actor_id,now()
  )
  on conflict(tenant_id,location_id,product_id,supplier_id) do update set
    minimum_stock=excluded.minimum_stock,maximum_stock=excluded.maximum_stock,
    safety_stock=excluded.safety_stock,lead_time_days=excluded.lead_time_days,
    preferred=excluded.preferred,active=true,updated_by=p_actor_id,updated_at=now()
  returning id into v_id;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'RESTOCK_POLICY_SAVED','restock_policy',v_id,
    jsonb_build_object('product_id',p_product_id,'supplier_id',p_supplier_id,'location_id',p_location_id,
      'minimum_stock',p_minimum_stock,'maximum_stock',p_maximum_stock,'safety_stock',p_safety_stock,'lead_time_days',p_lead_time_days));
  return jsonb_build_object('id',v_id,'productId',p_product_id,'supplierId',p_supplier_id,'locationId',p_location_id);
end $$;

create or replace function public.get_restock_recommendations_v1(
  p_tenant_id uuid,p_location_id uuid,p_supplier_id uuid default null,p_lookback_days integer default null
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_days integer; v_outlet uuid; v_settings public.purchase_planning_settings%rowtype; v_rows jsonb;
begin
  select * into v_settings from public.purchase_planning_settings where tenant_id=p_tenant_id;
  v_days:=coalesce(p_lookback_days,v_settings.default_lookback_days,30);
  if v_days not between 7 and 365 then raise exception 'Periode analisis harus 7 sampai 365 hari'; end if;
  select outlet_id into v_outlet from public.stock_locations where id=p_location_id and tenant_id=p_tenant_id and active;
  if not found then raise exception 'Lokasi stok tidak valid'; end if;

  with sales_average as (
    select si.product_id,sum(si.base_qty)/v_days::numeric as average_daily_sales
    from public.sales s join public.sale_items si on si.sale_id=s.id
    where s.tenant_id=p_tenant_id and s.outlet_id=v_outlet and s.status='COMPLETED'
      and s.occurred_at>=now()-(v_days||' days')::interval
    group by si.product_id
  ), inbound as (
    select poi.product_id,sum(poi.ordered_qty-poi.received_qty) as on_order
    from public.purchase_orders po join public.purchase_order_items poi on poi.order_id=po.id
    where po.tenant_id=p_tenant_id and po.location_id=p_location_id
      and po.status in ('APPROVED','PARTIALLY_RECEIVED')
      and (p_supplier_id is null or po.supplier_id=p_supplier_id)
    group by poi.product_id
  ), base as (
    select p.id product_id,p.sku,p.name product_name,p.minimum_stock product_minimum,
      rp.id policy_id,rp.supplier_id,sup.name supplier_name,
      coalesce(rp.minimum_stock,p.minimum_stock,0) minimum_stock,
      coalesce(rp.maximum_stock,0) maximum_stock,coalesce(rp.safety_stock,0) safety_stock,
      coalesce(rp.lead_time_days,7) lead_time_days,
      coalesce(sb.quantity,0) stock,coalesce(i.on_order,0) on_order,
      coalesce(sa.average_daily_sales,0) average_daily_sales,
      cost.unit_cost estimated_cost,cost.received_at last_cost_at
    from public.products p
    left join lateral (
      select x.* from public.restock_policies x
      where x.tenant_id=p_tenant_id and x.location_id=p_location_id and x.product_id=p.id and x.active
        and (p_supplier_id is null or x.supplier_id=p_supplier_id)
      order by x.preferred desc,x.updated_at desc limit 1
    ) rp on true
    left join public.suppliers sup on sup.id=rp.supplier_id
    left join public.stock_balances sb on sb.tenant_id=p_tenant_id and sb.location_id=p_location_id and sb.product_id=p.id
    left join sales_average sa on sa.product_id=p.id
    left join inbound i on i.product_id=p.id
    left join lateral (
      select pri.unit_cost,pri.received_at from public.purchase_receipt_items pri
      where pri.tenant_id=p_tenant_id and pri.product_id=p.id
        and (rp.supplier_id is null or pri.supplier_id=rp.supplier_id)
      order by pri.received_at desc limit 1
    ) cost on true
    where p.tenant_id=p_tenant_id and p.active and (p_supplier_id is null or rp.supplier_id is not null)
  ), scored as (
    select *,greatest(minimum_stock,safety_stock+(average_daily_sales*lead_time_days)) reorder_point
    from base
  ), final as (
    select *,greatest(maximum_stock,reorder_point) target_stock,
      ceil(greatest(0,greatest(maximum_stock,reorder_point)-stock-on_order)) suggested_qty,
      case when average_daily_sales>0 then round((stock+on_order)/average_daily_sales,1) end days_of_cover,
      case when stock<=0 then 'OUT_OF_STOCK'
        when stock+on_order<=reorder_point then 'CRITICAL'
        when stock+on_order<greatest(maximum_stock,reorder_point) then 'WATCH'
        else 'HEALTHY' end urgency
    from scored
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'policyId',policy_id,'productId',product_id,'sku',sku,'productName',product_name,
    'supplierId',supplier_id,'supplierName',supplier_name,'stock',stock,'onOrder',on_order,
    'averageDailySales',round(average_daily_sales,2),'minimumStock',minimum_stock,
    'maximumStock',maximum_stock,'safetyStock',safety_stock,'leadTimeDays',lead_time_days,
    'reorderPoint',round(reorder_point,2),'targetStock',round(target_stock,2),
    'suggestedQty',suggested_qty,'daysOfCover',days_of_cover,'urgency',urgency,
    'estimatedCost',estimated_cost,'lastCostAt',last_cost_at
  ) order by
    case urgency when 'OUT_OF_STOCK' then 0 when 'CRITICAL' then 1 when 'WATCH' then 2 else 3 end,
    suggested_qty desc,product_name),'[]'::jsonb) into v_rows from final;
  return jsonb_build_object(
    'settings',jsonb_build_object('approvalThreshold',coalesce(v_settings.approval_threshold,5000000),'lookbackDays',v_days),
    'locationId',p_location_id,'recommendations',v_rows
  );
end $$;

create or replace function public.create_restock_purchase_order_v1(
  p_tenant_id uuid,p_actor_id uuid,p_supplier_id uuid,p_location_id uuid,p_expected_on date,
  p_notes text,p_items jsonb
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_result jsonb; v_order_id uuid;
begin
  v_result:=public.save_purchase_order(
    p_tenant_id,p_actor_id,null,p_supplier_id,p_location_id,p_expected_on,p_notes,0,0,0,p_items
  );
  v_order_id:=(v_result->>'id')::uuid;
  update public.purchase_orders set planning_source='RESTOCK_PLAN' where id=v_order_id and tenant_id=p_tenant_id;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'RESTOCK_DRAFT_CREATED','purchase_order',v_order_id,
    jsonb_build_object('po_no',v_result->>'po_no','item_count',jsonb_array_length(p_items)));
  return v_result||jsonb_build_object('planningSource','RESTOCK_PLAN');
end $$;

create or replace function public.transition_purchase_order(
  p_tenant_id uuid,p_actor_id uuid,p_order_id uuid,p_action text
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_order public.purchase_orders%rowtype; v_role text; v_next text; v_threshold numeric; v_required boolean;
begin
  select role into v_role from public.profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active;
  if v_role is null then raise exception 'Akun tidak aktif'; end if;
  select * into v_order from public.purchase_orders where id=p_order_id and tenant_id=p_tenant_id for update;
  if not found then raise exception 'Purchase Order tidak ditemukan'; end if;
  select coalesce(approval_threshold,5000000) into v_threshold
  from public.purchase_planning_settings where tenant_id=p_tenant_id;
  v_threshold:=coalesce(v_threshold,5000000);

  if p_action='SUBMIT' then
    if v_role not in ('OWNER','ADMIN','PURCHASING') or v_order.status<>'DRAFT' then raise exception 'Purchase Order tidak dapat diajukan'; end if;
    v_required:=v_order.grand_total>v_threshold and v_role='PURCHASING';
    v_next:=case when v_required then 'SUBMITTED' else 'APPROVED' end;
    update public.purchase_orders set status=v_next,submitted_at=now(),updated_at=now(),
      approval_required=v_required,approval_threshold=v_threshold,
      approved_by=case when v_required then null else p_actor_id end,
      approved_at=case when v_required then null else now() end
    where id=p_order_id;
  elsif p_action='APPROVE' then
    if v_role not in ('OWNER','ADMIN') or v_order.status<>'SUBMITTED' then raise exception 'Hanya Owner/Admin dapat menyetujui PO yang diajukan'; end if;
    v_next:='APPROVED'; v_required:=true;
    update public.purchase_orders set status=v_next,approved_by=p_actor_id,approved_at=now(),updated_at=now() where id=p_order_id;
  elsif p_action='CANCEL' then
    if v_role not in ('OWNER','ADMIN') and not (v_role='PURCHASING' and v_order.status='DRAFT') then raise exception 'Purchase Order tidak dapat dibatalkan'; end if;
    if v_order.status in ('PARTIALLY_RECEIVED','RECEIVED','CANCELLED') then raise exception 'Purchase Order yang sudah diterima tidak dapat dibatalkan'; end if;
    v_next:='CANCELLED'; v_required:=v_order.approval_required;
    update public.purchase_orders set status=v_next,cancelled_at=now(),updated_at=now() where id=p_order_id;
  else raise exception 'Aksi Purchase Order tidak dikenal';
  end if;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'PURCHASE_ORDER_'||v_next,'purchase_order',p_order_id,
    jsonb_build_object('po_no',v_order.po_no,'from_status',v_order.status,'to_status',v_next,
      'grand_total',v_order.grand_total,'approval_threshold',v_threshold,'approval_required',v_required));
  return jsonb_build_object('id',p_order_id,'po_no',v_order.po_no,'status',v_next,
    'approvalRequired',v_required,'approvalThreshold',v_threshold);
end $$;

revoke all on function public.save_purchase_planning_settings_v1(uuid,uuid,numeric,integer) from public,anon,authenticated;
revoke all on function public.save_restock_policy_v1(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,integer,boolean) from public,anon,authenticated;
revoke all on function public.get_restock_recommendations_v1(uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.create_restock_purchase_order_v1(uuid,uuid,uuid,uuid,date,text,jsonb) from public,anon,authenticated;
grant execute on function public.save_purchase_planning_settings_v1(uuid,uuid,numeric,integer) to service_role;
grant execute on function public.save_restock_policy_v1(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,integer,boolean) to service_role;
grant execute on function public.get_restock_recommendations_v1(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.create_restock_purchase_order_v1(uuid,uuid,uuid,uuid,date,text,jsonb) to service_role;
