-- Kasir Nusa v1.19 - harga jual manual dapat dinaikkan atau diturunkan secara terkontrol

alter table public.sale_adjustment_authorizations
  drop constraint if exists sale_adjustment_authorizations_discount_amount_check;

alter table public.sale_adjustment_authorizations
  add constraint sale_adjustment_authorizations_adjustment_nonzero
  check (discount_amount <> 0);

create or replace function public.create_sale_adjustment_authorization(
  p_tenant_id uuid,
  p_outlet_id uuid,
  p_cashier_id uuid,
  p_approved_by uuid,
  p_basket_fingerprint text,
  p_approval_token_hash text,
  p_adjustment jsonb,
  p_discount_amount numeric,
  p_valid_minutes integer default 5
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_authorization public.sale_adjustment_authorizations%rowtype;
  v_approver public.profiles%rowtype;
begin
  select * into v_approver
  from public.profiles
  where tenant_id=p_tenant_id and user_id=p_approved_by and active=true
    and role in ('OWNER','ADMIN');
  if not found then raise exception 'Pemberi persetujuan bukan Owner atau Admin aktif'; end if;

  if not exists(
    select 1 from public.profiles
    where tenant_id=p_tenant_id and user_id=p_cashier_id and active=true
      and role in ('OWNER','ADMIN','CASHIER')
  ) then raise exception 'Kasir tidak aktif atau tidak memiliki akses POS'; end if;

  if not exists(
    select 1 from public.outlets where id=p_outlet_id and tenant_id=p_tenant_id and active=true
  ) then raise exception 'Outlet tidak aktif'; end if;

  if length(coalesce(p_basket_fingerprint,''))<32 or length(coalesce(p_approval_token_hash,''))<32
    then raise exception 'Identitas persetujuan tidak valid';
  end if;
  if coalesce(p_discount_amount,0)=0 then raise exception 'Penyesuaian harga harus mengubah nilai transaksi'; end if;

  update public.sale_adjustment_authorizations
  set status='EXPIRED'
  where tenant_id=p_tenant_id and cashier_id=p_cashier_id
    and status='APPROVED' and expires_at<=now();

  insert into public.sale_adjustment_authorizations(
    tenant_id,outlet_id,cashier_id,approved_by,basket_fingerprint,
    approval_token_hash,adjustment_json,discount_amount,expires_at
  ) values (
    p_tenant_id,p_outlet_id,p_cashier_id,p_approved_by,p_basket_fingerprint,
    p_approval_token_hash,p_adjustment,p_discount_amount,
    now() + make_interval(mins=>greatest(1,least(coalesce(p_valid_minutes,5),15)))
  ) returning * into v_authorization;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(
    p_tenant_id,p_approved_by,'SALE_PRICE_OVERRIDE_APPROVED','sale_adjustment',v_authorization.id,
    jsonb_build_object(
      'cashierId',p_cashier_id,'outletId',p_outlet_id,
      'adjustmentAmount',p_discount_amount,'adjustment',p_adjustment,
      'direction',case when p_discount_amount>0 then 'DECREASE' else 'INCREASE' end,
      'expiresAt',v_authorization.expires_at
    )
  );

  return jsonb_build_object(
    'id',v_authorization.id,
    'status',v_authorization.status,
    'expiresAt',v_authorization.expires_at,
    'approvedBy',v_approver.display_name,
    'discountAmount',v_authorization.discount_amount
  );
end $$;

revoke all on function public.create_sale_adjustment_authorization(uuid,uuid,uuid,uuid,text,text,jsonb,numeric,integer) from public,anon,authenticated;
grant execute on function public.create_sale_adjustment_authorization(uuid,uuid,uuid,uuid,text,text,jsonb,numeric,integer) to service_role;
