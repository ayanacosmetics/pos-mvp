-- Global infrastructure metrics for the private Nusa platform dashboard.
-- The function is deliberately service-role only. Tenant Owners must never
-- receive aggregate database usage or cross-tenant activity.

create or replace function public.platform_infrastructure_snapshot_v1()
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_database_bytes bigint:=pg_database_size(current_database());
  v_database_limit_bytes bigint:=500*1024*1024;
  v_tables jsonb;
  v_tenant_count bigint;
  v_user_count bigint;
  v_sale_count bigint;
  v_last_sale_at timestamptz;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'schema',ranked.schemaname,
    'table',ranked.relname,
    'estimatedRows',ranked.estimated_rows,
    'totalBytes',ranked.total_bytes
  ) order by ranked.total_bytes desc),'[]'::jsonb)
  into v_tables
  from (
    select stats.schemaname,stats.relname,stats.n_live_tup estimated_rows,
      pg_total_relation_size(stats.relid) total_bytes
    from pg_stat_user_tables stats
    order by pg_total_relation_size(stats.relid) desc
    limit 20
  ) ranked;

  select count(*) into v_tenant_count from public.tenants;
  select count(*) into v_user_count from public.profiles where active=true;
  select count(*),max(occurred_at) into v_sale_count,v_last_sale_at from public.sales;

  return jsonb_build_object(
    'generatedAt',now(),
    'database',jsonb_build_object(
      'usedBytes',v_database_bytes,
      'limitBytes',v_database_limit_bytes,
      'remainingBytes',greatest(0,v_database_limit_bytes-v_database_bytes),
      'usedPercent',round(v_database_bytes*100.0/v_database_limit_bytes,2)
    ),
    'platform',jsonb_build_object(
      'tenantCount',v_tenant_count,
      'activeUserCount',v_user_count,
      'saleCount',v_sale_count,
      'lastSaleAt',v_last_sale_at
    ),
    'tables',v_tables
  );
end $$;

revoke all on function public.platform_infrastructure_snapshot_v1() from public,anon,authenticated;
grant execute on function public.platform_infrastructure_snapshot_v1() to service_role;
