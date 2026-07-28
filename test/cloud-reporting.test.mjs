import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from '../api/index.mjs';

const ids = {
  user: '11111111-1111-4111-8111-111111111111', tenant: '22222222-2222-4222-8222-222222222222',
  outlet: '33333333-3333-4333-8333-333333333333', location: '44444444-4444-4444-8444-444444444444'
};
const responseOf = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function environment() {
  const previous = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://project.supabase.test'; process.env.SUPABASE_ANON_KEY = 'anon'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  return () => {
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
    if (previous.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.service;
  };
}

async function invoke(query) {
  let payload = '';
  const request = { method: 'GET', url: `/api/index?${new URLSearchParams(query)}`, query, headers: { authorization: 'Bearer token' } };
  const response = { statusCode: 0, setHeader() {}, end(value) { payload = value; } };
  await handler(request, response);
  return { status: response.statusCode, body: JSON.parse(payload) };
}

test('laporan cloud memakai RPC return-aware dengan periode dan outlet yang tervalidasi', async () => {
  const originalFetch = globalThis.fetch; const restore = environment(); const calls = [];
  const report = { period: { from: '2026-07-01', to: '2026-07-21' }, metrics: { netSales: 900000, returnTotal: 100000 }, daily: [], products: [], outlets: [], recentSales: [], suppliers: [] };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url); const body = options.body ? JSON.parse(options.body) : null; calls.push({ target, body });
    if (target.endsWith('/auth/v1/user')) return responseOf({ id: ids.user });
    if (target.includes('/rest/v1/profiles?user_id=')) return responseOf([{ user_id: ids.user, tenant_id: ids.tenant, display_name: 'Owner', role: 'OWNER', active: true }]);
    if (target.includes('/rest/v1/outlets?')) return responseOf([{ id: ids.outlet, name: 'Toko Utama', timezone: 'Asia/Makassar', active: true }]);
    if (target.includes('/rest/v1/stock_locations?')) return responseOf([{ id: ids.location, outlet_id: ids.outlet, kind: 'STORE' }]);
    if (target.endsWith('/rest/v1/rpc/report_operational_summary')) return responseOf(report);
    if (target.endsWith('/rest/v1/rpc/supplier_return_report_adjustments')) return responseOf({totalReturnCredit:25000,suppliers:[]});
    return responseOf({ message: `Mock belum menangani ${target}` }, 500);
  };
  try {
    const result = await invoke({ route: 'reports/summary', from: '2026-07-01', to: '2026-07-21', outletId: ids.outlet });
    assert.equal(result.status, 200);
    assert.equal(result.body.metrics.netSales, 900000);
    assert.equal(result.body.metrics.purchaseReturnValue,25000);
    const rpc = calls.find((call) => call.target.endsWith('/rpc/report_operational_summary'));
    assert.deepEqual(rpc.body.p_outlet_ids, [ids.outlet]);
    assert.equal(rpc.body.p_from, '2026-07-01');
    assert.equal(rpc.body.p_to, '2026-07-21');
    assert.equal(rpc.body.p_timezone, 'Asia/Makassar');
  } finally { globalThis.fetch = originalFetch; restore(); }
});

test('laporan selama ini diringkas per tahun untuk alur detail bertingkat', async () => {
  const originalFetch=globalThis.fetch;const restore=environment();const calls=[];
  globalThis.fetch=async(url,options={})=>{
    const target=String(url),body=options.body?JSON.parse(options.body):null;calls.push({target,body});
    if(target.endsWith('/auth/v1/user'))return responseOf({id:ids.user});
    if(target.includes('/rest/v1/profiles?user_id='))return responseOf([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/outlets?'))return responseOf([{id:ids.outlet,name:'Toko Utama',timezone:'Asia/Makassar',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return responseOf([{id:ids.location,outlet_id:ids.outlet,kind:'STORE'}]);
    if(target.includes('/rest/v1/sales?'))return responseOf([{occurred_at:'2025-04-10T10:00:00+08:00'}]);
    if(target.endsWith('/rest/v1/rpc/report_operational_summary'))return responseOf({metrics:{netSales:100000,grossProfit:30000,returnTotal:5000,transactionCount:4}});
    return responseOf({message:`Mock belum menangani ${target}`},500);
  };
  try{
    const result=await invoke({route:'reports/sales-years',outletId:ids.outlet});
    assert.equal(result.status,200);assert.equal(result.body.fromYear,2025);assert.equal(result.body.years.length,2);
    const reportCalls=calls.filter((call)=>call.target.endsWith('/rpc/report_operational_summary'));
    assert.equal(reportCalls[0].body.p_from,'2025-01-01');assert.equal(reportCalls[0].body.p_to,'2025-12-31');
  }finally{globalThis.fetch=originalFetch;restore();}
});

test('fondasi laporan menghitung retur, pembelian, outlet scope, dan menyediakan ekspor CSV', async () => {
  const [migration, html, script, server] = await Promise.all([
    readFile(new URL('../supabase/migrations/202607210008_reporting_foundation.sql', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../apps/api/src/server.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(migration, /customer_return_items/);
  assert.match(migration, /return_cost/);
  assert.match(migration, /user_outlets/);
  assert.match(migration, /purchase_value/);
  assert.match(migration, /Periode laporan maksimal 366 hari/);
  assert.match(html, /id="report-from"/);
  assert.match(html, /id="outlet-performance"/);
  assert.match(html, /id="export-report"/);
  assert.match(script, /function exportReportCsv/);
  assert.match(server, /'\.mjs': 'text\/javascript; charset=utf-8'/);
});
