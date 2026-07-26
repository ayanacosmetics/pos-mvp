import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { agingBucket, operatingProfitSummary, productHealth } from '../packages/domain/src/owner-analytics.mjs';
import { PERMISSIONS, permissionsFor } from '../packages/domain/src/permissions.mjs';
import handler from '../api/index.mjs';

const migration = await readFile(new URL('../supabase/migrations/202607270030_owner_accounting_analytics.sql', import.meta.url), 'utf8');
const api = await readFile(new URL('../api/index.mjs', import.meta.url), 'utf8');
const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');

test('laba operasional memisahkan HPP dan biaya outlet', () => {
  assert.deepEqual(operatingProfitSummary({
    netSales: 10_000_000, costOfGoods: 6_000_000, operatingExpenses: 1_500_000,
  }), {
    netSales: 10_000_000, costOfGoods: 6_000_000, grossProfit: 4_000_000,
    operatingExpenses: 1_500_000, operatingProfit: 2_500_000, operatingMarginPercent: 25,
  });
});

test('aging mengelompokkan tagihan berdasarkan jumlah hari terlambat', () => {
  const asOf = new Date('2026-07-27T12:00:00Z');
  assert.equal(agingBucket('2026-07-28', asOf), 'current');
  assert.equal(agingBucket('2026-07-20', asOf), 'days1To30');
  assert.equal(agingBucket('2026-06-10', asOf), 'days31To60');
  assert.equal(agingBucket('2026-05-01', asOf), 'daysOver60');
});

test('kesehatan produk menandai dead stock dan margin rendah secara terpisah', () => {
  assert.deepEqual(productHealth({
    stockQty: 20, netQty: 0, netRevenue: 0, grossProfit: 0,
    lastSaleOn: '2026-03-01', asOf: '2026-07-27',
  }), { marginPercent: 0, lowMargin: false, deadStock: true, slowMoving: true, fastMoving: false });
  assert.equal(productHealth({
    stockQty: 5, netQty: 10, netRevenue: 1_000_000, grossProfit: 100_000,
    lastSaleOn: '2026-07-27', asOf: '2026-07-27', fastMoving: true,
  }).lowMargin, true);
});

test('fondasi v1.26 mencakup biaya, laporan owner, halaman terpisah, ekspor, dan hak akses khusus', async () => {
  assert.equal(permissionsFor('OWNER').includes(PERMISSIONS.OWNER_FINANCE), true);
  assert.equal(permissionsFor('ADMIN').includes(PERMISSIONS.OWNER_FINANCE), false);
  assert.match(migration, /create table if not exists public\.expense_categories/);
  assert.match(migration, /create table if not exists public\.outlet_expenses/);
  assert.match(migration, /record_outlet_expense/);
  assert.match(migration, /void_outlet_expense/);
  assert.match(migration, /report_owner_finance/);
  assert.match(migration, /owner_product_analytics/);
  assert.match(migration, /role='OWNER'/);
  assert.match(migration, /upper\(payment\.method\)<>'CREDIT'/);
  assert.match(migration, /category\.cash_flow_group='OPERATING'/);
  assert.match(api, /finance\.owner/);
  assert.match(api, /route==='owner-finance'/);
  assert.match(api, /route==='outlet-expenses'/);
  for (const page of [
    'owner-profit-loss', 'owner-expenses', 'owner-cashflow', 'owner-aging',
    'owner-product-analytics', 'owner-accountant-export',
  ]) assert.match(html, new RegExp(`id="page-${page}"`));
  assert.match(html, /data-nav-group="finance"/);
  assert.match(app, /exportAccountantCsv/);
  assert.match(app, /renderOwnerProductHealth/);

  const ids = {
    user:'11111111-1111-4111-8111-111111111111',
    tenant:'22222222-2222-4222-8222-222222222222',
    outlet:'33333333-3333-4333-8333-333333333333',
    location:'44444444-4444-4444-8444-444444444444',
  };
  const originalFetch=globalThis.fetch;
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.supabase.test';
  process.env.SUPABASE_ANON_KEY='anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  const calls=[];
  globalThis.fetch=async(url,options={})=>{
    const target=String(url);calls.push({target,body:options.body?JSON.parse(options.body):null});
    const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
    if(target.endsWith('/auth/v1/user'))return response({id:ids.user});
    if(target.includes('/rest/v1/profiles?user_id='))return response([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/outlets?'))return response([{id:ids.outlet,name:'Toko Utama',timezone:'Asia/Makassar',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return response([{id:ids.location,outlet_id:ids.outlet,kind:'STORE',active:true}]);
    if(target.endsWith('/rest/v1/rpc/report_owner_finance'))return response({period:{from:'2026-07-01',to:'2026-07-27'},metrics:{operatingProfit:2500000},daily:[],expenses:[],expenseBreakdown:[],cashFlow:{methods:[]},aging:{receivables:{},payables:{}},supplierActions:[],customerActions:[]});
    if(target.endsWith('/rest/v1/rpc/owner_product_analytics'))return response({products:[]});
    if(target.includes('/rest/v1/expense_categories?'))return response([]);
    return response({message:`Mock belum menangani ${target}`},500);
  };
  try{
    let payload='';
    const response={statusCode:0,setHeader(){},end(value){payload=value;}};
    await handler({method:'GET',url:'/api/index?route=owner-finance&from=2026-07-01&to=2026-07-27',query:{route:'owner-finance',from:'2026-07-01',to:'2026-07-27'},headers:{authorization:'Bearer token'}},response);
    assert.equal(response.statusCode,200);
    assert.equal(JSON.parse(payload).metrics.operatingProfit,2500000);
    assert.deepEqual(calls.find((call)=>call.target.endsWith('/rpc/report_owner_finance')).body.p_outlet_ids,[ids.outlet]);
  }finally{
    globalThis.fetch=originalFetch;
    for(const [name,key] of [['url','SUPABASE_URL'],['anon','SUPABASE_ANON_KEY'],['service','SUPABASE_SERVICE_ROLE_KEY']]){
      if(previous[name]===undefined)delete process.env[key];else process.env[key]=previous[name];
    }
  }
});
