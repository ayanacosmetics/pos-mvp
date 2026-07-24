import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from '../api/index.mjs';

const ids = {
  user:'11111111-1111-4111-8111-111111111111', tenant:'22222222-2222-4222-8222-222222222222',
  outlet:'33333333-3333-4333-8333-333333333333', location:'44444444-4444-4444-8444-444444444444',
  product:'55555555-5555-4555-8555-555555555555'
};
const responseOf = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const apiResponse = () => {
  let payload='';
  return { response:{statusCode:0,setHeader(){},end(value){payload=value;}}, body:()=>JSON.parse(payload) };
};
const callApi = async (method,route,body,headers={}) => {
  const output=apiResponse();
  await handler({method,url:`/api/index?route=${encodeURIComponent(route)}`,query:{route},headers:{authorization:'Bearer token',...headers},body},output.response);
  return {status:output.response.statusCode,body:output.body()};
};

test('pratinjau impor memisahkan produk baru dan produk yang diperbarui tanpa menulis data', async () => {
  const originalFetch=globalThis.fetch;
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.supabase.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  const calls=[];
  globalThis.fetch=async(url,options={})=>{
    const target=String(url);calls.push({target,options});
    if(target.endsWith('/auth/v1/user'))return responseOf({id:ids.user});
    if(target.includes('/rest/v1/profiles?'))return responseOf([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/outlets?'))return responseOf([{id:ids.outlet,name:'Toko Utama',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return responseOf([{id:ids.location,outlet_id:ids.outlet,name:'Toko Utama',kind:'STORE'}]);
    if(target.includes('/rest/v1/products?'))return responseOf([{id:ids.product,sku:'KOS-001'}]);
    if(target.includes('/rest/v1/product_units?'))return responseOf([]);
    if(target.includes('/rest/v1/stock_ledger?'))return responseOf([]);
    return responseOf({message:`Mock belum menangani ${target}`},500);
  };
  try{
    const result=await callApi('POST','imports/preview',{kind:'PRODUCTS',locationId:ids.location,rows:[
      {sku:'KOS-001',name:'Lip Tint',retailPrice:'25000'},
      {sku:'KOS-002',name:'Bedak',retailPrice:'30000'}
    ]});
    assert.equal(result.status,200);
    assert.equal(result.body.valid,true);
    assert.deepEqual(result.body.summary,{total:2,create:1,update:1,error:0});
    assert.equal(calls.some((call)=>call.options.method==='POST' && call.target.includes('/rpc/')),false);
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(previous)){const envKey={url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY'}[key];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}
  }
});

test('impor tervalidasi diteruskan ke transaksi database dengan idempotensi', async () => {
  const originalFetch=globalThis.fetch;
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.supabase.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  let rpcBody=null;
  globalThis.fetch=async(url,options={})=>{
    const target=String(url);
    if(target.endsWith('/auth/v1/user'))return responseOf({id:ids.user});
    if(target.includes('/rest/v1/profiles?'))return responseOf([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/outlets?'))return responseOf([{id:ids.outlet,name:'Toko Utama',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return responseOf([{id:ids.location,outlet_id:ids.outlet,name:'Toko Utama',kind:'STORE'}]);
    if(target.includes('/rest/v1/customers?'))return responseOf([]);
    if(target.endsWith('/rest/v1/rpc/import_initial_data')){rpcBody=JSON.parse(options.body);return responseOf({id:'job-1',kind:'CUSTOMERS',total:1,created:1,updated:0,duplicate:false});}
    return responseOf({message:`Mock belum menangani ${target}`},500);
  };
  try{
    const result=await callApi('POST','imports/commit',{kind:'CUSTOMERS',fileName:'pelanggan.csv',rows:[{code:'PLG-002',name:'Toko Cantik',groupId:'grosir'}]},{'idempotency-key':'import-command-1'});
    assert.equal(result.status,201);
    assert.equal(rpcBody.p_idempotency_key,'import-command-1');
    assert.equal(rpcBody.p_rows[0].groupId,'wholesale');
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(previous)){const envKey={url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY'}[key];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}
  }
});

test('fondasi impor memiliki audit, perlindungan stok berjalan, dan UI pratinjau', async () => {
  const migration=await readFile(new URL('../supabase/migrations/202607230011_initial_data_import.sql',import.meta.url),'utf8');
  const html=await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
  assert.match(migration,/create table if not exists public\.import_jobs/i);
  assert.match(migration,/sudah memiliki riwayat transaksi/i);
  assert.match(migration,/INITIAL_DATA_IMPORTED/);
  assert.match(migration,/unique\(tenant_id,idempotency_key\)/i);
  assert.match(html,/id="page-imports"/);
  assert.match(script,/imports\/preview/);
  assert.match(html,/Unduh contoh CSV/);
});
