import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from '../api/index.mjs';

const responseOf = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ids = {
  user: '11111111-1111-4111-8111-111111111111', tenant: '22222222-2222-4222-8222-222222222222',
  outletA: '33333333-3333-4333-8333-333333333333', outletB: '44444444-4444-4444-8444-444444444444',
  locationA: '55555555-5555-4555-8555-555555555555', locationB: '66666666-6666-4666-8666-666666666666',
  product: '77777777-7777-4777-8777-777777777777'
};

async function invoke(method, route, body = {}, headers = {}) {
  let payload = '';
  const request = { method, url: `/api/index?route=${route}`, query: { route }, headers: { authorization: 'Bearer token', ...headers }, body };
  const response = { statusCode: 0, setHeader() {}, end(value) { payload = value; } };
  await handler(request, response);
  return { status: response.statusCode, body: JSON.parse(payload) };
}

function setEnvironment() {
  const previous = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://project.supabase.test'; process.env.SUPABASE_ANON_KEY = 'anon'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-secret';
  return () => {
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
    if (previous.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.service;
  };
}

test('petugas gudang hanya menerima stok dari outlet yang ditugaskan', async () => {
  const originalFetch = globalThis.fetch; const restoreEnvironment = setEnvironment(); const calls = [];
  globalThis.fetch = async (url) => {
    const target = String(url); calls.push(target);
    if (target.endsWith('/auth/v1/user')) return responseOf({ id: ids.user });
    if (target.includes('/rest/v1/profiles?')) return responseOf([{ user_id: ids.user, tenant_id: ids.tenant, display_name: 'Gudang A', role: 'WAREHOUSE', active: true }]);
    if (target.includes('/rest/v1/user_outlets?')) return responseOf([{ outlet_id: ids.outletA }]);
    if (target.includes('/rest/v1/outlets?')) return responseOf([{ id: ids.outletA, name: 'Cabang A', active: true }, { id: ids.outletB, name: 'Cabang B', active: true }]);
    if (target.includes('/rest/v1/stock_locations?')) return responseOf([{ id: ids.locationA, outlet_id: ids.outletA, kind: 'WAREHOUSE' }, { id: ids.locationB, outlet_id: ids.outletB, kind: 'WAREHOUSE' }]);
    if (target.includes('/rest/v1/stock_balances?')) return responseOf([{ location_id: ids.locationA, product_id: ids.product, quantity: '10', avg_cost: '1000' }]);
    if (target.includes('/rest/v1/stock_ledger?')) return responseOf([]);
    if (target.includes('/rest/v1/products?')) return responseOf([{ id:ids.product, sku:'SKU-1', name:'Barang A', category:'Umum', active:true }]);
    return responseOf({ message: `Mock belum menangani ${target}` }, 500);
  };
  try {
    const result = await invoke('GET', 'inventory');
    assert.equal(result.status, 200);
    assert.equal(result.body.balances[0].location_id, ids.locationA);
    assert.equal(Object.hasOwn(result.body.balances[0], 'avg_cost'), false);
    const balanceQuery = calls.find((target) => target.includes('/rest/v1/stock_balances?'));
    assert.match(balanceQuery, new RegExp(`location_id=in\\.\\(${ids.locationA}\\)`));
    assert.equal(balanceQuery.includes(ids.locationB), false);
  } finally { globalThis.fetch = originalFetch; restoreEnvironment(); }
});

test('owner dapat membuat user Auth dan profil outlet tanpa membocorkan kata sandi', async () => {
  const originalFetch = globalThis.fetch; const restoreEnvironment = setEnvironment(); const calls = [];
  const newUser = '88888888-8888-4888-8888-888888888888';
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url); const body = options.body ? JSON.parse(options.body) : null; calls.push({ target, options, body });
    if (target.endsWith('/auth/v1/user')) return responseOf({ id: ids.user });
    if (target.includes('/rest/v1/profiles?')) return responseOf([{ user_id: ids.user, tenant_id: ids.tenant, display_name: 'Owner', role: 'OWNER', active: true }]);
    if (target.includes('/rest/v1/outlets?')) return responseOf([{ id: ids.outletA, name: 'Cabang A', active: true }]);
    if (target.includes('/rest/v1/stock_locations?')) return responseOf([{ id: ids.locationA, outlet_id: ids.outletA, kind: 'STORE' }]);
    if (target.endsWith('/auth/v1/admin/users')) return responseOf({ id: newUser, email: 'kasir@example.com' });
    if (target.endsWith('/rest/v1/rpc/manage_profile_access_v2')) return responseOf({ userId: newUser, displayName: 'Kasir Baru', role: 'CASHIER', active: true, outletIds: [ids.outletA], permissions:['pos.sell'] });
    return responseOf({ message: `Mock belum menangani ${target}` }, 500);
  };
  try {
    const result = await invoke('POST', 'users', { email: 'kasir@example.com', password: 'rahasia123', displayName: 'Kasir Baru', role: 'CASHIER', outletIds: [ids.outletA], permissions:['pos.sell'] });
    assert.equal(result.status, 201);
    assert.equal(result.body.email, 'kasir@example.com');
    assert.equal(Object.hasOwn(result.body, 'password'), false);
    const authCall = calls.find((entry) => entry.target.endsWith('/auth/v1/admin/users'));
    assert.equal(authCall.options.headers.apikey, 'service-secret');
    const profileCall = calls.find((entry) => entry.target.endsWith('/rpc/manage_profile_access_v2'));
    assert.deepEqual(profileCall.body.p_outlet_ids, [ids.outletA]);
    assert.deepEqual(profileCall.body.p_permissions, ['pos.sell']);
  } finally { globalThis.fetch = originalFetch; restoreEnvironment(); }
});

test('backoffice menyediakan pengelolaan user, peran, outlet, dan status akun', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8')
  ]);
  assert.match(html, /data-page="users"[^>]+data-permission="identity\.manage"/);
  assert.match(html, /id="create-user-form"/);
  assert.match(html, /data-page="users"[\s\S]*?<span>Kelola Staff<\/span>/);
  assert.match(html, /id="open-create-user"[^>]*>\+ Tambah staff<\/button>/);
  assert.match(html, /id="user-list"[\s\S]*id="create-user-dialog"[\s\S]*id="create-user-form"/);
  assert.match(html, /id="new-user-outlets"/);
  assert.match(html, /id="new-user-permissions"/);
  assert.match(html, /id="edit-user-permissions"/);
  assert.match(html, /id="edit-user-active"/);
  assert.match(script, /request\('\/api\/users'/);
  assert.match(script, /method: 'PATCH'/);
  assert.match(script, /selectedPermissions/);
  assert.match(script, /function openCreateUserDialog\(\)/);
  assert.match(script, /user\.role !== 'OWNER'/);
  assert.match(script, /user\.id === state\.session\.user\.id/);
});
