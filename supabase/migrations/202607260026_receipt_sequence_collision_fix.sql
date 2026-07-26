-- Kasir Nusa POS v1.21.1 - repair and guard sale receipt sequences

create or replace function public.guard_sale_receipt_number_v1()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_prefix text;
  v_next bigint;
begin
  if not exists(
    select 1
    from public.sales
    where tenant_id=new.tenant_id
      and receipt_no=new.receipt_no
  ) then
    return new;
  end if;

  select receipt_prefix
    into v_prefix
  from public.outlets
  where id=new.outlet_id
    and tenant_id=new.tenant_id;

  if nullif(trim(v_prefix),'') is null then
    raise exception 'Awalan nomor struk outlet tidak ditemukan';
  end if;

  -- Serialize recovery across outlets that share the same receipt prefix.
  perform pg_advisory_xact_lock(
    hashtextextended(new.tenant_id::text||':SALE:'||v_prefix,0)
  );

  select coalesce(max(
    case
      when left(receipt_no,length(v_prefix)+1)=v_prefix||'-'
        and substring(receipt_no from length(v_prefix)+2) ~ '^[0-9]+$'
      then substring(receipt_no from length(v_prefix)+2)::bigint
      else 0
    end
  ),0)+1
    into v_next
  from public.sales
  where tenant_id=new.tenant_id;

  new.receipt_no:=v_prefix||'-'||lpad(v_next::text,6,'0');

  insert into public.document_sequences(tenant_id,kind,next_value)
  values(new.tenant_id,'SALE:'||new.outlet_id::text,v_next+1)
  on conflict(tenant_id,kind) do update
    set next_value=greatest(public.document_sequences.next_value,excluded.next_value);

  return new;
end
$$;

drop trigger if exists guard_sale_receipt_number on public.sales;
create trigger guard_sale_receipt_number
before insert on public.sales
for each row execute function public.guard_sale_receipt_number_v1();

-- Repair counters that drifted behind existing receipts. The trigger remains as
-- a final guard for restored/imported data and outlets sharing a prefix.
with outlet_maximums as (
  select
    o.tenant_id,
    o.id as outlet_id,
    coalesce(max(
      case
        when left(s.receipt_no,length(o.receipt_prefix)+1)=o.receipt_prefix||'-'
          and substring(s.receipt_no from length(o.receipt_prefix)+2) ~ '^[0-9]+$'
        then substring(s.receipt_no from length(o.receipt_prefix)+2)::bigint
        else 0
      end
    ),0)+1 as required_next
  from public.outlets o
  left join public.sales s
    on s.tenant_id=o.tenant_id
  group by o.tenant_id,o.id,o.receipt_prefix
)
insert into public.document_sequences(tenant_id,kind,next_value)
select tenant_id,'SALE:'||outlet_id::text,required_next
from outlet_maximums
on conflict(tenant_id,kind) do update
  set next_value=greatest(public.document_sequences.next_value,excluded.next_value);

revoke all on function public.guard_sale_receipt_number_v1() from public,anon,authenticated;
