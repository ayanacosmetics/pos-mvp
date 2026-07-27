import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PERMISSIONS, permissionsFor } from '../packages/domain/src/permissions.mjs';

const read=(path)=>readFile(new URL(path,import.meta.url),'utf8');

test('v2.0 stores pilot, incident, telemetry, and recovery evidence',async()=>{
  const sql=await read('../supabase/migrations/202607270032_pilot_production_hardening.sql');
  for(const name of ['pilot_runs','pilot_check_results','production_incidents','production_telemetry','recovery_drills'])
    assert.ok(sql.includes(`create table if not exists public.${name}`));
  for(const name of ['start_pilot_run_v1','update_pilot_check_v1','decide_pilot_run_v1','pilot_safety_readiness_v1'])
    assert.ok(sql.includes(name));
  assert.ok(sql.includes('CONCURRENT_STOCK'));
  assert.ok(sql.includes("is distinct from 'OWNER'"));
  assert.match(sql,/v_pending>0 or v_failed>0/);
});

test('pilot management belongs to Owner only',()=>{
  assert.equal(permissionsFor('OWNER').includes(PERMISSIONS.MANAGE_PILOT),true);
  for(const role of ['ADMIN','MANAGER','CASHIER','PURCHASING','WAREHOUSE'])
    assert.equal(permissionsFor(role).includes(PERMISSIONS.MANAGE_PILOT),false);
});

test('cloud sale locks stock before rejecting overselling',async()=>{
  const saleSql=await read('../supabase/migrations/202607230014_checkout_payment_foundation.sql');
  assert.match(saleSql,/stock_balances[\s\S]*for update/i);
  assert.ok(saleSql.includes("v_balance.quantity<(v_line->>'baseQty')::numeric"));
  assert.ok(saleSql.includes('Stok % tidak cukup'));
});

test('pilot features use separate pages and safe recovery drill',async()=>{
  const [html,app,api]=await Promise.all([
    read('../apps/web/index.html'),read('../apps/web/app.js'),read('../api/index.mjs')
  ]);
  for(const page of ['pilot-readiness','pilot-incidents','pilot-performance','pilot-recovery','pilot-sop']){
    assert.ok(html.includes(`data-page="${page}"`));
    assert.ok(html.includes(`id="page-${page}"`));
  }
  assert.ok(app.includes('reportClientTelemetry'));
  assert.ok(app.includes('durationMs>=2500'));
  assert.ok(html.includes('Latihan tidak menimpa produksi'));
  assert.equal(html.includes('Pulihkan database sekarang'),false);
  assert.ok(api.includes("route==='pilot/telemetry'"));
  assert.ok(api.includes("detail_json:{online:input.online!==false,platform:"));
  assert.ok(api.includes("version: '2.6.0-cloud'"));
});
