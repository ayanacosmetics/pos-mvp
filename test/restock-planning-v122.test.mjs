import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from '../api/index.mjs';

const readSource = async () => Promise.all([
  readFile(new URL('../supabase/migrations/202607260027_restock_purchase_planning.sql', import.meta.url), 'utf8'),
  readFile(new URL('../api/index.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8')
]);

test('fondasi v1.22 menghitung kebutuhan restok dan membuat draft PO yang diaudit', async () => {
  const [migration, api] = await readSource();
  assert.match(migration, /create table if not exists public\.restock_policies/);
  assert.match(migration, /minimum_stock[\s\S]*maximum_stock[\s\S]*safety_stock[\s\S]*lead_time_days/);
  assert.match(migration, /average_daily_sales[\s\S]*on_order[\s\S]*suggested_qty/);
  assert.match(migration, /case when stock<=0 then 'OUT_OF_STOCK'/);
  assert.match(migration, /create_restock_purchase_order_v1/);
  assert.match(migration, /RESTOCK_DRAFT_CREATED/);
  assert.match(api, /route === 'restock-planning'/);
  assert.match(api, /route === 'restock-planning\/draft'/);
  assert.match(api, /create_restock_purchase_order_v1/);
});

test('approval PO berdasarkan nilai, keterlambatan, dan tren supplier tersedia', async () => {
  const [migration, api] = await readSource();
  assert.match(migration, /approval_threshold numeric/);
  assert.match(migration, /v_order\.grand_total>v_threshold/);
  assert.match(migration, /case when v_required then 'SUBMITTED' else 'APPROVED'/);
  assert.match(api, /outstanding_qty/);
  assert.match(api, /overdue: Boolean/);
  assert.match(api, /previousCost[\s\S]*trendPercentage/);
});

test('UI v1.22 menyediakan filter, kebijakan restok, draft rekomendasi, dan tampilan responsif', async () => {
  const [, , html, script, css] = await readSource();
  for (const id of [
    'purchase-view-planning','planning-location','planning-supplier-filter',
    'restock-planning-list','create-planning-draft','restock-policy-dialog'
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(script, /function loadRestockPlanning/);
  assert.match(script, /function createPlanningDraft/);
  assert.match(script, /Pilih supplier tujuan pesanan/);
  assert.match(css, /\.planning-layout/);
  assert.match(css, /@media\(max-width:700px\).*\.planning-row/);
});

test('API meneruskan lokasi rencana dan membuat draft rekomendasi melalui RPC atomik', async () => {
  const originalFetch=globalThis.fetch;
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.supabase.test';
  process.env.SUPABASE_ANON_KEY='anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  const ids={user:'11111111-1111-4111-8111-111111111111',tenant:'22222222-2222-4222-8222-222222222222',outlet:'33333333-3333-4333-8333-333333333333',location:'44444444-4444-4444-8444-444444444444',supplier:'55555555-5555-4555-8555-555555555555',product:'66666666-6666-4666-8666-666666666666'};
  const calls=[];
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  globalThis.fetch=async(url,options={})=>{
    const target=String(url);const body=options.body?JSON.parse(options.body):null;calls.push({target,body});
    if(target.endsWith('/auth/v1/user'))return reply({id:ids.user});
    if(target.includes('/rest/v1/profiles?'))return reply([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/outlets?'))return reply([{id:ids.outlet,tenant_id:ids.tenant,name:'Toko',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return reply([{id:ids.location,tenant_id:ids.tenant,outlet_id:ids.outlet,name:'Gudang',kind:'WAREHOUSE',active:true}]);
    if(target.endsWith('/rest/v1/rpc/get_restock_recommendations_v1'))return reply({locationId:ids.location,settings:{approvalThreshold:5000000,lookbackDays:30},recommendations:[]});
    if(target.endsWith('/rest/v1/rpc/create_restock_purchase_order_v1'))return reply({id:'77777777-7777-4777-8777-777777777777',po_no:'PO-2607-00009',status:'DRAFT',planningSource:'RESTOCK_PLAN'});
    return reply({message:`Mock belum menangani ${target}`},500);
  };
  const call=async(method,route,body={},query={})=>{
    let payload='';const response={statusCode:0,setHeader(){},end(value){payload=value;}};
    await handler({method,url:`/api/index?route=${route}`,query:{route,...query},headers:{authorization:'Bearer token'},body},response);
    return{status:response.statusCode,body:JSON.parse(payload)};
  };
  try{
    const plan=await call('GET','restock-planning',{}, {locationId:ids.location});
    assert.equal(plan.status,200);
    assert.equal(plan.body.locationId,ids.location);
    const draft=await call('POST','restock-planning/draft',{
      supplierId:ids.supplier,locationId:ids.location,expectedOn:'2026-08-02',
      items:[{productId:ids.product,baseQty:12,unitCost:18000}]
    });
    assert.equal(draft.status,201);
    assert.equal(draft.body.planningSource,'RESTOCK_PLAN');
    assert.equal(calls.find((entry)=>entry.target.endsWith('/rpc/get_restock_recommendations_v1')).body.p_location_id,ids.location);
    assert.equal(calls.find((entry)=>entry.target.endsWith('/rpc/create_restock_purchase_order_v1')).body.p_items[0].baseQty,12);
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,name] of Object.entries({url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY'})){
      if(previous[key]===undefined)delete process.env[name];else process.env[name]=previous[key];
    }
  }
});
