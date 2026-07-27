-- Kasir Nusa POS v2.4.6 - product images for compact merchandise lists

alter table public.products
  add column if not exists image_url text;

alter table public.products
  drop constraint if exists products_image_url_check;
alter table public.products
  add constraint products_image_url_check check(
    image_url is null
    or (
      length(image_url)<=2000
      and image_url ~* '^https?://'
    )
  );

create or replace function public.save_product_v3(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_product jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_result jsonb;
  v_product_id uuid;
  v_image_url text:=nullif(trim(p_product->>'imageUrl'),'');
begin
  if v_image_url is not null and (
    length(v_image_url)>2000
    or v_image_url !~* '^https?://'
  ) then
    raise exception 'URL foto produk harus memakai http atau https';
  end if;

  v_result:=public.save_product_v2(p_tenant_id,p_actor_id,p_product);
  v_product_id:=(v_result->>'id')::uuid;

  update public.products
  set image_url=v_image_url,updated_at=now()
  where tenant_id=p_tenant_id and id=v_product_id;

  return v_result||jsonb_build_object('imageUrl',v_image_url);
end
$$;

revoke all on function public.save_product_v3(uuid,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.save_product_v3(uuid,uuid,jsonb)
  to service_role;
