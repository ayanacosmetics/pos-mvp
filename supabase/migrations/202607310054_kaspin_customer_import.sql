-- Import Kasir Pintar customers with dynamic Member/Grosir price groups and loyalty points.
begin;

create or replace function public.import_kaspin_customers_v1(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_idempotency_key text,
  p_file_name text,
  p_rows jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_job public.import_jobs%rowtype;
  v_row jsonb;
  v_customer public.customers%rowtype;
  v_code text;
  v_name text;
  v_phone text;
  v_email text;
  v_group_id text;
  v_imported_points integer;
  v_new_points integer;
  v_delta integer;
  v_created integer:=0;
  v_updated integer:=0;
  v_index bigint;
begin
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)=0 then
    raise exception 'Data pelanggan Kaspin kosong';
  end if;
  if not exists(
    select 1 from public.profiles
    where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in('OWNER','ADMIN')
  ) then raise exception 'Hanya Owner atau Admin yang dapat mengimpor pelanggan'; end if;

  select * into v_job from public.import_jobs
  where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then
    return v_job.summary_json||jsonb_build_object('id',v_job.id,'duplicate',true);
  end if;

  for v_row,v_index in
    select value,ordinality from jsonb_array_elements(p_rows) with ordinality
  loop
    v_code:=upper(trim(v_row->>'code'));
    v_name:=trim(v_row->>'name');
    v_phone:=nullif(regexp_replace(coalesce(v_row->>'phone',''),'\D','','g'),'');
    v_email:=nullif(lower(trim(v_row->>'email')),'');
    v_group_id:=lower(trim(v_row->>'groupId'));
    v_imported_points:=greatest(coalesce((v_row->>'loyaltyPoints')::integer,0),0);
    if v_code='' or v_name='' then raise exception 'Kode atau nama pelanggan kosong pada baris %',v_index; end if;
    if not exists(
      select 1 from public.customer_price_groups
      where tenant_id=p_tenant_id and id=v_group_id and active=true
    ) then raise exception 'Tipe pelanggan % belum aktif',coalesce(v_group_id,'-'); end if;

    v_customer:=null;
    select * into v_customer from public.customers
    where tenant_id=p_tenant_id and (
      code=v_code
      or (v_phone is not null and phone=v_phone)
      or (v_email is not null and lower(email)=v_email)
    )
    order by case when code=v_code then 0 when v_phone is not null and phone=v_phone then 1 else 2 end
    limit 1 for update;

    if v_customer.id is null then
      insert into public.customers(
        tenant_id,code,name,phone,email,address,group_id,loyalty_points,active
      ) values(
        p_tenant_id,v_code,v_name,v_phone,v_email,nullif(trim(v_row->>'address'),''),
        v_group_id,v_imported_points,true
      ) returning * into v_customer;
      v_created:=v_created+1;
      v_delta:=v_imported_points;
    else
      v_new_points:=greatest(v_customer.loyalty_points,v_imported_points);
      v_delta:=v_new_points-v_customer.loyalty_points;
      update public.customers set
        name=v_name,phone=coalesce(v_phone,phone),email=coalesce(v_email,email),
        address=coalesce(nullif(trim(v_row->>'address'),''),address),
        group_id=v_group_id,loyalty_points=v_new_points,active=true,updated_at=now()
      where id=v_customer.id returning * into v_customer;
      v_updated:=v_updated+1;
    end if;

    if v_delta>0 then
      insert into public.customer_point_entries(
        tenant_id,customer_id,sale_id,entry_type,points,balance_after,note,
        actor_id,idempotency_key,occurred_at
      ) values(
        p_tenant_id,v_customer.id,null,'ADJUST',v_delta,v_customer.loyalty_points,
        'Saldo poin awal dari Kasir Pintar',p_actor_id,
        p_idempotency_key||':points:'||v_index,now()
      );
    end if;
  end loop;

  insert into public.import_jobs(
    tenant_id,actor_id,idempotency_key,import_kind,file_name,location_id,
    total_rows,created_rows,updated_rows,summary_json
  ) values(
    p_tenant_id,p_actor_id,p_idempotency_key,'CUSTOMERS',nullif(p_file_name,''),null,
    jsonb_array_length(p_rows),v_created,v_updated,
    jsonb_build_object('kind','CUSTOMERS','source','KASPIN','total',jsonb_array_length(p_rows),
      'created',v_created,'updated',v_updated)
  ) returning * into v_job;
  update public.import_jobs
  set summary_json=summary_json||jsonb_build_object('id',v_job.id)
  where id=v_job.id;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(
    p_tenant_id,p_actor_id,'KASPIN_CUSTOMERS_IMPORTED','import_job',v_job.id,
    jsonb_build_object('fileName',p_file_name,'created',v_created,'updated',v_updated)
  );
  return v_job.summary_json||jsonb_build_object('id',v_job.id,'duplicate',false);
end
$$;

revoke all on function public.import_kaspin_customers_v1(uuid,uuid,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.import_kaspin_customers_v1(uuid,uuid,text,text,jsonb)
  to service_role;

commit;
