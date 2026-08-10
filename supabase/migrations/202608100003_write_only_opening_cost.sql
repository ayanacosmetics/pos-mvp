-- Permit inventory staff to enter opening cost once while creating a product.
-- This does not grant purchasing.view_cost: existing/average costs remain hidden
-- from product lists, inventory, history, reports, and subsequent edits.

begin;

create or replace function public.save_product_with_opening_stock_v1(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_product jsonb,
  p_opening jsonb default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_result jsonb;
  v_product_id uuid;
  v_quantity numeric:=coalesce((p_opening->>'quantity')::numeric,0);
  v_unit_cost numeric:=coalesce((p_opening->>'unitCost')::numeric,0);
  v_location_id uuid;
  v_adjustment jsonb;
begin
  if nullif(p_product->>'id','') is not null then
    raise exception 'Stok awal hanya dapat diisi saat membuat produk baru';
  end if;
  if v_quantity<0 then raise exception 'Jumlah stok awal tidak valid'; end if;
  if v_quantity=0 then return public.save_product_v6(p_tenant_id,p_actor_id,p_product); end if;
  if not coalesce((p_product->>'trackStock')::boolean,true) then
    raise exception 'Produk tanpa stok tidak dapat memiliki stok awal';
  end if;
  if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'catalog.manage')
    or not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'inventory.manage') then
    raise exception 'Akun tidak memiliki izin produk dan stok awal';
  end if;
  if v_unit_cost<0 then raise exception 'Modal per pcs tidak boleh negatif'; end if;

  begin
    v_location_id:=(p_opening->>'locationId')::uuid;
  exception when others then
    raise exception 'Lokasi stok awal tidak valid';
  end;
  if not exists(
    select 1 from public.stock_locations
    where tenant_id=p_tenant_id and id=v_location_id and active=true
  ) then raise exception 'Lokasi stok awal tidak valid'; end if;

  v_result:=public.save_product_v6(p_tenant_id,p_actor_id,p_product);
  v_product_id:=(v_result->>'id')::uuid;
  v_adjustment:=public.adjust_product_stock_v1(
    p_tenant_id,p_actor_id,
    coalesce(nullif(left(trim(p_opening->>'idempotencyKey'),180),''),
      'PRODUCT-OPENING:'||v_product_id::text),
    v_location_id,v_product_id,'IN',v_quantity,v_unit_cost,
    nullif(left(trim(p_opening->>'batchNo'),80),''),
    nullif(p_opening->>'expiresOn','')::date,
    'Stok awal saat membuat produk'
  );

  return v_result||jsonb_build_object('openingStock',v_adjustment);
end $$;

revoke all on function public.save_product_with_opening_stock_v1(uuid,uuid,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.save_product_with_opening_stock_v1(uuid,uuid,jsonb,jsonb)
  to service_role;

commit;
