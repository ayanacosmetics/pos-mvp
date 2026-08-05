import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/index.mjs';

function responseOf(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('restok cloud memakai sesi user untuk Auth dan service key untuk transaksi atomik', async () => {
  const originalFetch = globalThis.fetch;
  const previousEnv = {
    url: process.env.SUPABASE_URL,
    anon: process.env.SUPABASE_ANON_KEY,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  process.env.SUPABASE_URL = 'https://project.supabase.test';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test-key';
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/auth/v1/user')) return responseOf({ id: '11111111-1111-4111-8111-111111111111' });
    if (String(url).includes('/rest/v1/profiles?')) return responseOf([{ user_id: '11111111-1111-4111-8111-111111111111', tenant_id: '22222222-2222-4222-8222-222222222222', display_name: 'Owner', role: 'OWNER', active: true }]);
    if (String(url).includes('/rest/v1/outlets?')) return responseOf([{ id: '33333333-3333-4333-8333-333333333333', name: 'Toko Utama', active: true }]);
    if (String(url).includes('/rest/v1/stock_locations?')) return responseOf([{ id: '44444444-4444-4444-8444-444444444444', name: 'Gudang Utama', kind: 'WAREHOUSE' }]);
    if (String(url).includes('/rest/v1/purchase_orders?')) return responseOf([{ id: '88888888-8888-4888-8888-888888888888', tenant_id: '22222222-2222-4222-8222-222222222222', location_id: '44444444-4444-4444-8444-444444444444', po_no: 'PO-2607-00001', status: 'DRAFT', subtotal: '0', discount_amount: '0', tax_amount: '0', other_cost: '0', grand_total: '0', created_at: '2026-07-21T00:00:00Z' }]);
    if (String(url).includes('/rest/v1/purchase_order_items?')) return responseOf([]);
    if (String(url).includes('/rest/v1/restock_approval_requests?')) return responseOf([]);
    if (String(url).includes('/rest/v1/purchase_receipt_items?')) return responseOf([{ product_id: '77777777-7777-4777-8777-777777777777', unit_cost: '17500', purchase_receipts: { received_at: '2026-07-20T00:00:00Z' } }]);
    if (String(url).endsWith('/rest/v1/rpc/receive_purchase')) return responseOf({ id: '55555555-5555-4555-8555-555555555555', document_no: 'INV-TEST-1', status: 'RECEIVED', duplicate: false });
    return responseOf({ message: `Mock belum menangani ${url}` }, 500);
  };

  try {
    let payload = '';
    const request = {
      method: 'POST',
      url: '/api/index?route=purchase-receipts',
      query: { route: 'purchase-receipts' },
      headers: { authorization: 'Bearer user-access-token', 'idempotency-key': 'restock-command-1' },
      body: {
        supplierId: '66666666-6666-4666-8666-666666666666',
        locationId: '44444444-4444-4444-8444-444444444444',
        documentNo: 'INV-TEST-1',
        items: [{ productId: '77777777-7777-4777-8777-777777777777', baseQty: 12, unitCost: 17500, batchNo: 'B-01', expiresOn: '2028-12-31' }]
      }
    };
    const response = {
      statusCode: 0,
      setHeader() {},
      end(value) { payload = value; }
    };
    await handler(request, response);

    assert.equal(response.statusCode, 201);
    assert.equal(JSON.parse(payload).document_no, 'INV-TEST-1');
    const authCall = calls.find((call) => call.url.endsWith('/auth/v1/user'));
    assert.equal(authCall.options.headers.apikey, 'anon-test-key');
    assert.equal(authCall.options.headers.authorization, 'Bearer user-access-token');
    const rpcCall = calls.find((call) => call.url.endsWith('/rest/v1/rpc/receive_purchase'));
    assert.equal(rpcCall.options.headers.apikey, 'service-test-key');
    assert.equal(rpcCall.body.p_idempotency_key, 'restock-command-1');
    assert.equal(rpcCall.body.p_items[0].batchNo, 'B-01');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousEnv.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousEnv.url;
    if (previousEnv.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previousEnv.anon;
    if (previousEnv.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousEnv.service;
  }
});

test('Purchase Order cloud dapat disimpan sebagai draft lalu diajukan', async () => {
  const originalFetch = globalThis.fetch;
  const previousEnv = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://project.supabase.test';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test-key';
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), options, body });
    if (String(url).endsWith('/auth/v1/user')) return responseOf({ id: '11111111-1111-4111-8111-111111111111' });
    if (String(url).includes('/rest/v1/profiles?')) return responseOf([{ user_id: '11111111-1111-4111-8111-111111111111', tenant_id: '22222222-2222-4222-8222-222222222222', display_name: 'Owner', role: 'OWNER', active: true }]);
    if (String(url).includes('/rest/v1/outlets?')) return responseOf([{ id: '33333333-3333-4333-8333-333333333333', name: 'Toko Utama', active: true }]);
    if (String(url).includes('/rest/v1/stock_locations?')) return responseOf([{ id: '44444444-4444-4444-8444-444444444444', name: 'Gudang Utama', kind: 'WAREHOUSE' }]);
    if (String(url).includes('/rest/v1/purchase_orders?')) return responseOf([{ id: '88888888-8888-4888-8888-888888888888', tenant_id: '22222222-2222-4222-8222-222222222222', location_id: '44444444-4444-4444-8444-444444444444', po_no: 'PO-2607-00001', status: 'DRAFT', subtotal: '0', discount_amount: '0', tax_amount: '0', other_cost: '0', grand_total: '0', created_at: '2026-07-21T00:00:00Z' }]);
    if (String(url).includes('/rest/v1/purchase_order_items?')) return responseOf([]);
    if (String(url).includes('/rest/v1/restock_approval_requests?')) return responseOf([]);
    if (String(url).endsWith('/rest/v1/rpc/save_purchase_order')) return responseOf({ id: '88888888-8888-4888-8888-888888888888', po_no: 'PO-2607-00001', status: 'DRAFT' });
    if (String(url).endsWith('/rest/v1/rpc/transition_purchase_order')) return responseOf({ id: '88888888-8888-4888-8888-888888888888', po_no: 'PO-2607-00001', status: 'SUBMITTED' });
    return responseOf({ message: `Mock belum menangani ${url}` }, 500);
  };
  const callHandler = async (route, body) => {
    let payload = '';
    const request = { method: 'POST', url: `/api/index?route=${route}`, query: { route }, headers: { authorization: 'Bearer user-access-token' }, body };
    const response = { statusCode: 0, setHeader() {}, end(value) { payload = value; } };
    await handler(request, response);
    return { status: response.statusCode, body: JSON.parse(payload) };
  };
  try {
    const draft = await callHandler('purchase-orders', {
      supplierId: '66666666-6666-4666-8666-666666666666', locationId: '44444444-4444-4444-8444-444444444444',
      expectedOn: '2026-07-25', discountAmount: 1000, taxAmount: 0, otherCost: 5000,
      items: [{ productId: '77777777-7777-4777-8777-777777777777', baseQty: 24, unitCost: 17500, lineDiscount: 0 }]
    });
    assert.equal(draft.status, 201);
    assert.equal(draft.body.status, 'DRAFT');
    const submitted = await callHandler('purchase-orders/88888888-8888-4888-8888-888888888888/submit', {});
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.status, 'SUBMITTED');
    const saveCall = calls.find((call) => call.url.endsWith('/rest/v1/rpc/save_purchase_order'));
    assert.equal(saveCall.body.p_items[0].baseQty, 24);
    const transitionCall = calls.find((call) => call.url.endsWith('/rest/v1/rpc/transition_purchase_order'));
    assert.equal(transitionCall.body.p_action, 'SUBMIT');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousEnv.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousEnv.url;
    if (previousEnv.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previousEnv.anon;
    if (previousEnv.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousEnv.service;
  }
});

test('sesi Supabase dapat diperpanjang tanpa login ulang', async () => {
  const originalFetch = globalThis.fetch;
  const previousEnv = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://project.supabase.test';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test-key';
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null });
    if (String(url).includes('/auth/v1/token?grant_type=refresh_token')) return responseOf({
      access_token: 'new-access-token', refresh_token: 'rotated-refresh-token', expires_in: 3600, expires_at: 999999,
      user: { id: '11111111-1111-4111-8111-111111111111' }
    });
    if (String(url).includes('/rest/v1/profiles?')) return responseOf([{ user_id: '11111111-1111-4111-8111-111111111111', tenant_id: '22222222-2222-4222-8222-222222222222', display_name: 'Owner', role: 'OWNER', active: true }]);
    return responseOf({ message: `Mock belum menangani ${url}` }, 500);
  };
  try {
    let payload = '';
    const responseHeaders = {};
    const request = { method: 'POST', url: '/api/index?route=refresh', query: { route: 'refresh' }, headers: { cookie: '__Host-kasir_nusa_refresh=old-refresh-token' }, body: {} };
    const response = { statusCode: 0, setHeader(name, value) { responseHeaders[name] = value; }, end(value) { payload = value; } };
    await handler(request, response);
    const body = JSON.parse(payload);
    assert.equal(response.statusCode, 200);
    assert.equal(body.token, 'new-access-token');
    assert.equal(body.refreshToken, 'rotated-refresh-token');
    const authCall = calls.find((call) => call.url.includes('grant_type=refresh_token'));
    assert.equal(authCall.options.headers.apikey, 'anon-test-key');
    assert.equal(authCall.body.refresh_token, 'old-refresh-token');
    assert.match(responseHeaders['set-cookie'], /rotated-refresh-token/);
    assert.match(responseHeaders['set-cookie'], /Max-Age=315360000/);
    assert.match(responseHeaders['set-cookie'], /HttpOnly; Secure; SameSite=Lax/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousEnv.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousEnv.url;
    if (previousEnv.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previousEnv.anon;
    if (previousEnv.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousEnv.service;
  }
});

test('logout mencabut refresh session Supabase dan menghapus cookie permanen', async () => {
  const originalFetch = globalThis.fetch;
  const previousEnv = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://project.supabase.test';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test-key';
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(null, { status: 204 });
  };
  try {
    let payload = '';
    const responseHeaders = {};
    const request = {
      method: 'POST', url: '/api/index?route=logout', query: { route: 'logout' },
      headers: { authorization: 'Bearer access-token', cookie: '__Host-kasir_nusa_refresh=refresh-token' },
      body: { refreshToken: 'refresh-token' }
    };
    const response = { statusCode: 0, setHeader(name, value) { responseHeaders[name] = value; }, end(value) { payload = value; } };
    await handler(request, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(payload), { success: true, revoked: true });
    const logoutCall = calls.find((call) => call.url.includes('/auth/v1/logout?scope=local'));
    assert.equal(logoutCall.options.headers.authorization, 'Bearer access-token');
    assert.match(responseHeaders['set-cookie'], /Max-Age=0/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousEnv.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousEnv.url;
    if (previousEnv.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previousEnv.anon;
    if (previousEnv.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousEnv.service;
  }
});

test('perbandingan supplier memilih modal terakhir termurah', async () => {
  const originalFetch = globalThis.fetch;
  const previousEnv = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://project.supabase.test'; process.env.SUPABASE_ANON_KEY = 'anon-test-key'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test-key';
  globalThis.fetch = async (url) => {
    const target=String(url);
    if (target.endsWith('/auth/v1/user')) return responseOf({ id:'11111111-1111-4111-8111-111111111111' });
    if (target.includes('/rest/v1/profiles?')) return responseOf([{ user_id:'11111111-1111-4111-8111-111111111111',tenant_id:'22222222-2222-4222-8222-222222222222',display_name:'Owner',role:'OWNER',active:true }]);
    if (target.includes('/rest/v1/outlets?')) return responseOf([{ id:'33333333-3333-4333-8333-333333333333',active:true }]);
    if (target.includes('/rest/v1/stock_locations?')) return responseOf([{ id:'44444444-4444-4444-8444-444444444444',kind:'STORE' }]);
    if (target.includes('/rest/v1/purchase_receipt_items?')) return responseOf([
      { supplier_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',supplier_name:'Supplier A',unit_cost:'18000',received_at:'2026-07-20T00:00:00Z',document_no:'A-2',batch_no:'A2',base_qty:'12' },
      { supplier_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',supplier_name:'Supplier B',unit_cost:'17000',received_at:'2026-07-19T00:00:00Z',document_no:'B-1',batch_no:'B1',base_qty:'12' },
      { supplier_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',supplier_name:'Supplier A',unit_cost:'16000',received_at:'2026-06-01T00:00:00Z',document_no:'A-1',batch_no:'A1',base_qty:'12' }
    ]);
    if (target.includes('/rest/v1/price_rules?')) return responseOf([{ customer_group_id:'retail',min_base_qty:'1',unit_price_base:'25000',priority:0 }]);
    return responseOf({message:`Mock belum menangani ${target}`},500);
  };
  try {
    let payload='';
    const route='supplier-comparison/77777777-7777-4777-8777-777777777777';
    const request={method:'GET',url:`/api/index?route=${route}`,query:{route},headers:{authorization:'Bearer user-access-token'}};
    const response={statusCode:0,setHeader(){},end(value){payload=value;}};
    await handler(request,response);
    const body=JSON.parse(payload);
    assert.equal(response.statusCode,200);
    assert.equal(body.bestCost,17000);
    assert.equal(body.suppliers.length,2);
    assert.equal(body.suppliers[0].supplier,'Supplier B');
    assert.equal(body.suppliers[1].lastCost,18000);
    assert.equal(body.currentRetailPrice,25000);
  } finally {
    globalThis.fetch=originalFetch;
    if(previousEnv.url===undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL=previousEnv.url;
    if(previousEnv.anon===undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY=previousEnv.anon;
    if(previousEnv.service===undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY=previousEnv.service;
  }
});
