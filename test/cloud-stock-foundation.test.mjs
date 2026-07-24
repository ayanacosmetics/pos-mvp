import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/index.mjs';

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ids = {
  user: '11111111-1111-4111-8111-111111111111', tenant: '22222222-2222-4222-8222-222222222222',
  outlet: '33333333-3333-4333-8333-333333333333', store: '44444444-4444-4444-8444-444444444444',
  warehouse: '55555555-5555-4555-8555-555555555555', product: '66666666-6666-4666-8666-666666666666',
  sale: '77777777-7777-4777-8777-777777777777'
};

function environment(role = 'OWNER') {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url); const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ target, body, options });
    if (target.endsWith('/auth/v1/user')) return reply({ id: ids.user });
    if (target.includes('/rest/v1/profiles?')) return reply([{ user_id: ids.user, tenant_id: ids.tenant, display_name: role === 'OWNER' ? 'Owner' : 'Kasir', role, active: true }]);
    if (target.includes('/rest/v1/outlets?')) return reply([{ id: ids.outlet, name: 'Toko Utama', active: true }]);
    if (target.includes('/rest/v1/user_outlets?')) return reply([{ outlet_id: ids.outlet }]);
    if (target.includes('/rest/v1/stock_locations?')) return reply([{ id: ids.store, outlet_id: ids.outlet, name: 'Toko Utama', kind: 'STORE' }, { id: ids.warehouse, outlet_id: ids.outlet, name: 'Gudang Utama', kind: 'WAREHOUSE' }]);
    if (target.includes('/rest/v1/sales?')) return reply([{ id: ids.sale, outlet_id: ids.outlet }]);
    if (target.endsWith('/rest/v1/rpc/post_stock_transfer')) return reply({ id: 'transfer-id', transferNo: 'TRF-2607-00001', status: 'RECEIVED', duplicate: false });
    if (target.endsWith('/rest/v1/rpc/post_stock_count')) return reply({ id: 'count-id', countNo: 'OPN-2607-00001', status: 'POSTED', duplicate: false });
    if (target.endsWith('/rest/v1/rpc/process_customer_return_v3')) return reply({ id: 'return-id', returnNo: 'RTR-2607-00001', total: 25000, status: 'COMPLETED', duplicate: false });
    return reply({ message: `Mock belum menangani ${target}` }, 500);
  };
  return calls;
}

async function call(method, route, body, headers = {}) {
  let payload = '';
  const request = { method, url: `/api/index?route=${route}`, query: { route }, headers: { authorization: 'Bearer user-access-token', ...headers }, body };
  const response = { statusCode: 0, setHeader() {}, end(value) { payload = value; } };
  await handler(request, response);
  return { status: response.statusCode, body: JSON.parse(payload) };
}

test('transfer, opname, dan retur cloud diteruskan sebagai RPC atomik dengan idempotensi', async () => {
  const originalFetch = globalThis.fetch;
  const previous = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://project.supabase.test'; process.env.SUPABASE_ANON_KEY = 'anon'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  const calls = environment('OWNER');
  try {
    const transfer = await call('POST', 'transfers', { fromLocationId: ids.warehouse, toLocationId: ids.store, items: [{ productId: ids.product, baseQty: 12 }] }, { 'idempotency-key': 'transfer-command' });
    const count = await call('POST', 'stock-counts', { locationId: ids.store, items: [{ productId: ids.product, countedQty: 25 }] }, { 'idempotency-key': 'count-command' });
    const returned = await call('POST', 'returns', { saleId: ids.sale, reason: 'Kemasan rusak', refundMethod:'TRANSFER',refundReference:'TRX-1',items: [{ saleItemId:'88888888-8888-4888-8888-888888888888',baseQty:1,condition:'DAMAGED' }] }, { 'idempotency-key': 'return-command' });
    assert.equal(transfer.status, 201); assert.equal(count.status, 201); assert.equal(returned.status, 201);
    const transferRpc = calls.find((entry) => entry.target.endsWith('/rpc/post_stock_transfer'));
    const countRpc = calls.find((entry) => entry.target.endsWith('/rpc/post_stock_count'));
    const returnRpc = calls.find((entry) => entry.target.endsWith('/rpc/process_customer_return_v3'));
    assert.equal(transferRpc.body.p_from_location_id, ids.warehouse);
    assert.equal(transferRpc.body.p_idempotency_key, 'transfer-command');
    assert.equal(countRpc.body.p_items[0].countedQty, 25);
    assert.equal(returnRpc.body.p_reason, 'Kemasan rusak');
    assert.equal(returnRpc.body.p_refund_method,'TRANSFER');
    assert.equal(returnRpc.body.p_items[0].condition,'DAMAGED');
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
    if (previous.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.service;
  }
});

test('kasir tidak dapat menjalankan transaksi pengelolaan stok', async () => {
  const originalFetch = globalThis.fetch;
  const previous = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://project.supabase.test'; process.env.SUPABASE_ANON_KEY = 'anon'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  const calls = environment('CASHIER');
  try {
    const result = await call('POST', 'transfers', { fromLocationId: ids.warehouse, toLocationId: ids.store, items: [{ productId: ids.product, baseQty: 1 }] }, { 'idempotency-key': 'blocked-command' });
    assert.equal(result.status, 403);
    assert.match(result.body.error, /hak/);
    assert.equal(calls.some((entry) => entry.target.includes('/rpc/post_stock_transfer')), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
    if (previous.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.service;
  }
});
