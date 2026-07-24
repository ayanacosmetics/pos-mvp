import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from '../api/index.mjs';
import { quoteBasket as quoteServer } from '../packages/domain/src/pricing.mjs';
import { quoteBasket as quoteOffline } from '../apps/web/pricing.mjs';
import { products, promotionVersions } from '../packages/domain/src/seed.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('mesin harga offline menghasilkan angka yang sama dengan server', () => {
  const input = { lines: [{ productId: 'lip-tint-a', unitId: 'lip-tint-a-lusin', qty: 1 }], customerGroupId: 'retail', products, promotions: promotionVersions, at: new Date('2026-07-20T10:00:00+08:00') };
  assert.deepEqual(quoteOffline(input), quoteServer(input));
});

test('batch sinkronisasi mengirim identitas perangkat, waktu asli, dan total offline ke RPC', async () => {
  const originalFetch = globalThis.fetch;
  const previous = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://project.supabase.test'; process.env.SUPABASE_ANON_KEY = 'anon'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  const calls = [];
  const ids = { user: '11111111-1111-4111-8111-111111111111', tenant: '22222222-2222-4222-8222-222222222222', outlet: '33333333-3333-4333-8333-333333333333', location: '44444444-4444-4444-8444-444444444444', device: '55555555-5555-4555-8555-555555555555', product: '66666666-6666-4666-8666-666666666666', unit: '77777777-7777-4777-8777-777777777777', shift: '88888888-8888-4888-8888-888888888888' };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url); const body = options.body ? JSON.parse(options.body) : null; calls.push({ target, body });
    if (target.endsWith('/auth/v1/user')) return json({ id: ids.user });
    if (target.includes('/rest/v1/profiles?')) return json([{ user_id: ids.user, tenant_id: ids.tenant, display_name: 'Kasir', role: 'CASHIER', active: true }]);
    if (target.includes('/rest/v1/user_outlets?')) return json([{ outlet_id: ids.outlet }]);
    if (target.includes('/rest/v1/outlets?')) return json([{ id: ids.outlet, name: 'Toko Utama', active: true }]);
    if (target.includes('/rest/v1/stock_locations?')) return json([{ id: ids.location, outlet_id: ids.outlet, name: 'Toko Utama', kind: 'STORE' }]);
    if (target.includes('/rest/v1/products?')) return json([{ id: ids.product, sku: 'SKU-1', name: 'Lip Tint', category: 'Lip Tint', brand: 'Nusa', active: true }]);
    if (target.includes('/rest/v1/product_units?')) return json([{ id: ids.unit, product_id: ids.product, name: 'pcs', factor_to_base: '1', barcode: '8991' }]);
    if (target.includes('/rest/v1/price_rules?')) return json([{ id: 'price-1', product_id: ids.product, customer_group_id: 'retail', min_base_qty: '1', unit_price_base: '25000', priority: 1 }]);
    if (target.includes('/rest/v1/stock_balances?')) return json([{ location_id: ids.location, product_id: ids.product, quantity: '10', avg_cost: '15000' }]);
    if (target.includes('/rest/v1/promotions?')) return json([]);
    if (target.includes('/rest/v1/promotion_versions?')) return json([]);
    if (target.endsWith('/rest/v1/rpc/process_sync_sale')) return json({ key: 'offline-command-1', status: 'APPLIED', result: { receiptNo: 'UTM-000001' }, duplicate: false });
    return json({ message: `Mock belum menangani ${target}` }, 500);
  };
  try {
    let payload = '';
    const route = 'sync/sales';
    const request = { method: 'POST', url: `/api/index?route=${route}`, query: { route }, headers: { authorization: 'Bearer token' }, body: {
      device: { id: ids.device, outletId: ids.outlet, name: 'Kasir Depan', platform: 'PWA Windows' },
      commands: [{ key: 'offline-command-1', occurredAt: '2026-07-21T10:00:00+08:00', expectedTotal: 25000, payload: { shiftId: ids.shift, customerGroupId: 'retail', paymentMethod: 'Tunai', lines: [{ productId: ids.product, unitId: ids.unit, qty: 1 }], offlineQuote: { grandTotal: 25000, lines: [{ productId: ids.product, unitId: ids.unit, qty: 1, total: 25000 }] } } }]
    } };
    const response = { statusCode: 0, setHeader() {}, end(value) { payload = value; } };
    await handler(request, response);
    const body = JSON.parse(payload);
    assert.equal(response.statusCode, 200);
    assert.equal(body.results[0].status, 'APPLIED');
    const rpc = calls.find((entry) => entry.target.endsWith('/rpc/process_sync_sale'));
    assert.equal(rpc.body.p_device_id, ids.device);
    assert.equal(rpc.body.p_occurred_at, '2026-07-21T10:00:00+08:00');
    assert.equal(rpc.body.p_expected_total, 25000);
    assert.equal(rpc.body.p_quote.grandTotal, 25000);
    assert.equal(rpc.body.p_payload.offlineQuote.grandTotal, 25000);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
    if (previous.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.service;
  }
});

test('owner dapat mempertahankan harga kasir untuk transaksi offline yang konflik', async () => {
  const originalFetch = globalThis.fetch;
  const previous = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://project.supabase.test'; process.env.SUPABASE_ANON_KEY = 'anon'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  const commandId = '99999999-9999-4999-8999-999999999999'; const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url); const body = options.body ? JSON.parse(options.body) : null; calls.push({ target, body });
    if (target.endsWith('/auth/v1/user')) return json({ id: '11111111-1111-4111-8111-111111111111' });
    if (target.includes('/rest/v1/profiles?')) return json([{ user_id: '11111111-1111-4111-8111-111111111111', tenant_id: '22222222-2222-4222-8222-222222222222', display_name: 'Owner', role: 'OWNER', active: true }]);
    if (target.includes('/rest/v1/outlets?')) return json([{ id: '33333333-3333-4333-8333-333333333333', active: true }]);
    if (target.includes('/rest/v1/stock_locations?')) return json([{ id: '44444444-4444-4444-8444-444444444444', outlet_id: '33333333-3333-4333-8333-333333333333', kind: 'STORE' }]);
    if (target.endsWith('/rest/v1/rpc/resolve_sync_sale')) return json({ id: commandId, status: 'APPLIED', result: { receiptNo: 'UTM-000002' } });
    return json({ message: `Mock belum menangani ${target}` }, 500);
  };
  try {
    let payload = ''; const route = `sync/commands/${commandId}/honor-offline`;
    const request = { method: 'POST', url: `/api/index?route=${route}`, query: { route }, headers: { authorization: 'Bearer token' }, body: {} };
    const response = { statusCode: 0, setHeader() {}, end(value) { payload = value; } };
    await handler(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(payload).status, 'APPLIED');
    const rpc = calls.find((entry) => entry.target.endsWith('/rpc/resolve_sync_sale'));
    assert.equal(rpc.body.p_command_id, commandId);
    assert.equal(rpc.body.p_action, 'HONOR_OFFLINE');
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
    if (previous.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.service;
  }
});

test('fondasi peninjauan konflik menyediakan tiga keputusan dan validasi snapshot', async () => {
  const [migration, html, script] = await Promise.all([
    readFile(new URL('../supabase/migrations/202607230009_offline_conflict_review.sql', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8')
  ]);
  assert.match(migration, /HONOR_OFFLINE/);
  assert.match(migration, /APPLY_SERVER/);
  assert.match(migration, /OFFLINE_SALE_REJECTED/);
  assert.match(migration, /Isi snapshot harga tidak sama dengan keranjang offline/);
  assert.match(migration, /role in \('OWNER','ADMIN'\)/);
  assert.match(html, /id="page-sync-review"/);
  assert.match(script, /Pertahankan total kasir/);
  assert.match(script, /offlineQuote: structuredClone\(state\.quote\)/);
  assert.match(script, /data-action="apply-server"/);
});

test('antrean konflik cloud menampilkan kasir, outlet, perangkat, selisih, dan rincian barang', async () => {
  const originalFetch = globalThis.fetch;
  const previous = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://project.supabase.test'; process.env.SUPABASE_ANON_KEY = 'anon'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  const ids = { user:'11111111-1111-4111-8111-111111111111',tenant:'22222222-2222-4222-8222-222222222222',outlet:'33333333-3333-4333-8333-333333333333',location:'44444444-4444-4444-8444-444444444444',device:'55555555-5555-4555-8555-555555555555',command:'99999999-9999-4999-8999-999999999999' };
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith('/auth/v1/user')) return json({ id:ids.user });
    if (target.includes('/rest/v1/profiles?')) return json([{ user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner Toko',role:'OWNER',active:true }]);
    if (target.includes('/rest/v1/outlets?')) return json([{ id:ids.outlet,name:'Toko Utama',timezone:'Asia/Makassar',active:true }]);
    if (target.includes('/rest/v1/stock_locations?')) return json([{ id:ids.location,outlet_id:ids.outlet,name:'Toko Utama',kind:'STORE' }]);
    if (target.includes('/rest/v1/sync_commands?')) return json([{ id:ids.command,device_id:ids.device,actor_id:ids.user,outlet_id:ids.outlet,idempotency_key:'offline-1',occurred_at:'2026-07-23T10:00:00+08:00',received_at:'2026-07-23T10:05:00+08:00',status:'NEEDS_REVIEW',payload:{ paymentMethod:'Tunai',customerGroupId:'retail',offlineQuote:{ lines:[{}] },_serverQuote:{ lines:[{ productId:'product-1',productName:'Lip Tint',unitName:'pcs',qty:1,baseQty:1,gross:26000,discount:0,total:26000 }] } },result_json:{ expectedTotal:25000,serverTotal:26000 } }]);
    if (target.includes('/rest/v1/pos_devices?')) return json([{ id:ids.device,name:'Kasir Depan',platform:'Windows',active:true }]);
    return json({ message:`Mock belum menangani ${target}` },500);
  };
  try {
    let payload=''; const route='sync/review';
    const request={ method:'GET',url:`/api/index?route=${route}`,query:{route},headers:{authorization:'Bearer token'} };
    const response={ statusCode:0,setHeader(){},end(value){payload=value;} };
    await handler(request,response);
    const body=JSON.parse(payload); const command=body.commands[0];
    assert.equal(response.statusCode,200);
    assert.equal(command.cashierName,'Owner Toko');
    assert.equal(command.outletName,'Toko Utama');
    assert.equal(command.device.name,'Kasir Depan');
    assert.equal(command.difference,1000);
    assert.equal(command.canHonorOffline,true);
    assert.equal(command.lines[0].productName,'Lip Tint');
  } finally {
    globalThis.fetch=originalFetch;
    if (previous.url===undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL=previous.url;
    if (previous.anon===undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY=previous.anon;
    if (previous.service===undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY=previous.service;
  }
});
