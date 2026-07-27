-- Kasir Nusa POS v2.6.0 - receipt layout designer and logo

alter table public.tenants
  add column if not exists receipt_layout_json jsonb not null default '{
    "headerAlignment":"center",
    "footerAlignment":"center",
    "titleSize":"large",
    "density":"normal",
    "separator":"dashed",
    "logoSize":64,
    "customHeader":"",
    "showLogo":true,
    "showBusinessName":true,
    "showOutletName":true,
    "showAddress":true,
    "showPhone":true,
    "showDate":true,
    "showReceiptNumber":true,
    "showCashier":true,
    "showCustomer":true,
    "showPriceType":true,
    "showPaymentDetail":true,
    "showTransactionNote":true,
    "showLoyaltyPoints":true
  }'::jsonb;

alter table public.tenants
  drop constraint if exists tenants_receipt_layout_object_check;
alter table public.tenants
  add constraint tenants_receipt_layout_object_check
  check(jsonb_typeof(receipt_layout_json)='object');

create or replace function public.save_receipt_layout_v1(
  p_tenant_id uuid,p_actor_id uuid,p_layout jsonb,p_logo_url text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_actor public.profiles%rowtype;
  v_result public.tenants%rowtype;
  v_logo text:=nullif(trim(coalesce(p_logo_url,'')),'');
begin
  select * into v_actor from public.profiles
  where user_id=p_actor_id and tenant_id=p_tenant_id and active=true;
  if not found or v_actor.role<>'OWNER' then
    raise exception 'Hanya Owner yang dapat mengubah desain struk';
  end if;
  if jsonb_typeof(p_layout)<>'object' then
    raise exception 'Format desain struk tidak valid';
  end if;
  if length(coalesce(v_logo,''))>300000 then
    raise exception 'Ukuran logo terlalu besar';
  end if;
  if v_logo is not null and v_logo !~* '^https?://'
    and v_logo !~* '^data:image/(png|jpeg|webp);base64,' then
    raise exception 'Format logo harus berupa gambar PNG, JPEG, WebP, atau URL aman';
  end if;

  update public.tenants set
    receipt_layout_json=p_layout,logo_url=v_logo,updated_at=now()
  where id=p_tenant_id returning * into v_result;

  insert into public.audit_logs(
    tenant_id,actor_id,action,entity_type,entity_id,details_json
  ) values(
    p_tenant_id,p_actor_id,'RECEIPT_LAYOUT_UPDATED','tenant',p_tenant_id,
    jsonb_build_object(
      'showLogo',coalesce((p_layout->>'showLogo')::boolean,false),
      'headerAlignment',p_layout->>'headerAlignment',
      'density',p_layout->>'density'
    )
  );
  return to_jsonb(v_result);
end $$;

revoke all on function public.save_receipt_layout_v1(uuid,uuid,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.save_receipt_layout_v1(uuid,uuid,jsonb,text)
  to service_role;
