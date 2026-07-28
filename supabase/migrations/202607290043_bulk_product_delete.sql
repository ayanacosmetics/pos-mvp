-- Kasir Nusa POS - safe bulk product deletion

create or replace function public.delete_products_v1(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_product_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_product public.products%rowtype;
  v_product_id uuid;
  v_deleted integer := 0;
  v_archived integer := 0;
  v_blocked integer := 0;
  v_missing integer := 0;
begin
  if not exists(
    select 1 from public.profiles
    where tenant_id=p_tenant_id and user_id=p_actor_id
      and active=true and role in ('OWNER','ADMIN')
  ) then
    raise exception 'Hanya Owner atau Admin yang dapat menghapus produk';
  end if;

  if coalesce(array_length(p_product_ids,1),0)=0 then
    raise exception 'Pilih minimal satu produk';
  end if;

  for v_product_id in
    select distinct value from unnest(p_product_ids) as selected(value)
  loop
    select * into v_product
    from public.products
    where tenant_id=p_tenant_id and id=v_product_id
    for update;

    if not found then
      v_missing := v_missing+1;
      continue;
    end if;

    if exists(
      select 1
      from public.purchase_order_items item
      join public.purchase_orders orders on orders.id=item.order_id
      where item.product_id=v_product_id
        and orders.status in ('DRAFT','SUBMITTED','APPROVED','PARTIALLY_RECEIVED')
    ) then
      v_blocked := v_blocked+1;
      continue;
    end if;

    begin
      delete from public.products
      where tenant_id=p_tenant_id and id=v_product_id;
      v_deleted := v_deleted+1;
    exception when foreign_key_violation then
      update public.products
      set active=false,updated_at=now()
      where tenant_id=p_tenant_id and id=v_product_id;
      v_archived := v_archived+1;
    end;
  end loop;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,details_json)
  values(
    p_tenant_id,p_actor_id,'PRODUCTS_BULK_DELETED','product',
    jsonb_build_object(
      'requested',coalesce(array_length(p_product_ids,1),0),
      'deleted',v_deleted,'archived',v_archived,
      'blocked',v_blocked,'missing',v_missing
    )
  );

  return jsonb_build_object(
    'requested',coalesce(array_length(p_product_ids,1),0),
    'deleted',v_deleted,'archived',v_archived,
    'blocked',v_blocked,'missing',v_missing
  );
end
$$;

revoke all on function public.delete_products_v1(uuid,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.delete_products_v1(uuid,uuid,uuid[]) to service_role;
