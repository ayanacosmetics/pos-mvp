-- Kasir Nusa POS v2.7.0 - unique QR vouchers issued on receipts.
create table if not exists public.receipt_voucher_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  outlet_id uuid references public.outlets(id),
  name text not null,
  active boolean not null default true,
  priority integer not null default 0,
  trigger_min_purchase numeric(19,4) not null default 0 check(trigger_min_purchase>=0),
  discount_type text not null check(discount_type in ('FIXED','PERCENT')),
  discount_value numeric(19,4) not null check(discount_value>0),
  max_discount numeric(19,4),
  redemption_min_purchase numeric(19,4) not null default 0 check(redemption_min_purchase>=0),
  valid_after_days integer not null default 1 check(valid_after_days between 0 and 365),
  valid_days integer not null default 14 check(valid_days between 1 and 3650),
  customer_mode text not null default 'BEARER' check(customer_mode in ('BEARER','MEMBER')),
  created_by uuid not null references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(discount_type<>'PERCENT' or discount_value<=100)
);

alter table public.vouchers add column if not exists source text not null default 'MANUAL';
alter table public.vouchers add column if not exists receipt_campaign_id uuid references public.receipt_voucher_campaigns(id);
alter table public.vouchers add column if not exists source_sale_id uuid references public.sales(id);
alter table public.vouchers add column if not exists issued_customer_id uuid references public.customers(id);
alter table public.voucher_redemptions alter column customer_id drop not null;

do $$ begin
  alter table public.vouchers add constraint vouchers_source_check check(source in ('MANUAL','RECEIPT'));
exception when duplicate_object then null;
end $$;

create unique index if not exists receipt_voucher_sale_campaign_key
  on public.vouchers(tenant_id,receipt_campaign_id,source_sale_id)
  where source='RECEIPT';
create index if not exists receipt_voucher_campaign_metrics_idx
  on public.vouchers(tenant_id,receipt_campaign_id,created_at desc)
  where source='RECEIPT';

alter table public.receipt_voucher_campaigns enable row level security;

create or replace function public.quote_voucher_v1(
  p_tenant_id uuid,p_customer_id uuid,p_outlet_id uuid,p_code text,p_basket_total numeric
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_voucher public.vouchers%rowtype;v_customer public.customers%rowtype;v_settings public.loyalty_settings%rowtype;
  v_customer_usage integer:=0;v_segment text:='RECEIPT';v_discount numeric;
begin
  select * into v_voucher from public.vouchers
    where tenant_id=p_tenant_id and upper(code)=upper(trim(p_code)) limit 1;
  if not found or not v_voucher.active then raise exception 'Kode voucher tidak valid'; end if;

  if v_voucher.source='MANUAL' then
    if p_customer_id is null then raise exception 'Pilih member sebelum menggunakan voucher'; end if;
    select * into v_customer from public.customers where tenant_id=p_tenant_id and id=p_customer_id and active=true;
    if not found then raise exception 'Member tidak ditemukan atau tidak aktif'; end if;
  elsif v_voucher.issued_customer_id is not null and v_voucher.issued_customer_id is distinct from p_customer_id then
    raise exception 'Voucher ini khusus untuk member penerima';
  end if;

  if now()<v_voucher.starts_at then raise exception 'Voucher belum mulai berlaku'; end if;
  if now()>v_voucher.ends_at then raise exception 'Voucher sudah berakhir'; end if;
  if v_voucher.outlet_id is not null and v_voucher.outlet_id<>p_outlet_id then raise exception 'Voucher tidak berlaku di outlet ini'; end if;
  if p_basket_total<v_voucher.min_purchase then raise exception 'Minimal belanja voucher belum terpenuhi'; end if;
  if v_voucher.usage_limit_total is not null and v_voucher.usage_count>=v_voucher.usage_limit_total then raise exception 'Voucher sudah pernah digunakan'; end if;

  if p_customer_id is not null then
    select count(*) into v_customer_usage from public.voucher_redemptions
      where tenant_id=p_tenant_id and voucher_id=v_voucher.id and customer_id=p_customer_id;
  end if;
  if v_voucher.one_time and v_customer_usage>0 then raise exception 'Voucher satu kali ini sudah pernah digunakan'; end if;
  if v_voucher.usage_limit_per_customer is not null and v_customer_usage>=v_voucher.usage_limit_per_customer then
    raise exception 'Batas voucher untuk member ini sudah tercapai';
  end if;

  if v_voucher.source='MANUAL' then
    select * into v_settings from public.loyalty_settings where tenant_id=p_tenant_id;
    if to_char(v_customer.birth_date,'MM-DD')=to_char(current_date,'MM-DD') then v_segment:='BIRTHDAY';
    elsif v_customer.lifetime_spend>=5000000 then v_segment:='HIGH_VALUE';
    elsif v_customer.last_purchase_at is null or v_customer.last_purchase_at<now()-make_interval(days=>coalesce(v_settings.inactivity_days,90)) then v_segment:='INACTIVE';
    else v_segment:='ACTIVE'; end if;
    if v_voucher.segment<>'ALL' and v_voucher.segment<>v_segment then raise exception 'Voucher tidak berlaku untuk segmen member ini'; end if;
  end if;

  v_discount:=case when v_voucher.discount_type='PERCENT'
    then p_basket_total*v_voucher.discount_value/100 else v_voucher.discount_value end;
  if v_voucher.max_discount is not null then v_discount:=least(v_discount,v_voucher.max_discount); end if;
  v_discount:=round(least(v_discount,p_basket_total),2);
  return jsonb_build_object('id',v_voucher.id,'code',v_voucher.code,'name',v_voucher.name,
    'discount',v_discount,'segment',v_segment,'source',v_voucher.source);
end $$;

create or replace function public.issue_receipt_voucher_v1(
  p_tenant_id uuid,p_actor_id uuid,p_sale_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_sale public.sales%rowtype;v_campaign public.receipt_voucher_campaigns%rowtype;
  v_voucher public.vouchers%rowtype;v_code text;v_attempt integer:=0;
  v_alphabet constant text:='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true)
    then raise exception 'Akun tidak aktif'; end if;
  select * into v_sale from public.sales where tenant_id=p_tenant_id and id=p_sale_id and status='COMPLETED';
  if not found then return null; end if;
  select * into v_campaign from public.receipt_voucher_campaigns
    where tenant_id=p_tenant_id and active=true
      and (outlet_id is null or outlet_id=v_sale.outlet_id)
      and trigger_min_purchase<=v_sale.grand_total
      and (customer_mode='BEARER' or v_sale.customer_id is not null)
    order by priority desc,trigger_min_purchase desc,created_at asc limit 1;
  if not found then return null; end if;
  select * into v_voucher from public.vouchers
    where tenant_id=p_tenant_id and receipt_campaign_id=v_campaign.id and source_sale_id=v_sale.id;
  if not found then
    loop
      v_attempt:=v_attempt+1;
      select string_agg(substr(v_alphabet,1+floor(random()*length(v_alphabet))::integer,1),'')
        into v_code from generate_series(1,10);
      begin
        insert into public.vouchers(
          tenant_id,outlet_id,code,name,discount_type,discount_value,max_discount,min_purchase,
          starts_at,ends_at,usage_limit_total,usage_limit_per_customer,segment,one_time,active,
          created_by,source,receipt_campaign_id,source_sale_id,issued_customer_id
        ) values (
          p_tenant_id,v_campaign.outlet_id,v_code,v_campaign.name,v_campaign.discount_type,
          v_campaign.discount_value,v_campaign.max_discount,v_campaign.redemption_min_purchase,
          now()+make_interval(days=>v_campaign.valid_after_days),
          now()+make_interval(days=>v_campaign.valid_after_days+v_campaign.valid_days),
          1,1,'ALL',true,true,p_actor_id,'RECEIPT',v_campaign.id,v_sale.id,
          case when v_campaign.customer_mode='MEMBER' then v_sale.customer_id else null end
        ) returning * into v_voucher;
        exit;
      exception when unique_violation then
        if v_attempt>=10 then raise exception 'Gagal membuat kode voucher unik'; end if;
      end;
    end loop;
    insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'RECEIPT_VOUCHER_ISSUED','voucher',v_voucher.id,
      jsonb_build_object('saleId',v_sale.id,'campaignId',v_campaign.id,'code',v_voucher.code));
  end if;
  return jsonb_build_object(
    'id',v_voucher.id,'code',v_voucher.code,'name',v_voucher.name,
    'discountType',v_voucher.discount_type,'discountValue',v_voucher.discount_value,
    'maxDiscount',v_voucher.max_discount,'minPurchase',v_voucher.min_purchase,
    'startsAt',v_voucher.starts_at,'endsAt',v_voucher.ends_at,
    'customerMode',v_campaign.customer_mode
  );
end $$;

create or replace function public.cancel_receipt_vouchers_for_sale_v1(
  p_tenant_id uuid,p_actor_id uuid,p_sale_id uuid
) returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  update public.vouchers set active=false
    where tenant_id=p_tenant_id and source='RECEIPT' and source_sale_id=p_sale_id and usage_count=0 and active=true;
  get diagnostics v_count=row_count;
  if v_count>0 then
    insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'RECEIPT_VOUCHER_CANCELLED','sale',p_sale_id,jsonb_build_object('count',v_count));
  end if;
  return v_count;
end $$;

create or replace function public.receipt_voucher_dashboard_v1(p_tenant_id uuid)
returns jsonb language sql security definer set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',c.id,'name',c.name,'outlet_id',c.outlet_id,'active',c.active,'priority',c.priority,
    'trigger_min_purchase',c.trigger_min_purchase,'discount_type',c.discount_type,
    'discount_value',c.discount_value,'max_discount',c.max_discount,
    'redemption_min_purchase',c.redemption_min_purchase,'valid_after_days',c.valid_after_days,
    'valid_days',c.valid_days,'customer_mode',c.customer_mode,'created_at',c.created_at,
    'issued_count',(select count(*) from public.vouchers v where v.receipt_campaign_id=c.id),
    'redeemed_count',(select count(*) from public.vouchers v where v.receipt_campaign_id=c.id and v.usage_count>0),
    'expired_count',(select count(*) from public.vouchers v where v.receipt_campaign_id=c.id and v.usage_count=0 and v.ends_at<now())
  ) order by c.created_at desc),'[]'::jsonb)
  from public.receipt_voucher_campaigns c where c.tenant_id=p_tenant_id
$$;

revoke all on table public.receipt_voucher_campaigns from public,anon,authenticated;
revoke all on function public.issue_receipt_voucher_v1(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.cancel_receipt_vouchers_for_sale_v1(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.receipt_voucher_dashboard_v1(uuid) from public,anon,authenticated;
grant execute on function public.issue_receipt_voucher_v1(uuid,uuid,uuid) to service_role;
grant execute on function public.cancel_receipt_vouchers_for_sale_v1(uuid,uuid,uuid) to service_role;
grant execute on function public.receipt_voucher_dashboard_v1(uuid) to service_role;
