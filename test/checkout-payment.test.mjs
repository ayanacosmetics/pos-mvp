import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from '../api/index.mjs';

const ids={user:'11111111-1111-4111-8111-111111111111',tenant:'22222222-2222-4222-8222-222222222222',outlet:'33333333-3333-4333-8333-333333333333',location:'44444444-4444-4444-8444-444444444444',product:'55555555-5555-4555-8555-555555555555',unit:'66666666-6666-4666-8666-666666666666',shift:'77777777-7777-4777-8777-777777777777'};
const responseOf=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
async function callApi(method,route,body,headers={}){
  let payload='';const response={statusCode:0,setHeader(){},end(value){payload=value;}};
  await handler({method,url:`/api/index?route=${encodeURIComponent(route)}`,query:{route},headers:{authorization:'Bearer token',...headers},body},response);
  return {status:response.statusCode,body:JSON.parse(payload)};
}

function installCloudMock(onRpc,{collisionOnce=false,onSequenceWrite=()=>{}}={}){
  let rpcAttempts=0;
  return async(url,options={})=>{
    const target=String(url);
    if(target.endsWith('/auth/v1/user'))return responseOf({id:ids.user});
    if(target.includes('/rest/v1/profiles?'))return responseOf([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Kasir Utama',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/outlets?'))return responseOf([{id:ids.outlet,name:'Toko Utama',receipt_prefix:'UTM',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return responseOf([{id:ids.location,outlet_id:ids.outlet,name:'Toko Utama',kind:'STORE'}]);
    if(target.includes('/rest/v1/products?'))return responseOf([{id:ids.product,sku:'SKU-1',name:'Produk',category:'Umum',brand:null,active:true}]);
    if(target.includes('/rest/v1/product_units?'))return responseOf([{id:ids.unit,product_id:ids.product,name:'pcs',factor_to_base:'1',barcode:'8991'}]);
    if(target.includes('/rest/v1/price_rules?'))return responseOf([{id:'price',product_id:ids.product,customer_group_id:'retail',min_base_qty:'1',unit_price_base:'10000',priority:10}]);
    if(target.includes('/rest/v1/stock_balances?'))return responseOf([{product_id:ids.product,quantity:'20'}]);
    if(target.includes('/rest/v1/promotions?')||target.includes('/rest/v1/promotion_versions?'))return responseOf([]);
    if(target.includes('/rest/v1/tenants?'))return responseOf([{id:ids.tenant,name:'Toko Nusa',receipt_footer:'Terima kasih'}]);
    if(target.includes('/rest/v1/sales?'))return responseOf([{receipt_no:'UTM-000004'}]);
    if(target.includes('/rest/v1/document_sequences')){onSequenceWrite(target,options);return responseOf([]);}
    if(target.endsWith('/rest/v1/rpc/complete_sale_v7')){
      const body=JSON.parse(options.body);onRpc(body);rpcAttempts+=1;
      if(collisionOnce&&rpcAttempts===1)return responseOf({code:'23505',message:'duplicate key value violates unique constraint "sales_tenant_id_receipt_no_key"'},409);
      return responseOf({id:'sale',receiptNo:'UTM-000005',status:'COMPLETED',change:5000,payments:body.p_payments});
    }
    return responseOf({message:`Mock belum menangani ${target}`},500);
  };
}

test('pembayaran tunai dan QRIS diteruskan atomik dengan kembalian tunai',async()=>{
  const originalFetch=globalThis.fetch;
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.supabase.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  let rpcBody;
  globalThis.fetch=installCloudMock((body)=>{rpcBody=body;});
  try{
    const result=await callApi('POST','sales',{lines:[{productId:ids.product,unitId:ids.unit,qty:2}],customerGroupId:'retail',shiftId:ids.shift,payments:[{method:'CASH',amount:5000,tendered:10000},{method:'QRIS',amount:15000,reference:'QR-1'}]},{'idempotency-key':'sale-split-1'});
    assert.equal(result.status,201);
    assert.equal(result.body.change,5000);
    assert.ok(rpcBody);
    assert.equal(rpcBody.p_payments.length,2);
    assert.equal(rpcBody.p_payments[0].method,'CASH');
    assert.equal(rpcBody.p_payments[1].reference,'QR-1');
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(previous)){const envKey={url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY'}[key];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}
  }
});

test('checkout menormalisasi UUID pelanggan kosong agar transaksi umum tetap dapat diproses',async()=>{
  const originalFetch=globalThis.fetch;
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.supabase.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  let rpcBody;
  globalThis.fetch=installCloudMock((body)=>{rpcBody=body;});
  try{
    const result=await callApi('POST','sales',{lines:[{productId:ids.product,unitId:ids.unit,qty:2}],customerId:'  ',customerGroupId:'member',shiftId:ids.shift,payments:[{method:'CASH',amount:20000,tendered:20000}]},{'idempotency-key':'sale-empty-customer'});
    assert.equal(result.status,201);
    assert.equal(rpcBody.p_customer_id,null);
    assert.equal(rpcBody.p_customer_group_id,'retail');
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(previous)){const envKey={url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY'}[key];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}
  }
});

test('checkout menolak shift kosong dengan pesan aplikasi sebelum memanggil database',async()=>{
  const originalFetch=globalThis.fetch;
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.supabase.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  let rpcCalled=false;
  globalThis.fetch=installCloudMock(()=>{rpcCalled=true;});
  try{
    const result=await callApi('POST','sales',{lines:[{productId:ids.product,unitId:ids.unit,qty:2}],customerId:'',shiftId:'',payments:[{method:'CASH',amount:20000,tendered:20000}]},{'idempotency-key':'sale-empty-shift'});
    assert.equal(result.status,409);
    assert.match(result.body.error,/Shift aktif tidak ditemukan/);
    assert.equal(rpcCalled,false);
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(previous)){const envKey={url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY'}[key];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}
  }
});

test('checkout memperbaiki penghitung struk dan mencoba ulang setelah benturan nomor',async()=>{
  const originalFetch=globalThis.fetch;
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.supabase.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  let rpcAttempts=0;const sequenceWrites=[];
  globalThis.fetch=installCloudMock(()=>{rpcAttempts+=1;},{collisionOnce:true,onSequenceWrite:(url,options)=>sequenceWrites.push({url,method:options.method,body:options.body})});
  try{
    const result=await callApi('POST','sales',{lines:[{productId:ids.product,unitId:ids.unit,qty:2}],customerGroupId:'retail',shiftId:ids.shift,payments:[{method:'CASH',amount:20000,tendered:20000}]},{'idempotency-key':'sale-receipt-retry'});
    assert.equal(result.status,201);
    assert.equal(result.body.receiptNo,'UTM-000005');
    assert.equal(rpcAttempts,2);
    assert.equal(sequenceWrites.length,2);
    assert.match(sequenceWrites[0].body,/"next_value":5/);
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(previous)){const envKey={url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY'}[key];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}
  }
});

test('checkout menolak alokasi pembayaran yang tidak sama dengan total',async()=>{
  const originalFetch=globalThis.fetch;
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.supabase.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  let rpcCalled=false;globalThis.fetch=installCloudMock(()=>{rpcCalled=true;});
  try{
    const result=await callApi('POST','sales',{lines:[{productId:ids.product,unitId:ids.unit,qty:2}],customerGroupId:'retail',shiftId:ids.shift,payments:[{method:'CASH',amount:5000,tendered:5000}]},{'idempotency-key':'sale-invalid'});
    assert.equal(result.status,400);
    assert.match(result.body.error,/tidak sama/);
    assert.equal(rpcCalled,false);
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(previous)){const envKey={url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY'}[key];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}
  }
});

test('fondasi checkout mencakup hold, split payment, kembalian, struk, dan kas aktual',async()=>{
  const migration=await readFile(new URL('../supabase/migrations/202607230014_checkout_payment_foundation.sql',import.meta.url),'utf8');
  const api=await readFile(new URL('../api/index.mjs',import.meta.url),'utf8');
  const html=await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
  assert.match(migration,/create table if not exists public\.parked_sales/i);
  assert.match(migration,/complete_sale_v2/);
  assert.match(migration,/abs\(v_paid-v_due\)>0\.01/);
  assert.match(migration,/tendered_amount/);
  assert.match(migration,/p_idempotency_key\|\|':stock:'\|\|v_line_index/);
  assert.match(api,/const paymentTotals=Object\.values/);
  assert.match(api,/\['CASH','TUNAI'\]\.includes\(rawMethod\)\?'CASH'/);
  assert.match(html,/id="receipt-dialog"/);
  assert.match(html,/Gabungkan beberapa metode/);
  assert.match(script,/holdCurrentCart/);
});
