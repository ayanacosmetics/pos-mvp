import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from '../api/index.mjs';

const ids={user:'11111111-1111-4111-8111-111111111111',tenant:'22222222-2222-4222-8222-222222222222',outlet:'33333333-3333-4333-8333-333333333333',location:'44444444-4444-4444-8444-444444444444',supplier:'55555555-5555-4555-8555-555555555555',receipt:'66666666-6666-4666-8666-666666666666',item:'77777777-7777-4777-8777-777777777777',product:'88888888-8888-4888-8888-888888888888',batch:'99999999-9999-4999-8999-999999999999'};
const responseOf=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
async function callApi(method,route,body=null,headers={},query={}){
  let payload='';const response={statusCode:0,setHeader(){},end(value){payload=value;}};
  await handler({method,url:`/api/index?route=${encodeURIComponent(route)}`,query:{route,...query},headers:{authorization:'Bearer token',...headers},body},response);
  return{status:response.statusCode,body:JSON.parse(payload)};
}
function installMock(onRpc=()=>{}){
  return async(url,options={})=>{
    const target=String(url);
    if(target.endsWith('/auth/v1/user'))return responseOf({id:ids.user});
    if(target.includes('/rest/v1/profiles?'))return responseOf([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/outlets?'))return responseOf([{id:ids.outlet,name:'Toko',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return responseOf([{id:ids.location,outlet_id:ids.outlet,name:'Gudang',kind:'WAREHOUSE',active:true}]);
    if(target.includes('/rest/v1/purchase_receipts?'))return responseOf([{id:ids.receipt,tenant_id:ids.tenant,supplier_id:ids.supplier,supplier_name:'Supplier A',location_id:ids.location,document_no:'INV-001',status:'RECEIVED',occurred_at:'2026-07-22T10:00:00Z'}]);
    if(target.includes('/rest/v1/purchase_receipt_items?'))return responseOf([{id:ids.item,receipt_id:ids.receipt,product_id:ids.product,base_qty:'12',unit_cost:'20000',batch_no:'B-01',expires_on:'2027-01-01'}]);
    if(target.includes('/rest/v1/products?'))return responseOf([{id:ids.product,sku:'SKU-1',name:'Lip Tint'}]);
    if(target.includes('/rest/v1/inventory_batches?'))return responseOf([{id:ids.batch,receipt_item_id:ids.item,available_qty:'7'}]);
    if(target.includes('/rest/v1/supplier_returns?'))return responseOf([]);
    if(target.endsWith('/rest/v1/rpc/post_supplier_return')){const input=JSON.parse(options.body);onRpc(input);return responseOf({id:'return',returnNo:'RTS-2607-00001',status:'POSTED',totalCredit:100000,itemCount:1,duplicate:false});}
    return responseOf({message:`Mock belum menangani ${target}`},500);
  };
}

test('lookup faktur membatasi retur pada stok batch yang benar-benar tersisa',async()=>{
  const original=globalThis.fetch;const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';globalThis.fetch=installMock();
  try{const result=await callApi('GET','purchase-returns/lookup',null,{}, {documentNo:'INV-001'});assert.equal(result.status,200);assert.equal(result.body.receipt.lines[0].receivedQty,12);assert.equal(result.body.receipt.lines[0].batchAvailable,7);assert.equal(result.body.receipt.lines[0].maxReturnQty,7);assert.equal(result.body.receipt.returnableCredit,140000);}
  finally{globalThis.fetch=original;for(const[key,value]of Object.entries(previous)){const envKey={url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY'}[key];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}}
});

test('posting retur meneruskan baris penerimaan dan penyelesaian ke transaksi atomik',async()=>{
  const original=globalThis.fetch;const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};let rpcBody;
  process.env.SUPABASE_URL='https://project.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';globalThis.fetch=installMock((body)=>{rpcBody=body;});
  try{const result=await callApi('POST','purchase-returns',{receiptId:ids.receipt,reason:'Kemasan rusak',settlementType:'CREDIT_NOTE',supplierReference:'CN-01',items:[{receiptItemId:ids.item,baseQty:5}]},{'idempotency-key':'return-1'});assert.equal(result.status,201);assert.equal(result.body.returnNo,'RTS-2607-00001');assert.equal(rpcBody.p_receipt_id,ids.receipt);assert.equal(rpcBody.p_items[0].receiptItemId,ids.item);assert.equal(rpcBody.p_settlement_type,'CREDIT_NOTE');}
  finally{globalThis.fetch=original;for(const[key,value]of Object.entries(previous)){const envKey={url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY'}[key];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}}
});

test('fondasi retur supplier menjaga receipt, batch, stok, kredit, idempotensi, dan audit',async()=>{
  const migration=await readFile(new URL('../supabase/migrations/202607230017_supplier_return_workflow.sql',import.meta.url),'utf8');
  const html=await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
  assert.match(migration,/create table if not exists public\.supplier_returns/);assert.match(migration,/receipt_item_id/);
  assert.match(migration,/v_qty>v_batch\.available_qty/);assert.match(migration,/SUPPLIER_RETURN_POSTED/);
  assert.match(migration,/idempotency_key/);assert.match(html,/data-purchase-view="supplier-return"/);
  assert.match(script,/findSupplierReturnReceipt/);assert.match(script,/postSupplierReturn/);
});
