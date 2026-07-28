import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from '../api/index.mjs';

const ids={user:'11111111-1111-4111-8111-111111111111',tenant:'22222222-2222-4222-8222-222222222222',outlet:'33333333-3333-4333-8333-333333333333',location:'44444444-4444-4444-8444-444444444444',product:'55555555-5555-4555-8555-555555555555',unit:'66666666-6666-4666-8666-666666666666'};
const responseOf=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
async function callApi(method,route,body){
  let payload='';const response={statusCode:0,setHeader(){},end(value){payload=value;}};
  await handler({method,url:`/api/index?route=${encodeURIComponent(route)}`,query:{route},headers:{authorization:'Bearer token'},body},response);
  return {status:response.statusCode,body:JSON.parse(payload)};
}

test('direktori master memuat produk aktif dan nonaktif beserta semua satuan',async()=>{
  const originalFetch=globalThis.fetch;
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.supabase.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  globalThis.fetch=async(url)=>{
    const target=String(url);
    if(target.endsWith('/auth/v1/user'))return responseOf({id:ids.user});
    if(target.includes('/rest/v1/profiles?'))return responseOf([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/outlets?'))return responseOf([{id:ids.outlet,name:'Toko',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return responseOf([{id:ids.location,outlet_id:ids.outlet,name:'Toko',kind:'STORE'}]);
    if(target.includes('/rest/v1/products?'))return responseOf([{id:ids.product,sku:'KOS-001',name:'Lip Tint',category:'Kosmetik',brand:'Nusa',image_url:'https://images.example/lip-tint.jpg',active:false,variant_group:'Velvet',variant_name:'Rose',minimum_stock:'6',track_expiry:true}]);
    if(target.includes('/rest/v1/product_units?'))return responseOf([{id:ids.unit,product_id:ids.product,name:'pcs',factor_to_base:'1',barcode:'8991'}]);
    if(target.includes('/rest/v1/price_rules?'))return responseOf([{id:'price',product_id:ids.product,customer_group_id:'retail',min_base_qty:'1',unit_price_base:'25000',priority:10}]);
    if(target.includes('/rest/v1/stock_balances?'))return responseOf([{product_id:ids.product,quantity:'4'}]);
    return responseOf({message:`Mock belum menangani ${target}`},500);
  };
  try{
    const result=await callApi('GET','products/manage');
    assert.equal(result.status,200);
    assert.equal(result.body.products[0].active,false);
    assert.equal(result.body.products[0].variantName,'Rose');
    assert.equal(result.body.products[0].imageUrl,'https://images.example/lip-tint.jpg');
    assert.equal(result.body.products[0].units[0].factor,1);
    assert.equal(result.body.products[0].stockBase,4);
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(previous)){const envKey={url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY'}[key];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}
  }
});

test('edit produk dan perubahan status memakai transaksi terproteksi',async()=>{
  const originalFetch=globalThis.fetch;
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.supabase.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  const rpcCalls=[];
  globalThis.fetch=async(url,options={})=>{
    const target=String(url);
    if(target.endsWith('/auth/v1/user'))return responseOf({id:ids.user});
    if(target.includes('/rest/v1/profiles?'))return responseOf([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/outlets?'))return responseOf([{id:ids.outlet,name:'Toko',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return responseOf([{id:ids.location,outlet_id:ids.outlet,name:'Toko',kind:'STORE'}]);
    if(target.includes('/rpc/')){rpcCalls.push({target,body:JSON.parse(options.body)});return responseOf({id:ids.product,name:'Lip Tint',sku:'KOS-001',active:false});}
    return responseOf({message:`Mock belum menangani ${target}`},500);
  };
  try{
    const edited=await callApi('PUT',`products/${ids.product}`,{sku:'kos-001',name:'Lip Tint',category:'Kosmetik',retailPrice:25000,minimumStock:6,trackExpiry:true,units:[{id:ids.unit,name:'pcs',factor:1,barcode:'8991'},{name:'lusin',factor:12,barcode:'89912'}]});
    assert.equal(edited.status,200);
    assert.ok(rpcCalls[0].target.endsWith('/rpc/save_product_v6'));
    assert.equal(rpcCalls[0].body.p_product.sku,'KOS-001');
    assert.equal(rpcCalls[0].body.p_product.units.length,2);
    const archived=await callApi('POST',`products/${ids.product}/status`,{active:false});
    assert.equal(archived.status,200);
    assert.ok(rpcCalls[1].target.endsWith('/rpc/set_product_active'));
    assert.equal(rpcCalls[1].body.p_active,false);
    const bulkDelete=await callApi('POST','products/bulk-delete',{productIds:[ids.product]});
    assert.equal(bulkDelete.status,200);
    assert.ok(rpcCalls[2].target.endsWith('/rpc/delete_products_v1'));
    assert.deepEqual(rpcCalls[2].body.p_product_ids,[ids.product]);
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(previous)){const envKey={url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY'}[key];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}
  }
});

test('migrasi dan UI menjaga histori sambil menyediakan varian dan arsip',async()=>{
  const migration=await readFile(new URL('../supabase/migrations/202607230013_product_master_management.sql',import.meta.url),'utf8');
  const html=await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
  assert.match(migration,/variant_group/);
  assert.match(migration,/PRODUCT_ARCHIVED/);
  assert.match(migration,/Purchase Order yang belum selesai/);
  assert.doesNotMatch(migration,/delete from public\.products/i);
  assert.match(html,/id="product-units-editor"/);
  assert.match(script,/loadProductManagement/);
  assert.match(script,/toggleProductStatus/);
  assert.match(html,/id="delete-selected-products"/);
  assert.match(script,/id="select-all-products"/);
  assert.match(script,/deleteSelectedProducts/);
  const bulkDeleteMigration=await readFile(new URL('../supabase/migrations/202607290043_bulk_product_delete.sql',import.meta.url),'utf8');
  assert.match(bulkDeleteMigration,/delete_products_v1/);
  assert.match(bulkDeleteMigration,/foreign_key_violation/);
  assert.match(bulkDeleteMigration,/PRODUCTS_BULK_DELETED/);
});
