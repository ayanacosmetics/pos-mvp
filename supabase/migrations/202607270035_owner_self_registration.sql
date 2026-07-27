-- Kasir Nusa POS v2.4.5 - secure Owner self-registration workspace

create or replace function public.register_owner_workspace_v1(
  p_user_id uuid,
  p_display_name text,
  p_business_name text,
  p_email text
) returns jsonb
language plpgsql
security definer
set search_path=public,auth
as $$
declare
  v_tenant uuid;
  v_outlet uuid;
  v_store uuid;
  v_warehouse uuid;
begin
  if p_user_id is null
    or length(trim(coalesce(p_display_name,''))) not between 2 and 100
    or length(trim(coalesce(p_business_name,''))) not between 2 and 120
    or length(trim(coalesce(p_email,''))) not between 3 and 254 then
    raise exception 'Data pendaftaran Owner tidak valid';
  end if;
  if not exists(
    select 1 from auth.users
    where id=p_user_id and lower(email)=lower(trim(p_email))
  ) then
    raise exception 'Identitas Auth Owner tidak ditemukan';
  end if;
  if exists(select 1 from public.profiles where user_id=p_user_id) then
    raise exception 'Akun sudah terhubung ke ruang usaha';
  end if;

  insert into public.tenants(name,email)
  values(trim(p_business_name),lower(trim(p_email)))
  returning id into v_tenant;

  insert into public.profiles(user_id,tenant_id,display_name,role,active)
  values(p_user_id,v_tenant,trim(p_display_name),'OWNER',true);

  insert into public.outlets(
    tenant_id,code,name,timezone,receipt_prefix,receipt_footer,active
  ) values(
    v_tenant,'UTM','Toko Utama','Asia/Makassar','UTM',
    'Terima kasih telah berbelanja.',true
  ) returning id into v_outlet;

  insert into public.stock_locations(
    tenant_id,outlet_id,code,name,kind,active
  ) values(v_tenant,v_outlet,'TOKO','Toko Utama','STORE',true)
  returning id into v_store;

  insert into public.stock_locations(
    tenant_id,outlet_id,code,name,kind,active
  ) values(v_tenant,v_outlet,'GDG','Gudang Utama','WAREHOUSE',true)
  returning id into v_warehouse;

  insert into public.user_outlets(tenant_id,user_id,outlet_id)
  values(v_tenant,p_user_id,v_outlet);

  insert into public.customers(tenant_id,code,name,group_id,tier_id)
  values(
    v_tenant,'PLG-0001','Pelanggan Umum','retail',
    (select id from public.customer_tiers
      where tenant_id=v_tenant and code='MEMBER' limit 1)
  );

  insert into public.purchase_planning_settings(tenant_id,updated_by)
  values(v_tenant,p_user_id)
  on conflict(tenant_id) do nothing;

  insert into public.expense_categories(
    tenant_id,name,cash_flow_group,created_by
  ) values
    (v_tenant,'Operasional toko','OPERATING',p_user_id),
    (v_tenant,'Gaji dan upah','OPERATING',p_user_id),
    (v_tenant,'Sewa tempat','OPERATING',p_user_id)
  on conflict(tenant_id,name) do nothing;

  insert into public.chart_of_accounts(
    tenant_id,code,name,account_type,normal_balance,system_key,allow_manual
  ) values
    (v_tenant,'1100','Kas Tunai','ASSET','DEBIT','CASH',true),
    (v_tenant,'1110','Bank dan Transfer','ASSET','DEBIT','BANK',true),
    (v_tenant,'1120','QRIS Belum Cair','ASSET','DEBIT','QRIS_CLEARING',true),
    (v_tenant,'1130','Kartu/EDC Belum Cair','ASSET','DEBIT','CARD_CLEARING',true),
    (v_tenant,'1200','Piutang Usaha','ASSET','DEBIT','ACCOUNTS_RECEIVABLE',true),
    (v_tenant,'1300','Persediaan Barang','ASSET','DEBIT','INVENTORY',true),
    (v_tenant,'1400','Uang Muka dan Klaim Supplier','ASSET','DEBIT','SUPPLIER_ADVANCE',true),
    (v_tenant,'2100','Hutang Usaha','LIABILITY','CREDIT','ACCOUNTS_PAYABLE',true),
    (v_tenant,'3100','Modal Pemilik','EQUITY','CREDIT','OWNER_EQUITY',true),
    (v_tenant,'3200','Saldo Laba','EQUITY','CREDIT','RETAINED_EARNINGS',true),
    (v_tenant,'4100','Penjualan','REVENUE','CREDIT','SALES_REVENUE',false),
    (v_tenant,'4190','Retur Penjualan','REVENUE','DEBIT','SALES_RETURN',false),
    (v_tenant,'5100','Harga Pokok Penjualan','EXPENSE','DEBIT','COGS',false),
    (v_tenant,'6100','Biaya Operasional','EXPENSE','DEBIT','OPERATING_EXPENSE',true),
    (v_tenant,'6900','Kerugian Persediaan','EXPENSE','DEBIT','INVENTORY_LOSS',true)
  on conflict(tenant_id,code) do nothing;

  insert into public.audit_logs(
    tenant_id,actor_id,action,entity_type,entity_id,details_json
  ) values(
    v_tenant,p_user_id,'OWNER_REGISTERED','tenant',v_tenant,
    jsonb_build_object('outletId',v_outlet,'source','OWNER_SELF_REGISTRATION')
  );

  return jsonb_build_object(
    'tenantId',v_tenant,
    'outletId',v_outlet,
    'storeLocationId',v_store,
    'warehouseLocationId',v_warehouse
  );
end
$$;

revoke all on function public.register_owner_workspace_v1(uuid,text,text,text)
  from public,anon,authenticated;
grant execute on function public.register_owner_workspace_v1(uuid,text,text,text)
  to service_role;
