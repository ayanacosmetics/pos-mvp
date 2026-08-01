import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from '../api/index.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
});
const ids = {
  user:'11111111-1111-4111-8111-111111111111',
  tenant:'22222222-2222-4222-8222-222222222222',
  outlet:'33333333-3333-4333-8333-333333333333',
  location:'44444444-4444-4444-8444-444444444444',
  product:'55555555-5555-4555-8555-555555555555'
};

async function call(method, route, body, headers = {}) {
  let payload = '';
  const request = {
    method,
    url:`/api/index?route=${route}`,
    query:{ route },
    headers:{ authorization:'Bearer stock-user', ...headers },
    body
  };
  const response = { statusCode:0, setHeader() {}, end(value) { payload = value; } };
  await handler(request, response);
  return { status:response.statusCode, body:JSON.parse(payload) };
}

test('manajemen stok menyediakan daftar dan semua tindakan per barang', async () => {
  const [html, app, api] = await Promise.all([
    read('../apps/web/index.html'),
    read('../apps/web/app.js'),
    read('../api/index.mjs')
  ]);
  for (const id of ['stock-management-search','stock-management-filter','stock-product-dialog','stock-adjustment-form','stock-product-log']) {
    assert.ok(html.includes(`id="${id}"`));
  }
  for (const label of ['Tambah stok','Kurangi stok','Lihat stok','Log barang','Edit produk']) assert.ok(html.includes(label));
  for (const functionName of ['renderStockManagement','openStockProduct','submitStockAdjustment','renderStockProductLog','openStockSaleReceipt']) {
    assert.ok(app.includes(`function ${functionName}`));
  }
  for(const detail of ['data-stock-log-id','Dilakukan oleh','Penyebab','data-open-stock-sale']) assert.ok(app.includes(detail));
  for(const detail of ['Masuk','Keluar','Riwayat Kaspin','balanceEstimated']) assert.ok(app.includes(detail));
  assert.ok(api.includes("route.match(/^inventory-products\\/([^/]+)\\/adjustments$/)"));
  assert.ok(api.includes("route.match(/^inventory-products\\/([^/]+)$/)"));
  assert.ok(api.includes("route.match(/^inventory-sales\\/([^/]+)\\/receipt$/)"));
  for(const field of ['actorName','documentNo','canOpenReceipt']) assert.ok(api.includes(field));
});

test('log barang menggabungkan pembelian dan penjualan Kaspin tanpa mengubah stok akhir', async () => {
  const originalFetch=globalThis.fetch;
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://stock-history.supabase.test';
  process.env.SUPABASE_ANON_KEY='anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  globalThis.fetch=async(url)=>{
    const target=String(url);
    if(target.endsWith('/auth/v1/user'))return reply({id:ids.user});
    if(target.includes('/rest/v1/profiles?'))return reply([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/outlets?'))return reply([{id:ids.outlet,name:'Toko Utama',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return reply([{id:ids.location,outlet_id:ids.outlet,name:'Toko Utama',kind:'STORE',active:true}]);
    if(target.includes('/rest/v1/products?'))return reply([{id:ids.product,sku:'KP-8994460553218',name:'SCORA BRIGHT ME UP SUNSCREEN',category:'sunscreen',brand:'',minimum_stock:0,track_expiry:false,active:true}]);
    if(target.includes('/rest/v1/stock_balances?'))return reply([{tenant_id:ids.tenant,location_id:ids.location,product_id:ids.product,quantity:'5',avg_cost:'41000'}]);
    if(target.includes('/rest/v1/inventory_batches?'))return reply([]);
    if(target.includes('/rest/v1/stock_ledger?'))return reply([{id:'opening',tenant_id:ids.tenant,location_id:ids.location,product_id:ids.product,delta:'5',balance_after:'5',unit_cost:'41000',event_type:'OPENING_IMPORT',reference_id:null,actor_id:null,occurred_at:'2026-08-01T15:20:50Z'}]);
    if(target.includes('/rest/v1/sale_stock_allocations?'))return reply([]);
    if(target.includes('/rest/v1/sales?')&&target.includes('source_system=eq.KASPIN'))return reply([{id:'sale-kaspin',receipt_no:'KASPIN-001',occurred_at:'2026-07-31T02:41:31Z',source_cashier:'Kasir Pintar',status:'COMPLETED'}]);
    if(target.includes('/rest/v1/sale_items?'))return reply([{id:'sale-line',sale_id:'sale-kaspin',base_qty:'1',cost_total:'41000'}]);
    if(target.includes('/rest/v1/purchase_receipt_items?'))return reply([{id:'purchase-line',receipt_id:'purchase-kaspin',base_qty:'6',unit_cost:'41000',supplier_name:'Supplier 1',document_no:'KASPIN-BUY-001',received_at:'2026-07-30T09:33:30Z'}]);
    return reply({message:`Mock belum menangani ${target}`},500);
  };
  try{
    const result=await call('GET',`inventory-products/${ids.product}`);
    assert.equal(result.status,200);
    assert.deepEqual(result.body.ledger.map((entry)=>[entry.eventType,entry.delta,entry.balanceAfter]),[
      ['OPENING_IMPORT',5,5],['KASPIN_SALE',-1,5],['KASPIN_PURCHASE',6,6]
    ]);
    assert.equal(result.body.balances[0].quantity,5);
    assert.equal(result.body.ledger[1].balanceEstimated,true);
  }finally{
    globalThis.fetch=originalFetch;
    if(previous.url===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=previous.url;
    if(previous.anon===undefined)delete process.env.SUPABASE_ANON_KEY;else process.env.SUPABASE_ANON_KEY=previous.anon;
    if(previous.service===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=previous.service;
  }
});

test('manajemen stok memuat produk setelah batas 1.000 baris Supabase', async () => {
  const originalFetch = globalThis.fetch;
  const previous = {
    url:process.env.SUPABASE_URL,
    anon:process.env.SUPABASE_ANON_KEY,
    service:process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  process.env.SUPABASE_URL = 'https://stock-pagination.supabase.test';
  process.env.SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  const firstPage=Array.from({length:1000},(_,index)=>({
    id:`product-${index}`,sku:`SKU-${index}`,name:`Produk ${index}`,
    category:'Kategori',brand:'',minimum_stock:0,track_expiry:false,active:true
  }));
  const lastProduct={id:'product-scora',sku:'KP-8994460553218',name:'SCORA BRIGHT ME UP SUNSCREEN',category:'sunscreen',brand:'',minimum_stock:0,track_expiry:false,active:true};
  globalThis.fetch = async (url) => {
    const target=String(url);
    if(target.endsWith('/auth/v1/user'))return reply({id:ids.user});
    if(target.includes('/rest/v1/profiles?'))return reply([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/outlets?'))return reply([{id:ids.outlet,name:'Toko Utama',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return reply([{id:ids.location,outlet_id:ids.outlet,name:'Toko Utama',kind:'STORE',active:true}]);
    if(target.includes('/rest/v1/stock_balances?'))return reply([]);
    if(target.includes('/rest/v1/stock_ledger?'))return reply([]);
    if(target.includes('/rest/v1/products?'))return reply(target.includes('offset=1000')?[lastProduct]:firstPage);
    return reply({message:`Mock belum menangani ${target}`},500);
  };
  try{
    const result=await call('GET','inventory');
    assert.equal(result.status,200);
    assert.equal(result.body.products.length,1001);
    assert.equal(result.body.products.at(-1).sku,'KP-8994460553218');
  }finally{
    globalThis.fetch=originalFetch;
    if(previous.url===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=previous.url;
    if(previous.anon===undefined)delete process.env.SUPABASE_ANON_KEY;else process.env.SUPABASE_ANON_KEY=previous.anon;
    if(previous.service===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=previous.service;
  }
});

test('lapisan HPP transaksi memakai FEFO/FIFO dan mencatat modal batch aktual', async () => {
  const sql = await read('../supabase/migrations/202607290044_stock_management_fifo_cost.sql');
  for (const name of ['sale_stock_allocations','stock_adjustments','adjust_product_stock_v1','price_sale_item_from_layers_v1','restore_voided_sale_layers_v1']) {
    assert.ok(sql.includes(name));
  }
  assert.match(sql, /order by expires_on asc nulls last,received_at asc,id asc for update/i);
  assert.match(sql, /new\.cost_total:=round\(v_cost,4\)/i);
  assert.match(sql, /update public\.sales set cost_total=round\(v_actual,4\)/i);
  assert.match(sql, /update public\.inventory_batches set available_qty=available_qty\+v_take/i);
});

test('petugas gudang dapat menyesuaikan stok tanpa membuka atau menimpa modal', async () => {
  const originalFetch = globalThis.fetch;
  const previous = {
    url:process.env.SUPABASE_URL,
    anon:process.env.SUPABASE_ANON_KEY,
    service:process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  process.env.SUPABASE_URL = 'https://stock.supabase.test';
  process.env.SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ target, body });
    if (target.endsWith('/auth/v1/user')) return reply({ id:ids.user });
    if (target.includes('/rest/v1/profiles?')) return reply([{ user_id:ids.user, tenant_id:ids.tenant, display_name:'Gudang', role:'WAREHOUSE', active:true }]);
    if (target.includes('/rest/v1/user_outlets?')) return reply([{ outlet_id:ids.outlet }]);
    if (target.includes('/rest/v1/outlets?')) return reply([{ id:ids.outlet, name:'Toko Utama', active:true }]);
    if (target.includes('/rest/v1/stock_locations?')) return reply([{ id:ids.location, outlet_id:ids.outlet, name:'Gudang', kind:'WAREHOUSE', active:true }]);
    if (target.endsWith('/rest/v1/rpc/adjust_product_stock_v1')) {
      return reply({ id:'adjustment', direction:'IN', quantity:2, balanceAfter:12, duplicate:false });
    }
    return reply({ message:`Mock belum menangani ${target}` }, 500);
  };
  try {
    const result = await call(
      'POST',
      `inventory-products/${ids.product}/adjustments`,
      { direction:'IN', locationId:ids.location, quantity:2, unitCost:999999, reason:'Koreksi stok awal' },
      { 'idempotency-key':'stock-adjustment-1' }
    );
    assert.equal(result.status, 201);
    const rpc = calls.find((entry) => entry.target.endsWith('/rpc/adjust_product_stock_v1'));
    assert.equal(rpc.body.p_unit_cost, null);
    assert.equal(rpc.body.p_quantity, 2);
    assert.equal(rpc.body.p_reason, 'Koreksi stok awal');
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
    if (previous.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.service;
  }
});
