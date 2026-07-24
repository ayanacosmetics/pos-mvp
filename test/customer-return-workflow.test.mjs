import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from '../api/index.mjs';

const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const ids={user:'11111111-1111-4111-8111-111111111111',tenant:'22222222-2222-4222-8222-222222222222',outlet:'33333333-3333-4333-8333-333333333333',location:'44444444-4444-4444-8444-444444444444',sale:'55555555-5555-4555-8555-555555555555',line:'66666666-6666-4666-8666-666666666666',product:'77777777-7777-4777-8777-777777777777',returned:'88888888-8888-4888-8888-888888888888'};

function environment(){
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.supabase.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  return()=>{if(previous.url===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=previous.url;if(previous.anon===undefined)delete process.env.SUPABASE_ANON_KEY;else process.env.SUPABASE_ANON_KEY=previous.anon;if(previous.service===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=previous.service;};
}

test('pencarian struk menghitung jumlah retur tersisa dan riwayat refund',async()=>{
  const originalFetch=globalThis.fetch;const restore=environment();
  globalThis.fetch=async(url)=>{const target=String(url);
    if(target.endsWith('/auth/v1/user'))return reply({id:ids.user});
    if(target.includes('/rest/v1/profiles?'))return reply([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/outlets?'))return reply([{id:ids.outlet,name:'Toko Utama',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return reply([{id:ids.location,outlet_id:ids.outlet,name:'Toko Utama',kind:'STORE'}]);
    if(target.includes('/rest/v1/sales?'))return reply([{id:ids.sale,tenant_id:ids.tenant,outlet_id:ids.outlet,customer_id:null,cashier_id:ids.user,receipt_no:'UTM-000123',payment_method:'Tunai',grand_total:'50000',status:'COMPLETED',occurred_at:'2026-07-23T10:00:00+08:00'}]);
    if(target.includes('/rest/v1/sale_items?'))return reply([{id:ids.line,tenant_id:ids.tenant,sale_id:ids.sale,product_id:ids.product,product_name:'Lip Tint',base_qty:'2',gross:'50000',discount:'0',total:'50000',cost_total:'30000'}]);
    if(target.includes('/rest/v1/customer_returns?'))return reply([{id:ids.returned,sale_id:ids.sale,return_no:'RTR-00001',reason:'Salah warna',total:'25000',refund_method:'CASH',refund_reference:null,occurred_at:'2026-07-23T11:00:00+08:00'}]);
    if(target.includes('/rest/v1/customer_return_items?'))return reply([{return_id:ids.returned,sale_item_id:ids.line,product_id:ids.product,base_qty:'1',line_total:'25000',item_condition:'SALEABLE',restockable:true}]);
    if(target.includes('/rest/v1/customer_refunds?'))return reply([{return_id:ids.returned,amount:'25000',method:'CASH',status:'COMPLETED'}]);
    return reply({message:`Mock belum menangani ${target}`},500);
  };
  try{
    let payload='';const route='sales/lookup';const request={method:'GET',url:'/api/index?route=sales%2Flookup&receiptNo=UTM-000123',query:{route,receiptNo:'UTM-000123'},headers:{authorization:'Bearer token'}};const response={statusCode:0,setHeader(){},end(value){payload=value;}};
    await handler(request,response);const sale=JSON.parse(payload).sale;
    assert.equal(response.statusCode,200);assert.equal(sale.receiptNo,'UTM-000123');assert.equal(sale.lines[0].soldQty,2);assert.equal(sale.lines[0].returnedQty,1);assert.equal(sale.lines[0].remainingQty,1);assert.equal(sale.refundableTotal,25000);assert.equal(sale.status,'PARTIALLY_RETURNED');assert.equal(sale.returns[0].refund.method,'CASH');
  }finally{globalThis.fetch=originalFetch;restore();}
});

test('fondasi retur membedakan stok layak jual, barang rusak, dan refund kas',async()=>{
  const [migration,html,script]=await Promise.all([
    readFile(new URL('../supabase/migrations/202607230010_customer_return_workflow.sql',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8')
  ]);
  assert.match(migration,/process_customer_return_v2/);assert.match(migration,/role in \('OWNER','ADMIN'\)/);assert.match(migration,/item_condition in \('SALEABLE','OPENED','DAMAGED','EXPIRED'\)/);assert.match(migration,/case when v_restockable then v_unit_cost else 0 end/);assert.match(migration,/movement_type,amount,note,actor_id,reference_type,reference_id/);assert.match(migration,/Jumlah retur melebihi sisa pada baris penjualan/);
  assert.match(html,/id="page-returns"/);assert.match(html,/id="return-receipt-search"/);assert.match(html,/Barang terbuka, rusak, atau kedaluwarsa/);assert.match(script,/effectiveRefundMethod/);assert.match(script,/\.return-condition/);
});
