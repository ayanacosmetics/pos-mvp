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
      {sku:'',name:'Bedak',retailPrice:'30000'}
    ]});
    assert.equal(result.status,200);
    assert.equal(result.body.valid,true);
    assert.deepEqual(result.body.summary,{total:2,create:1,update:1,error:0});
    assert.equal(calls.some((call)=>call.options.method==='POST' && call.target.includes('/rpc/')),false);
    const createOnly=await callApi('POST','imports/preview',{kind:'PRODUCTS',mode:'CREATE_ONLY',locationId:ids.location,rows:[
      {sku:'KOS-001',name:'Lip Tint',retailPrice:'25000'}
    ]});
    assert.equal(createOnly.body.valid,false);
    assert.match(createOnly.body.errors[0].message,/Edit produk massal/);
    const updateOnly=await callApi('POST','imports/preview',{kind:'PRODUCTS',mode:'UPDATE_ONLY',locationId:ids.location,rows:[
      {sku:'',name:'Produk tanpa SKU',retailPrice:'25000'},
      {sku:'BARU-001',name:'Produk belum ada',retailPrice:'25000'}
    ]});
    assert.equal(updateOnly.body.valid,false);
    assert.equal(updateOnly.body.errors.length,2);
    assert.match(updateOnly.body.errors[0].message,/SKU wajib/);
    assert.match(updateOnly.body.errors[1].message,/Import produk baru/);
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
    if(target.includes('/rest/v1/customer_price_groups?'))return responseOf([{id:'retail',name:'Umum'},{id:'wholesale',name:'Grosir'}]);
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

test('commit produk mengalokasikan SKU kosong dan memisahkan barang baru dari edit aman',async()=>{
  const originalFetch=globalThis.fetch,previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.supabase.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  const rpcs=[];
  globalThis.fetch=async(url,options={})=>{
    const target=String(url),body=options.body?JSON.parse(options.body):null;
    if(target.endsWith('/auth/v1/user'))return responseOf({id:ids.user});
    if(target.includes('/rest/v1/profiles?'))return responseOf([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/outlets?'))return responseOf([{id:ids.outlet,name:'Toko Utama',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return responseOf([{id:ids.location,outlet_id:ids.outlet,name:'Toko Utama',kind:'STORE'}]);
    if(target.includes('/rest/v1/products?'))return responseOf(target.includes('select=sku')?[{sku:'KOS-001'}]:[{id:ids.product,sku:'KOS-001'}]);
    if(target.includes('/rest/v1/product_units?'))return responseOf([]);
    if(target.includes('/rest/v1/rpc/')){
      const name=target.split('/').pop();rpcs.push({name,body});
      if(name==='allocate_product_skus_v1')return responseOf(['000001']);
      if(name==='import_initial_data')return responseOf({created:1,updated:0,duplicate:false});
      if(name==='update_import_products_v1')return responseOf({created:0,updated:1,duplicate:false});
      return responseOf(name==='apply_import_product_settings_v1'?1:{});
    }
    return responseOf({message:`Mock belum menangani ${target}`},500);
  };
  try{
    const result=await callApi('POST','imports/commit',{kind:'PRODUCTS',fileName:'barang.xlsx',locationId:ids.location,rows:[{sku:'',name:'Baru',retailPrice:10000},{sku:'KOS-001',name:'Lip Tint Edit',retailPrice:26000}]},{'idempotency-key':'excel-1'});
    assert.equal(result.status,201);assert.deepEqual(result.body,{kind:'PRODUCTS',total:2,created:1,updated:1,duplicate:false,chunks:2});
    assert.equal(rpcs.find((call)=>call.name==='import_initial_data').body.p_rows[0].sku,'000001');
    assert.equal(rpcs.find((call)=>call.name==='update_import_products_v1').body.p_rows[0].sku,'KOS-001');
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(previous)){const envKey={url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY'}[key];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}
  }
});

test('multi satuan menerima jumlah satuan tak terbatas dan diteruskan ke transaksi khusus',async()=>{
  const originalFetch=globalThis.fetch,previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.supabase.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  let rpcBody=null;
  globalThis.fetch=async(url,options={})=>{
    const target=String(url);
    if(target.endsWith('/auth/v1/user'))return responseOf({id:ids.user});
    if(target.includes('/rest/v1/profiles?'))return responseOf([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/outlets?'))return responseOf([{id:ids.outlet,name:'Toko Utama',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return responseOf([{id:ids.location,outlet_id:ids.outlet,name:'Toko Utama',kind:'STORE'}]);
    if(target.includes('/rest/v1/products?'))return responseOf([{id:ids.product,sku:'KOS-001'}]);
    if(target.includes('/rest/v1/product_units?'))return responseOf([{product_id:ids.product,name:'pcs',factor_to_base:1,barcode:'8991'}]);
    if(target.endsWith('/rest/v1/rpc/import_product_extensions_v1')){rpcBody=JSON.parse(options.body);return responseOf({created:3,updated:1,duplicate:false});}
    return responseOf({message:`Mock belum menangani ${target}`},500);
  };
  const rows=[
    {sku:'KOS-001',unitName:'pcs',factor:1,barcode:'8991',unitPriceTotal:25000},
    {sku:'KOS-001',unitName:'pak',factor:6,barcode:'8996',unitPriceTotal:144000},
    {sku:'KOS-001',unitName:'lusin',factor:12,barcode:'89912'},
    {sku:'KOS-001',unitName:'dus',factor:144,barcode:'899144'}
  ];
  try{
    const preview=await callApi('POST','imports/preview',{kind:'PRODUCT_UNITS',rows});
    assert.equal(preview.status,200);assert.equal(preview.body.valid,true);assert.deepEqual(preview.body.summary,{total:4,create:3,update:1,error:0});
    const result=await callApi('POST','imports/commit',{kind:'PRODUCT_UNITS',fileName:'satuan.xlsx',rows},{'idempotency-key':'units-1'});
    assert.equal(result.status,201);assert.equal(result.body.total,4);assert.equal(rpcBody.p_kind,'PRODUCT_UNITS');assert.equal(rpcBody.p_rows.length,4);
    assert.equal(rpcBody.p_rows[1].unitPriceTotal,144000);
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(previous)){const envKey={url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY'}[key];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}
  }
});

test('fondasi impor memiliki audit, perlindungan stok berjalan, dan UI pratinjau Excel', async () => {
  const migration=await readFile(new URL('../supabase/migrations/202607230011_initial_data_import.sql',import.meta.url),'utf8');
  const html=await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
  const api=await readFile(new URL('../api/index.mjs',import.meta.url),'utf8');
  assert.match(migration,/create table if not exists public\.import_jobs/i);
  assert.match(migration,/sudah memiliki riwayat transaksi/i);
  assert.match(migration,/INITIAL_DATA_IMPORTED/);
  assert.match(migration,/unique\(tenant_id,idempotency_key\)/i);
  assert.match(html,/id="page-imports"/);
  assert.match(script,/imports\/preview/);
  const excelMigration=await readFile(new URL('../supabase/migrations/202607280041_excel_product_import.sql',import.meta.url),'utf8');
  assert.match(html,/Unduh template Excel/);
  assert.match(html,/xlsx\.full\.min\.js/);
  assert.match(api,/allocate_product_skus_v1/);
  assert.match(api,/update_import_products_v1/);
  assert.match(api,/restAll\('products', `tenant_id=eq\.\$\{tenant\}&active=eq\.true/);
  assert.match(api,/restAll\('product_units', `tenant_id=eq\.\$\{tenant\}&select=\*`/);
  assert.match(excelMigration,/product_import_sku_reservations/);
  assert.match(excelMigration,/PRODUCTS_MASS_UPDATED/);
  const extensionMigration=await readFile(new URL('../supabase/migrations/202607290042_product_extension_imports.sql',import.meta.url),'utf8');
  assert.match(extensionMigration,/import_product_extensions_v1/);
  assert.match(extensionMigration,/PRODUCT_UNITS_MASS_UPDATED/);
  assert.match(extensionMigration,/PRODUCT_VARIANTS_MASS_UPDATED/);
  assert.match(extensionMigration,/PRODUCT_PRICES_MASS_UPDATED/);
  assert.match(extensionMigration,/source='MANUAL'/);
  const kaspinExtensionMigration=await readFile(new URL('../supabase/migrations/202607300051_kaspin_product_extension_prices.sql',import.meta.url),'utf8');
  assert.match(kaspinExtensionMigration,/v_price\/v_factor/);
  assert.match(html,/id="open-import-products"/);
  assert.match(html,/data-product-import-kind="PRODUCT_UNITS"/);
  assert.match(html,/id="back-to-products"/);
  assert.match(html,/class="import-guide surface import-create-only"/);
  assert.match(html,/class="import-guide surface import-update-only hidden"/);
  assert.match(script,/productImportMode:'GENERAL'/);
  assert.match(script,/mode:'CREATE_ONLY'/);
  assert.match(script,/mode:'UPDATE_ONLY'/);
});
