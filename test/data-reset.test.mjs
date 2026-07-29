import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from '../api/index.mjs';

const read=(path)=>readFile(new URL(path,import.meta.url),'utf8');
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const ids={
  user:'11111111-1111-4111-8111-111111111111',
  tenant:'22222222-2222-4222-8222-222222222222',
  outlet:'33333333-3333-4333-8333-333333333333',
  location:'44444444-4444-4444-8444-444444444444'
};

async function call(route,body={}) {
  let payload='';
  const request={method:'POST',url:`/api/index?route=${route}`,query:{route},headers:{authorization:'Bearer owner-token'},body};
  const response={statusCode:0,setHeader(){},end(value){payload=value;}};
  await handler(request,response);
  return {status:response.statusCode,body:JSON.parse(payload)};
}

test('reset data tersedia hanya sebagai alur Owner dengan backup dan OTP',async()=>{
  const [html,app,api,sql,fkFix]=await Promise.all([
    read('../apps/web/index.html'),read('../apps/web/app.js'),read('../api/index.mjs'),
    read('../supabase/migrations/202607290045_owner_selective_data_reset.sql'),
    read('../supabase/migrations/202607290046_reset_purchase_batch_fk.sql')
  ]);
  for(const id of ['data-reset-settings','data-reset-form','request-data-reset-otp','data-reset-otp','data-reset-phrase','execute-data-reset'])assert.ok(html.includes(`id="${id}"`));
  for(const scope of ['ALL','TRANSACTIONS','CATALOG','CUSTOMERS','SUPPLIERS','PROMOTIONS','FINANCE','WORKFORCE'])assert.ok(html.includes(`value="${scope}"`));
  assert.match(html,/Tetap dipertahankan/);
  for(const fn of ['selectedDataResetScopes','syncDataResetForm','requestDataResetOtp','executeDataReset','downloadJsonSnapshot'])assert.ok(app.includes(`function ${fn}`));
  assert.match(api,/route==='data-reset\/otp'/);
  assert.match(api,/route==='data-reset\/execute'/);
  assert.match(api,/session\.profile\.role!=='OWNER'/);
  assert.match(api,/\\d\{6,10\}/);
  assert.match(html,/maxlength="10"/);
  assert.match(api,/kasir-nusa-sebelum-reset-/);
  assert.match(sql,/security definer/i);
  assert.match(sql,/role='OWNER'/);
  assert.match(sql,/TENANT_DATA_RESET/);
  assert.doesNotMatch(sql,/delete from public\.(tenants|profiles|outlets|stock_locations|audit_logs|backup_exports)\b/i);
  assert.match(fkFix,/inventory_batches_receipt_item_id_fkey/);
  assert.match(fkFix,/inventory_batches_receipt_id_fkey/);
  assert.equal((fkFix.match(/on delete set null/g)??[]).length,2);
});

test('OTP reset dikirim ke email akun Owner aktif dan dicatat di audit',async()=>{
  const originalFetch=globalThis.fetch;
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://reset.supabase.test';
  process.env.SUPABASE_ANON_KEY='anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  const calls=[];
  globalThis.fetch=async(url,options={})=>{
    const target=String(url),body=options.body?JSON.parse(options.body):null;
    calls.push({target,body});
    if(target.endsWith('/auth/v1/user'))return reply({id:ids.user,email:'owner@example.com'});
    if(target.includes('/rest/v1/profiles?'))return reply([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/user_outlets?'))return reply([{outlet_id:ids.outlet}]);
    if(target.includes('/rest/v1/outlets?'))return reply([{id:ids.outlet,name:'Toko Utama',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return reply([{id:ids.location,outlet_id:ids.outlet,name:'Toko',kind:'STORE',active:true}]);
    if(target.endsWith('/rest/v1/rpc/reset_tenant_data_v1'))return reply({message:'Hanya Owner aktif yang dapat mereset data'},400);
    if(target.endsWith('/auth/v1/otp'))return reply({});
    if(target.endsWith('/rest/v1/audit_logs'))return reply([]);
    return reply({message:`Mock belum menangani ${target}`},500);
  };
  try{
    const result=await call('data-reset/otp',{scopes:['TRANSACTIONS']});
    assert.equal(result.status,200);
    assert.equal(result.body.emailMasked,'ow***@example.com');
    assert.deepEqual(calls.find((entry)=>entry.target.endsWith('/auth/v1/otp')).body,{email:'owner@example.com',create_user:false});
    assert.equal(calls.find((entry)=>entry.target.endsWith('/rest/v1/audit_logs')).body.action,'TENANT_DATA_RESET_OTP_REQUESTED');
  }finally{
    globalThis.fetch=originalFetch;
    if(previous.url===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=previous.url;
    if(previous.anon===undefined)delete process.env.SUPABASE_ANON_KEY;else process.env.SUPABASE_ANON_KEY=previous.anon;
    if(previous.service===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=previous.service;
  }
});
