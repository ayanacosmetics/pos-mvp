import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PosStore } from './storage.mjs';
import {
  PERMISSIONS, can, compareCost, costHistory, customerGroups, demoUsers,
  outlets, permissionsFor, products, promotionVersions, quoteBasket,
  applySaleAdjustment, normalizeSaleAdjustment, saleAdjustmentFingerprintPayload
} from '../../../packages/domain/src/index.mjs';

const webRoot = fileURLToPath(new URL('../../web/', import.meta.url));
const dataPath = process.env.POS_DB_PATH ?? fileURLToPath(new URL('../data/pos-mvp.sqlite', import.meta.url));
export const store = new PosStore(dataPath, products, promotionVersions);
const sessions = new Map();
const saleAuthorizations = new Map();
const port = Number(process.env.PORT ?? 4173);
let localBusiness = { id:'tenant-demo', name:'Kasir Nusa Demo', legalName:'', phone:'', email:'', address:'', taxId:'', currency:'IDR', receiptFooter:'Terima kasih telah berbelanja.', logoUrl:'' };
let localOutletSettings = outlets.map((outlet) => ({ ...outlet, code:outlet.code ?? 'UTM', timezone:'Asia/Makassar', active:true, receipt_prefix:outlet.code ?? 'UTM', phone:'', address:'', receipt_footer:'' }));
let localLocations = [
  { id: 'outlet-utama', outlet_id: 'outlet-utama', code: 'TOKO', name: 'Toko Utama', kind: 'STORE', active:true },
  { id: 'gudang-utama', outlet_id: 'outlet-utama', code: 'GDG', name: 'Gudang Utama', kind: 'WAREHOUSE', active:true }
];

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json'
};

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function bodyOf(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('Payload terlalu besar');
  }
  return raw ? JSON.parse(raw) : {};
}

function sessionOf(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  return token ? sessions.get(token) : null;
}

function requirePermission(request, response, permission) {
  const session = sessionOf(request);
  if (!session) {
    json(response, 401, { error: 'Sesi tidak valid' });
    return null;
  }
  if (!can(session, permission)) {
    json(response, 403, { error: 'Anda tidak memiliki hak untuk tindakan ini' });
    return null;
  }
  return session;
}

async function api(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { status: 'ok', version: '1.20.0-local', storage: 'sqlite' });

  if (request.method === 'POST' && url.pathname === '/api/login') {
    const input = await bodyOf(request);
    const user = demoUsers.find((item) => item.email === input.email && item.password === input.password);
    if (!user) return json(response, 401, { error: 'Email atau kata sandi salah' });
    const token = crypto.randomUUID();
    const session = { token, user: { id: user.id, displayName: user.displayName, role: user.role, outletIds: user.outletIds }, permissions: permissionsFor(user.role) };
    sessions.set(token, session);
    return json(response, 200, session);
  }

  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    const session = sessionOf(request);
    if (!session) return json(response, 401, { error: 'Sesi tidak valid' });
    const balances = store.inventory().filter((item) => item.location_id === 'outlet-utama');
    const catalog = store.catalog().map(({ priceRules, ...product }) => ({ ...product, stockBase: balances.find((item) => item.product_id === product.id)?.quantity ?? 0, priceRules: can(session, PERMISSIONS.POS_SELL) ? priceRules : [] }));
    const accessibleOutlets = localOutletSettings.filter((outlet) => outlet.active && session.user.outletIds.includes(outlet.id));
    return json(response, 200, { session, business:localBusiness, deviceSettings:{ id:request.headers['x-device-id'],paperWidth:80,autoPrint:false,receiptCopies:1 }, outlets: accessibleOutlets, activeOutletId:accessibleOutlets[0]?.id, locations:localLocations.filter((location)=>location.active), customerGroups, customers: store.customers(), suppliers: can(session, PERMISSIONS.RECEIVE_PURCHASE) ? store.suppliers() : [], products: catalog, promotions: store.promotions(), currentShift: store.currentShift(session.user.id), syncCursor: Date.now().toString() });
  }

  if (request.method === 'GET' && url.pathname === '/api/settings') {
    const session = requirePermission(request,response,PERMISSIONS.MANAGE_USERS); if(!session)return;
    return json(response,200,{business:localBusiness,outlets:localOutletSettings,locations:localLocations,devices:[]});
  }

  if (request.method === 'PUT' && url.pathname === '/api/settings/business') {
    const session = requirePermission(request,response,PERMISSIONS.MANAGE_USERS); if(!session)return;
    localBusiness={...localBusiness,...await bodyOf(request)};
    return json(response,200,{business:localBusiness});
  }

  if (request.method === 'GET' && url.pathname === '/api/sync/review') {
    if (!requirePermission(request, response, PERMISSIONS.VIEW_AUDIT)) return;
    return json(response, 200, { commands: [] });
  }

  if (request.method === 'POST' && url.pathname === '/api/sale-authorizations') {
    const session = requirePermission(request, response, PERMISSIONS.POS_SELL);
    if (!session) return;
    const input = await bodyOf(request);
    const approver = demoUsers.find((item) => item.email === input.approverEmail && item.password === input.approverPassword && ['OWNER','ADMIN'].includes(item.role));
    if (!approver) return json(response, 422, { error: 'Email atau kata sandi supervisor salah' });
    try {
      const adjustment = normalizeSaleAdjustment(input.adjustment);
      const baseQuote = quoteBasket({ lines: input.lines, customerGroupId: input.customerGroupId, products: store.catalog(), promotions: store.promotions(), at: new Date() });
      const id = crypto.randomUUID();
      const token = crypto.randomUUID();
      const approvedBy = approver.displayName;
      const quote = applySaleAdjustment(baseQuote, adjustment, { id, approvedBy });
      const authorization = { id, token, approvedBy, adjustment, discountAmount: quote.manualAdjustment.discountAmount, expiresAt: new Date(Date.now() + 300000).toISOString() };
      saleAuthorizations.set(id, { ...authorization, cashierId: session.user.id, fingerprint: saleAdjustmentFingerprintPayload(input.lines, input.customerGroupId, adjustment), consumed: false });
      return json(response, 201, { authorization, quote });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/quote') {
    const session = requirePermission(request, response, PERMISSIONS.POS_SELL);
    if (!session) return;
    const input = await bodyOf(request);
    let quote = quoteBasket({ ...input, products: store.catalog(), promotions: store.promotions(), at: input.at ? new Date(input.at) : new Date() });
    if (input.authorization) {
      const approval = saleAuthorizations.get(input.authorization.id);
      const fingerprint = saleAdjustmentFingerprintPayload(input.lines, input.customerGroupId, input.authorization.adjustment);
      if (!approval || approval.token !== input.authorization.token || approval.cashierId !== session.user.id || approval.fingerprint !== fingerprint || approval.consumed || new Date(approval.expiresAt) <= new Date()) {
        return json(response, 409, { error: 'Persetujuan diskon tidak valid, kedaluwarsa, atau keranjang telah berubah' });
      }
      quote = applySaleAdjustment(quote, approval.adjustment, approval);
    }
    return json(response, 200, quote);
  }

  if (request.method === 'POST' && url.pathname === '/api/sales') {
    const session = requirePermission(request, response, PERMISSIONS.POS_SELL);
    if (!session) return;
    const key = request.headers['idempotency-key'];
    if (!key) return json(response, 400, { error: 'Idempotency-Key wajib diisi' });
    const input = await bodyOf(request);
    const shift = input.shiftId ? store.shiftDetail(input.shiftId) : store.currentShift(session.user.id);
    if (!shift || shift.cashier_id !== session.user.id) return json(response, 409, { error: 'Buka shift kasir terlebih dahulu' });
    let quote = quoteBasket({ lines: input.lines, customerGroupId: input.customerGroupId, products: store.catalog(), promotions: store.promotions(), at: new Date() });
    let approval = null;
    if (input.authorization) {
      approval = saleAuthorizations.get(input.authorization.id);
      const fingerprint = saleAdjustmentFingerprintPayload(input.lines, input.customerGroupId, input.authorization.adjustment);
      if (!approval || approval.token !== input.authorization.token || approval.cashierId !== session.user.id || approval.fingerprint !== fingerprint || approval.consumed || new Date(approval.expiresAt) <= new Date()) {
        return json(response, 409, { error: 'Persetujuan diskon tidak valid, kedaluwarsa, atau keranjang telah berubah' });
      }
      quote = applySaleAdjustment(quote, approval.adjustment, approval);
    }
    const persisted = store.recordSale({ key, quote, lines: input.lines, cashier: session.user, customerGroupId: input.customerGroupId, paymentMethod: input.paymentMethod, shiftId: shift.id });
    if (approval) approval.consumed = true;
    const receipt = { id: persisted.id, receiptNo: persisted.receipt_no, status: persisted.status, occurredAt: persisted.occurred_at, cashier: persisted.cashier_name, quote };
    return json(response, 201, receipt);
  }

  if (request.method === 'GET' && url.pathname === '/api/sales/lookup') {
    if (!requirePermission(request, response, PERMISSIONS.PROCESS_RETURN)) return;
    const sale = store.saleByReceipt(url.searchParams.get('receiptNo'));
    return sale ? json(response, 200, { sale }) : json(response, 404, { error: 'Nomor struk tidak ditemukan' });
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/sales/')) {
    if (!requirePermission(request, response, PERMISSIONS.PROCESS_RETURN)) return;
    const sale = store.returnableSale(decodeURIComponent(url.pathname.split('/').pop()));
    return sale ? json(response, 200, { sale }) : json(response, 404, { error: 'Transaksi tidak ditemukan' });
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/cost-history/')) {
    if (!requirePermission(request, response, PERMISSIONS.VIEW_COST)) return;
    const productId = decodeURIComponent(url.pathname.split('/').pop());
    return json(response, 200, { productId, history: costHistory[productId] ?? [] });
  }

  if (request.method === 'POST' && url.pathname === '/api/products') {
    const session = requirePermission(request, response, PERMISSIONS.MANAGE_PRODUCTS);
    if (!session) return;
    return json(response, 201, store.createProduct(await bodyOf(request), session.user.id));
  }

  if (request.method === 'POST' && url.pathname === '/api/promotions/publish') {
    const session = requirePermission(request, response, PERMISSIONS.MANAGE_PROMOTIONS);
    if (!session) return;
    return json(response, 201, store.publishPromotion(await bodyOf(request), session.user.id));
  }

  if (request.method === 'POST' && url.pathname === '/api/promotions/simulate') {
    if (!requirePermission(request, response, PERMISSIONS.MANAGE_PROMOTIONS)) return;
    const input = await bodyOf(request);
    const promo = {
      id: 'simulation', promotionId: 'simulation', version: 0, code: input.promo.code || 'SIMULASI', name: input.promo.name || 'Simulasi',
      status: 'PUBLISHED', startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString(),
      priority: 999, stackable: false, condition: { category: input.promo.category, minBaseQty: Number(input.promo.minBaseQty) },
      reward: { type: 'PERCENT_ITEM', value: Number(input.promo.discountPercent), maxDiscount: Number(input.promo.maxDiscount ?? 100000) }
    };
    const quote = quoteBasket({ lines: [input.line], customerGroupId: 'retail', products: store.catalog(), promotions: [promo], at: new Date() });
    return json(response, 200, quote);
  }

  if (request.method === 'GET' && url.pathname === '/api/customers') {
    if (!requirePermission(request, response, PERMISSIONS.POS_SELL)) return;
    return json(response, 200, { customers: store.customers() });
  }

  if (request.method === 'POST' && url.pathname === '/api/customers') {
    const session = requirePermission(request, response, PERMISSIONS.POS_SELL);
    if (!session) return;
    return json(response, 201, store.createCustomer(await bodyOf(request), session.user.id));
  }

  if (request.method === 'GET' && url.pathname === '/api/suppliers') {
    if (!requirePermission(request, response, PERMISSIONS.RECEIVE_PURCHASE)) return;
    return json(response, 200, { suppliers: store.suppliers() });
  }

  if (request.method === 'POST' && url.pathname === '/api/suppliers') {
    const session = requirePermission(request, response, PERMISSIONS.RECEIVE_PURCHASE);
    if (!session) return;
    return json(response, 201, store.createSupplier(await bodyOf(request), session.user.id));
  }

  if (request.method === 'POST' && url.pathname === '/api/shifts/open') {
    const session = requirePermission(request, response, PERMISSIONS.POS_SELL);
    if (!session) return;
    const input = await bodyOf(request);
    return json(response, 201, store.openShift({ cashier: session.user, outletId: input.outletId, openingCash: Number(input.openingCash) }));
  }

  if (request.method === 'GET' && url.pathname === '/api/shifts/current') {
    const session = requirePermission(request, response, PERMISSIONS.POS_SELL);
    if (!session) return;
    const shift = store.currentShift(session.user.id);
    return json(response, 200, { shift: shift ? store.shiftDetail(shift.id) : null });
  }

  if (request.method === 'POST' && url.pathname === '/api/shifts/cash-movement') {
    const session = requirePermission(request, response, PERMISSIONS.POS_SELL);
    if (!session) return;
    return json(response, 201, store.addCashMovement({ ...(await bodyOf(request)), actorId: session.user.id }));
  }

  if (request.method === 'POST' && url.pathname === '/api/shifts/close') {
    const session = requirePermission(request, response, PERMISSIONS.POS_SELL);
    if (!session) return;
    return json(response, 200, store.closeShift({ ...(await bodyOf(request)), actorId: session.user.id }));
  }

  if (request.method === 'POST' && url.pathname === '/api/cost-comparison') {
    if (!requirePermission(request, response, PERMISSIONS.VIEW_COST)) return;
    const input = await bodyOf(request);
    return json(response, 200, compareCost(Number(input.newCost), costHistory[input.productId] ?? []));
  }

  if (request.method === 'GET' && url.pathname === '/api/inventory') {
    if (!requirePermission(request, response, PERMISSIONS.MANAGE_INVENTORY)) return;
    return json(response, 200, { balances: store.inventory(), ledger: store.ledger(50) });
  }

  if (request.method === 'POST' && url.pathname === '/api/purchase-receipts') {
    const session = requirePermission(request, response, PERMISSIONS.RECEIVE_PURCHASE);
    if (!session) return;
    const key = request.headers['idempotency-key'];
    if (!key) return json(response, 400, { error: 'Idempotency-Key wajib diisi' });
    const input = await bodyOf(request);
    const receipt = store.receivePurchase({ key, ...input, actorId: session.user.id });
    return json(response, 201, receipt);
  }

  if (request.method === 'POST' && url.pathname === '/api/transfers') {
    const session = requirePermission(request, response, PERMISSIONS.MANAGE_INVENTORY);
    if (!session) return;
    const key = request.headers['idempotency-key'];
    if (!key) return json(response, 400, { error: 'Idempotency-Key wajib diisi' });
    return json(response, 201, store.transfer({ key, ...(await bodyOf(request)), actorId: session.user.id }));
  }

  if (request.method === 'POST' && url.pathname === '/api/stock-counts') {
    const session = requirePermission(request, response, PERMISSIONS.MANAGE_INVENTORY);
    if (!session) return;
    return json(response, 201, store.stockCount({ ...(await bodyOf(request)), actorId: session.user.id }));
  }

  if (request.method === 'POST' && url.pathname === '/api/returns') {
    const session = requirePermission(request, response, PERMISSIONS.PROCESS_RETURN);
    if (!session) return;
    const key=request.headers['idempotency-key'];
    if(!key) return json(response,400,{error:'Idempotency-Key wajib diisi'});
    return json(response, 201, store.processReturn({ key, ...(await bodyOf(request)), actorId: session.user.id }));
  }

  if (request.method === 'GET' && url.pathname === '/api/returns/recent') {
    if (!requirePermission(request,response,PERMISSIONS.PROCESS_RETURN)) return;
    return json(response,200,{returns:store.recentReturns(50)});
  }

  if (request.method === 'GET' && url.pathname === '/api/reports/summary') {
    if (!requirePermission(request, response, PERMISSIONS.VIEW_REPORTS)) return;
    return json(response, 200, store.reportSummary({ from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
  }

  if (request.method === 'GET' && url.pathname === '/api/audit') {
    if (!requirePermission(request, response, PERMISSIONS.VIEW_AUDIT)) return;
    return json(response, 200, { logs: store.auditLogs(50) });
  }

  return json(response, 404, { error: 'Endpoint tidak ditemukan' });
}

async function staticFile(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = normalize(join(webRoot, requested));
  if (!filePath.startsWith(normalize(webRoot))) return json(response, 403, { error: 'Akses ditolak' });
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('not a file');
    const data = await readFile(filePath);
    response.writeHead(200, { 'content-type': mimeTypes[extname(filePath)] ?? 'application/octet-stream' });
    response.end(data);
  } catch {
    const fallback = await readFile(join(webRoot, 'index.html'));
    response.writeHead(200, { 'content-type': mimeTypes['.html'] });
    response.end(fallback);
  }
}

export const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith('/api/')) await api(request, response, url);
    else await staticFile(response, url.pathname);
  } catch (error) {
    json(response, error instanceof SyntaxError ? 400 : 500, { error: error.message ?? 'Kesalahan server' });
  }
});

if (process.env.NODE_ENV !== 'test') server.listen(port, () => console.log(`POS MVP aktif di http://localhost:${port}`));
