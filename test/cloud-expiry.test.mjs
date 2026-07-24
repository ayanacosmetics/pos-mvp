import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/index.mjs';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('endpoint kontrol EXP memetakan batch, produk, lokasi, dan nilai stok', async () => {
  const originalFetch = globalThis.fetch;
  const previousEnv = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://project.supabase.test';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test-key';
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: '11111111-1111-4111-8111-111111111111' });
    if (target.includes('/rest/v1/profiles?')) return jsonResponse([{ user_id: '11111111-1111-4111-8111-111111111111', tenant_id: '22222222-2222-4222-8222-222222222222', display_name: 'Owner', role: 'OWNER', active: true }]);
    if (target.includes('/rest/v1/outlets?')) return jsonResponse([{ id: '33333333-3333-4333-8333-333333333333', name: 'Toko Utama', active: true }]);
    if (target.includes('/rest/v1/stock_locations?')) return jsonResponse([{ id: '44444444-4444-4444-8444-444444444444', name: 'Gudang Utama', kind: 'WAREHOUSE' }]);
    if (target.includes('/rest/v1/inventory_batches?')) return jsonResponse([{ id: '55555555-5555-4555-8555-555555555555', location_id: '44444444-4444-4444-8444-444444444444', product_id: '77777777-7777-4777-8777-777777777777', supplier_name: 'Supplier A', batch_no: 'B-01', expires_on: null, received_qty: '12', available_qty: '8', unit_cost: '15000', received_at: '2026-07-20T00:00:00Z' }]);
    if (target.includes('/rest/v1/products?')) return jsonResponse([{ id: '77777777-7777-4777-8777-777777777777', sku: 'KOS-001', name: 'Serum Wajah', brand: 'Nusa' }]);
    return jsonResponse({ message: `Mock belum menangani ${target}` }, 500);
  };
  try {
    let payload = '';
    const request = { method: 'GET', url: '/api/index?route=expiry-dashboard', query: { route: 'expiry-dashboard' }, headers: { authorization: 'Bearer user-access-token' } };
    const response = { statusCode: 0, setHeader() {}, end(value) { payload = value; } };
    await handler(request, response);
    const body = JSON.parse(payload);
    assert.equal(response.statusCode, 200);
    assert.equal(body.metrics.noExpiryBatches, 1);
    assert.equal(body.metrics.stockValue, 120000);
    assert.equal(body.batches[0].productName, 'Serum Wajah');
    assert.equal(body.batches[0].locationName, 'Gudang Utama');
    assert.equal(body.batches[0].status, 'NO_EXPIRY');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousEnv.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousEnv.url;
    if (previousEnv.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previousEnv.anon;
    if (previousEnv.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousEnv.service;
  }
});
