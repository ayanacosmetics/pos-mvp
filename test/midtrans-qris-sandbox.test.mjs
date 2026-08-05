import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import handler from '../api/index.mjs';

const ids={user:'11111111-1111-4111-8111-111111111111',tenant:'22222222-2222-4222-8222-222222222222',outlet:'33333333-3333-4333-8333-333333333333',location:'44444444-4444-4444-8444-444444444444',intent:'55555555-5555-4555-8555-555555555555'};
const jsonResponse=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

async function callApi(method,route,body,headers={}){
  let payload='';const response={statusCode:0,setHeader(){},end(value){payload=value;}};
  await handler({method,url:`/api/index?route=${encodeURIComponent(route)}`,query:{route},headers,...(body===undefined?{}:{body})},response);
  return {status:response.statusCode,body:JSON.parse(payload)};
}

function environment(){
  const names=['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','PLATFORM_ADMIN_USER_IDS','MIDTRANS_SERVER_KEY','MIDTRANS_ENVIRONMENT'];
  const previous=Object.fromEntries(names.map((name)=>[name,process.env[name]]));
  Object.assign(process.env,{SUPABASE_URL:'https://project.supabase.test',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service',PLATFORM_ADMIN_USER_IDS:ids.user,MIDTRANS_SERVER_KEY:'SB-Mid-server-test',MIDTRANS_ENVIRONMENT:'SANDBOX'});
  return()=>{for(const name of names)previous[name]===undefined?delete process.env[name]:process.env[name]=previous[name];};
}

test('fondasi Sandbox tidak memiliki jalur mutasi penjualan atau stok',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/202608050024_midtrans_qris_sandbox_foundation.sql',import.meta.url),'utf8');
  assert.match(sql,/payment_gateway_intents/);
  assert.match(sql,/payment_gateway_events/);
  assert.match(sql,/environment in \('SANDBOX','PRODUCTION'\)/);
  assert.doesNotMatch(sql,/insert\s+into\s+public\.(sales|sale_items|payments|stock_balances|stock_ledger)/i);
  assert.doesNotMatch(sql,/update\s+public\.(sales|stock_balances)/i);
});

test('Charge Sandbox menghasilkan intent teknis tanpa memanggil sale RPC',async()=>{
  const restore=environment(),originalFetch=globalThis.fetch,calls=[];
  let orderId='';
  globalThis.fetch=async(url,options={})=>{
    const target=String(url);calls.push({target,method:options.method??'GET'});
    if(target.endsWith('/auth/v1/user'))return jsonResponse({id:ids.user});
    if(target.includes('/rest/v1/profiles?'))return jsonResponse([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Platform Admin',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/outlets?'))return jsonResponse([{id:ids.outlet,name:'Toko Utama',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return jsonResponse([{id:ids.location,outlet_id:ids.outlet,name:'Toko Utama',kind:'STORE'}]);
    if(target.endsWith('/rest/v1/payment_gateway_intents')){
      const body=JSON.parse(options.body);orderId=body.order_id;
      return jsonResponse([{id:ids.intent,...body,created_at:new Date().toISOString(),updated_at:new Date().toISOString()}]);
    }
    if(target.includes('/rest/v1/payment_gateway_intents?')&&options.method==='PATCH'){
      const body=JSON.parse(options.body);
      return jsonResponse([{id:ids.intent,tenant_id:ids.tenant,order_id:orderId,gross_amount:10000,created_at:new Date().toISOString(),...body}]);
    }
    if(target.endsWith('/rest/v1/payment_gateway_events'))return jsonResponse([]);
    if(target==='https://api.sandbox.midtrans.com/v2/charge')return jsonResponse({status_code:'201',status_message:'QRIS transaction is created',transaction_id:'midtrans-test',order_id:orderId,gross_amount:'10000.00',currency:'IDR',payment_type:'qris',transaction_status:'pending',actions:[{name:'generate-qr-code',url:'https://api.sandbox.midtrans.com/v2/qris/test/qr-code'}]});
    return jsonResponse({message:`Mock belum menangani ${target}`},500);
  };
  try{
    const result=await callApi('POST','platform/payment-gateways/midtrans/sandbox/intents',{amount:10000},{authorization:'Bearer token'});
    assert.equal(result.status,201);
    assert.equal(result.body.environment,'SANDBOX');
    assert.equal(result.body.operationalMutation,false);
    assert.equal(result.body.intent.status,'PENDING');
    assert.ok(result.body.intent.qrUrl.includes('midtrans.com'));
    assert.equal(calls.some(({target})=>/complete_sale|\/rest\/v1\/(sales|payments|stock_balances)/.test(target)),false);
  }finally{globalThis.fetch=originalFetch;restore();}
});

test('webhook dengan signature palsu ditolak sebelum mengakses database',async()=>{
  const restore=environment(),originalFetch=globalThis.fetch;let called=false;
  globalThis.fetch=async()=>{called=true;return jsonResponse({});};
  try{
    const result=await callApi('POST','webhooks/midtrans',{order_id:'NUSA-SBX-X',status_code:'200',gross_amount:'10000.00',signature_key:'palsu'});
    assert.equal(result.status,401);
    assert.match(result.body.error,/Signature/);
    assert.equal(called,false);
  }finally{globalThis.fetch=originalFetch;restore();}
});

test('webhook sah memeriksa ulang status settlement tetapi tetap tidak membuat sale',async()=>{
  const restore=environment(),originalFetch=globalThis.fetch,calls=[];
  const orderId='NUSA-SBX-VALID',grossAmount='10000.00',statusCode='200';
  const signature=createHash('sha512').update(`${orderId}${statusCode}${grossAmount}SB-Mid-server-test`).digest('hex');
  globalThis.fetch=async(url,options={})=>{
    const target=String(url);calls.push(target);
    if(target.includes('/rest/v1/payment_gateway_intents?')&&options.method!=='PATCH')return jsonResponse([{id:ids.intent,tenant_id:ids.tenant,order_id:orderId,gross_amount:10000,status:'PENDING',environment:'SANDBOX'}]);
    if(target===`https://api.sandbox.midtrans.com/v2/${orderId}/status`)return jsonResponse({status_code:'200',status_message:'Settlement',transaction_id:'midtrans-settled',order_id:orderId,gross_amount:grossAmount,currency:'IDR',payment_type:'qris',transaction_status:'settlement',fraud_status:'accept'});
    if(target.includes('/rest/v1/payment_gateway_intents?')&&options.method==='PATCH')return jsonResponse([{id:ids.intent,tenant_id:ids.tenant,order_id:orderId,gross_amount:10000,environment:'SANDBOX',...JSON.parse(options.body)}]);
    if(target.endsWith('/rest/v1/payment_gateway_events'))return jsonResponse([]);
    return jsonResponse({message:`Mock belum menangani ${target}`},500);
  };
  try{
    const result=await callApi('POST','webhooks/midtrans',{order_id:orderId,status_code:statusCode,gross_amount:grossAmount,signature_key:signature});
    assert.equal(result.status,200);
    assert.equal(result.body.status,'SETTLEMENT');
    assert.equal(result.body.operationalMutation,false);
    assert.equal(calls.some((target)=>/complete_sale|\/rest\/v1\/(sales|payments|stock_balances)/.test(target)),false);
  }finally{globalThis.fetch=originalFetch;restore();}
});

test('panel Sandbox diberi label simulasi dan hanya berada di halaman Platform Admin',async()=>{
  const [html,script]=await Promise.all([readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),readFile(new URL('../apps/web/app.js',import.meta.url),'utf8')]);
  assert.match(html,/PAYMENT LAB · PLATFORM ADMIN/);
  assert.match(html,/SIMULASI — BUKAN PEMBAYARAN ASLI/);
  assert.match(script,/operationalMutation!==false/);
  assert.match(script,/state\.session\?\.platformAdmin!==true/);
  assert.doesNotMatch(html,/option value="QRIS_MIDTRANS"/);
});
