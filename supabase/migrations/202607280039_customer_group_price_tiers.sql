begin;

create or replace function public.save_product_v5(
  p_tenant_id uuid,p_actor_id uuid,p_product jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_result jsonb; v_product_id uuid; v_price jsonb; v_group_id text;
  v_amount numeric; v_min_qty integer; v_key text;
  v_seen text[]:=array[]::text[]; v_has_retail boolean:=false;
begin
  -- v3 tetap menangani produk, satuan, foto, dan audit master. Seluruh
  -- price_rules statis kemudian diganti secara atomik oleh format bertingkat.
  v_result:=public.save_product_v3(
    p_tenant_id,p_actor_id,p_product||jsonb_build_object(
      'wholesalePrice',0,'tierQty',0,'tierPrice',0
    )
  );
  v_product_id:=(v_result->>'id')::uuid;

  if coalesce(jsonb_typeof(p_product->'prices'),'')<>'array' then
    raise exception 'Daftar harga produk wajib diisi';
  end if;

  delete from public.price_rules
  where tenant_id=p_tenant_id and product_id=v_product_id
    and starts_at is null and ends_at is null;

  for v_price in select value from jsonb_array_elements(p_product->'prices') loop
    v_group_id:=nullif(trim(v_price->>'customerGroupId'),'');
    v_min_qty:=coalesce((v_price->>'minBaseQty')::integer,1);
    v_amount:=(v_price->>'unitPriceBase')::numeric;
    v_key:=coalesce(v_group_id,'')||':'||v_min_qty::text;

    if v_group_id is null or v_min_qty<1 or v_amount<=0 then
      raise exception 'Tipe, minimal pembelian, dan nominal harga produk tidak valid';
    end if;
    if v_key=any(v_seen) then
      raise exception 'Minimal pembelian % untuk tipe harga % tercatat dua kali',v_min_qty,v_group_id;
    end if;
    if not exists(
      select 1 from public.customer_price_groups
      where tenant_id=p_tenant_id and id=v_group_id and active=true
    ) then
      raise exception 'Tipe pelanggan % tidak valid atau sudah nonaktif',v_group_id;
    end if;

    v_seen:=array_append(v_seen,v_key);
    v_has_retail:=v_has_retail or (v_group_id='retail' and v_min_qty=1);
    insert into public.price_rules(
      tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base,priority
    ) values(
      p_tenant_id,v_product_id,v_group_id,v_min_qty,v_amount,
      case when v_group_id='retail' then 10 else 20 end
    );
  end loop;

  if not v_has_retail then raise exception 'Harga Umum minimal 1 pcs wajib diisi'; end if;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(
    p_tenant_id,p_actor_id,'PRODUCT_PRICE_TIERS_UPDATED','product',v_product_id,
    jsonb_build_object('prices',p_product->'prices')
  );
  return v_result||jsonb_build_object('priceCount',jsonb_array_length(p_product->'prices'));
end $$;

revoke all on function public.save_product_v5(uuid,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.save_product_v5(uuid,uuid,jsonb)
  to service_role;

commit;
