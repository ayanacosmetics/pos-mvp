import { createHash, randomBytes } from 'node:crypto';
import { compareCost, quoteBasket } from '../packages/domain/src/pricing.mjs';
import { summarizeExpiryBatches, todayInTimeZone } from '../packages/domain/src/expiry.mjs';
import { applySaleAdjustment, normalizeSaleAdjustment, saleAdjustmentFingerprintPayload } from '../packages/domain/src/sale-adjustment.mjs';
import { applyVoucher } from '../packages/domain/src/loyalty.mjs';
import { calculateEmployeeCommission } from '../packages/domain/src/employee-operations.mjs';

const PERMISSIONS = {
  OWNER: ['pos.sell','purchasing.view_cost','purchasing.receive','inventory.manage','sales.return','catalog.manage','promotion.manage','report.view','audit.view','identity.manage','workforce.self','workforce.manage','approval.manage','finance.owner'],
  ADMIN: ['pos.sell','purchasing.view_cost','purchasing.receive','inventory.manage','sales.return','catalog.manage','promotion.manage','report.view','audit.view','workforce.self','workforce.manage','approval.manage'],
  CASHIER: ['pos.sell','workforce.self'],
  PURCHASING: ['purchasing.view_cost','purchasing.receive','workforce.self'],
  WAREHOUSE: ['inventory.manage','workforce.self']
};

const BACKUP_TABLES = [
  'tenants','profiles','outlets','stock_locations','user_outlets',
  'customers','loyalty_settings','customer_tiers','customer_point_entries','vouchers','voucher_redemptions','customer_account_entries','customer_payment_receipts','customer_payment_allocations','suppliers','supplier_bills','supplier_payable_entries','supplier_payment_receipts','supplier_payment_allocations','products','product_units','price_rules','promotions','promotion_versions','promotion_redemptions',
  'shifts','cash_movements','shift_reconciliations','sales','sale_items','payments','parked_sales','sale_adjustment_authorizations',
  'employee_schedules','attendance_records','employee_targets','approval_policies','approval_requests',
  'expense_categories','outlet_expenses',
  'purchase_planning_settings','restock_policies','purchase_orders','purchase_order_items','purchase_receipts','purchase_receipt_items','supplier_returns','supplier_return_items',
  'stock_balances','stock_ledger','inventory_batches','inventory_batch_movements',
  'stock_transfers','stock_transfer_items','stock_counts','stock_count_items',
  'customer_returns','customer_return_items','customer_refunds',
  'pos_devices','sync_commands','document_sequences','audit_logs','import_jobs'
];

const env = () => ({
  url: process.env.SUPABASE_URL?.replace(/\/$/, ''),
  anon: process.env.SUPABASE_ANON_KEY,
  service: process.env.SUPABASE_SERVICE_ROLE_KEY
});

function send(response, status, body) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

const REFRESH_COOKIE = '__Host-kasir_nusa_refresh';

function cookieValue(request, name) {
  const cookies = String(request.headers?.cookie ?? '').split(';');
  const item = cookies.map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : null;
}

function setRefreshCookie(response, token) {
  const value = token ? encodeURIComponent(token) : '';
  // Browser boleh membatasi umur cookie, sehingga refresh token juga disimpan
  // permanen di penyimpanan aplikasi. Cookie ini tetap dibuat selama mungkin
  // sebagai jalur pemulihan HttpOnly.
  const maxAge = token ? 60 * 60 * 24 * 365 * 10 : 0;
  response.setHeader('set-cookie', `${REFRESH_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
}

function bodyOf(request) {
  if (!request.body) return {};
  if (typeof request.body === 'object') return request.body;
  return JSON.parse(request.body);
}

function queryValue(request, name) {
  const direct = request.query?.[name];
  if (Array.isArray(direct)) return direct[0] ?? null;
  if (direct !== undefined && direct !== null) return String(direct);
  return new URL(request.url, 'http://localhost').searchParams.get(name);
}

function moneyInput(value, label, { allowZero = false } = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || (allowZero ? amount < 0 : amount <= 0)) {
    const error = new Error(`${label} harus berupa nominal ${allowZero ? 'nol atau lebih' : 'lebih dari nol'}`);
    error.status = 400;
    throw error;
  }
  return amount;
}

function shiftIsoDate(value, days) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function supabase(path, { method = 'GET', body, token, prefer } = {}) {
  const config = env();
  if (!config.url || !config.anon || !config.service) throw new Error('Supabase environment belum dikonfigurasi');
  const apiKey = path.startsWith('/auth/v1/admin/') ? config.service : path.startsWith('/auth/v1/') ? config.anon : config.service;
  const response = await fetch(`${config.url}${path}`, {
    method,
    headers: {
      // Supabase Auth tetap memerlukan project API key pada header apikey.
      // Access token pengguna hanya digunakan sebagai Bearer token.
      apikey: apiKey,
      authorization: `Bearer ${token ?? apiKey}`,
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.message ?? data?.msg ?? data?.error_description ?? `Supabase ${response.status}`);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

const rest = (table, query = '', options = {}) => supabase(`/rest/v1/${table}${query ? `?${query}` : ''}`, options);
const rpc = (name, body) => supabase(`/rest/v1/rpc/${name}`, { method: 'POST', body });

function isSaleReceiptCollision(error) {
  const detail = `${error?.message ?? ''} ${error?.details?.message ?? ''} ${error?.details?.details ?? ''} ${error?.details?.constraint ?? ''}`;
  return error?.details?.code === '23505'
    && /sales_tenant_id_receipt_no_key|receipt_no/i.test(detail);
}

async function repairSaleReceiptSequence(context) {
  const prefix = String(context.outlet?.receipt_prefix ?? '').trim();
  if (!prefix) throw new Error('Awalan nomor struk outlet belum dikonfigurasi');
  const tenantId = encodeURIComponent(context.tenantId);
  const receipts = await rest(
    'sales',
    `tenant_id=eq.${tenantId}&receipt_no=like.${encodeURIComponent(`${prefix}-*`)}&select=receipt_no&limit=10000`
  );
  const highest = receipts.reduce((maximum, sale) => {
    const match = String(sale.receipt_no ?? '').match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`));
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  const requiredNext = highest + 1;
  const kind = `SALE:${context.outlet.id}`;
  await rest('document_sequences', 'on_conflict=tenant_id,kind', {
    method: 'POST',
    prefer: 'resolution=ignore-duplicates,return=minimal',
    body: { tenant_id: context.tenantId, kind, next_value: requiredNext }
  });
  await rest(
    'document_sequences',
    `tenant_id=eq.${tenantId}&kind=eq.${encodeURIComponent(kind)}&next_value=lt.${requiredNext}`,
    { method: 'PATCH', prefer: 'return=minimal', body: { next_value: requiredNext } }
  );
}

async function profileFor(userId) {
  const rows = await rest('profiles', `user_id=eq.${encodeURIComponent(userId)}&select=*`);
  return rows[0] ?? null;
}

async function sessionOf(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const authenticatedUser = await supabase('/auth/v1/user', { token });
  const authenticatedProfile = await profileFor(authenticatedUser.id);
  if (!authenticatedProfile?.active) return null;
  const requestedOwnerId = String(request.headers['x-owner-context-id'] ?? '').trim();
  let authUser = authenticatedUser;
  let profile = authenticatedProfile;
  let ownerContextActive = false;
  if (requestedOwnerId && requestedOwnerId !== authenticatedUser.id && authenticatedProfile.role === 'OWNER') {
    const requestedProfile = await profileFor(requestedOwnerId);
    if (requestedProfile?.active && requestedProfile.role === 'OWNER' && requestedProfile.tenant_id === authenticatedProfile.tenant_id) {
      authUser = { ...authenticatedUser, id: requestedOwnerId };
      profile = requestedProfile;
      ownerContextActive = true;
    }
  }
  const assignments = profile.role === 'OWNER' ? [] : await rest('user_outlets', `tenant_id=eq.${profile.tenant_id}&user_id=eq.${authUser.id}&select=outlet_id`);
  return {
    token, authUser, profile, outletIds: assignments.map((item) => item.outlet_id),
    permissions: PERMISSIONS[profile.role] ?? [], authenticatedUser,
    authenticatedProfile, ownerContextActive
  };
}

function requirePermission(session, permission) {
  if (!session) { const error = new Error('Sesi tidak valid'); error.status = 401; throw error; }
  if (!session.permissions.includes(permission)) { const error = new Error('Anda tidak memiliki hak untuk tindakan ini'); error.status = 403; throw error; }
}

function authPayload(auth, profile) {
  return {
    token: auth.access_token,
    refreshToken: auth.refresh_token,
    expiresIn: auth.expires_in,
    expiresAt: auth.expires_at,
    user: { id: auth.user.id, displayName: profile.display_name, role: profile.role },
    permissions: PERMISSIONS[profile.role] ?? []
  };
}

async function loadCatalog(tenantId, locationId) {
  const tenant = encodeURIComponent(tenantId);
  const [products, units, rules, balances] = await Promise.all([
    rest('products', `tenant_id=eq.${tenant}&active=eq.true&select=*&order=name`),
    rest('product_units', `tenant_id=eq.${tenant}&select=*`),
    rest('price_rules', `tenant_id=eq.${tenant}&select=*`),
    locationId ? rest('stock_balances', `tenant_id=eq.${tenant}&location_id=eq.${encodeURIComponent(locationId)}&select=*`) : Promise.resolve([])
  ]);
  return products.map((product) => ({
    id: product.id, sku: product.sku, name: product.name, category: product.category, brand: product.brand, active: product.active,
    variantGroup: product.variant_group, variantName: product.variant_name, minimumStock: Number(product.minimum_stock ?? 0), trackExpiry: Boolean(product.track_expiry),
    stockBase: Number(balances.find((item) => item.product_id === product.id)?.quantity ?? 0),
    units: units.filter((item) => item.product_id === product.id).map((unit) => ({ id: unit.id, name: unit.name, factor: Number(unit.factor_to_base), barcode: unit.barcode })).sort((a,b)=>a.factor-b.factor),
    priceRules: rules.filter((item) => item.product_id === product.id).map((rule) => ({ id: rule.id, customerGroupId: rule.customer_group_id, minBaseQty: Number(rule.min_base_qty), unitPriceBase: Number(rule.unit_price_base), priority: rule.priority }))
  }));
}

async function loadCustomerAccounts(tenantId) {
  const tenant=encodeURIComponent(tenantId);
  const [customers,entries,sales]=await Promise.all([
    rest('customers',`tenant_id=eq.${tenant}&active=eq.true&select=*&order=name`),
    rest('customer_account_entries',`tenant_id=eq.${tenant}&select=customer_id,amount,occurred_at`),
    rest('sales',`tenant_id=eq.${tenant}&credit_amount=gt.0&account_status=in.(OPEN,PARTIAL,OVERDUE)&select=id,customer_id,receipt_no,credit_amount,paid_credit_amount,returned_credit_amount,due_on,occurred_at`)
  ]);
  const today=new Date().toISOString().slice(0,10);
  return customers.map((customer)=>{
    const customerEntries=entries.filter((entry)=>entry.customer_id===customer.id);
    const openInvoices=sales.filter((sale)=>sale.customer_id===customer.id);
    const balance=customerEntries.reduce((sum,entry)=>sum+Number(entry.amount),0);
    const overdue=openInvoices.filter((sale)=>sale.due_on&&sale.due_on<today).reduce((sum,sale)=>sum+Math.max(0,Number(sale.credit_amount)-Number(sale.paid_credit_amount)-Number(sale.returned_credit_amount??0)),0);
    return {...customer,credit_limit:Number(customer.credit_limit??0),credit_days:Number(customer.credit_days??0),account_balance:balance,available_credit:Math.max(0,Number(customer.credit_limit??0)-balance),overdue_balance:overdue,open_invoice_count:openInvoices.length};
  });
}

async function loadSupplierAccounts(tenantId){
  const tenant=encodeURIComponent(tenantId),today=new Date().toISOString().slice(0,10);
  const [suppliers,bills]=await Promise.all([
    rest('suppliers',`tenant_id=eq.${tenant}&active=eq.true&select=*&order=name`),
    rest('supplier_bills',`tenant_id=eq.${tenant}&select=*`)
  ]);
  return suppliers.map((supplier)=>{
    const own=bills.filter((bill)=>bill.supplier_id===supplier.id),balance=own.reduce((sum,bill)=>sum+Math.max(0,Number(bill.original_amount)-Number(bill.return_credit_amount)-Number(bill.paid_amount)),0);
    const overdue=own.filter((bill)=>bill.due_on&&bill.due_on<today).reduce((sum,bill)=>sum+Math.max(0,Number(bill.original_amount)-Number(bill.return_credit_amount)-Number(bill.paid_amount)),0);
    return {...supplier,payment_terms_days:Number(supplier.payment_terms_days??0),payable_balance:balance,overdue_balance:overdue,open_bill_count:own.filter((bill)=>Number(bill.original_amount)>Number(bill.return_credit_amount)+Number(bill.paid_amount)).length};
  });
}

async function loadManagedProducts(tenantId) {
  const tenant=encodeURIComponent(tenantId);
  const [products,units,rules,balances]=await Promise.all([
    rest('products',`tenant_id=eq.${tenant}&select=*&order=active.desc,name`),
    rest('product_units',`tenant_id=eq.${tenant}&select=*`),
    rest('price_rules',`tenant_id=eq.${tenant}&starts_at=is.null&ends_at=is.null&select=*`),
    rest('stock_balances',`tenant_id=eq.${tenant}&select=product_id,quantity`)
  ]);
  return products.map((product)=>({
    id:product.id,sku:product.sku,name:product.name,category:product.category,brand:product.brand,active:product.active,
    variantGroup:product.variant_group,variantName:product.variant_name,minimumStock:Number(product.minimum_stock??0),trackExpiry:Boolean(product.track_expiry),
    stockBase:balances.filter((balance)=>balance.product_id===product.id).reduce((sum,balance)=>sum+Number(balance.quantity),0),
    units:units.filter((unit)=>unit.product_id===product.id).map((unit)=>({id:unit.id,name:unit.name,factor:Number(unit.factor_to_base),barcode:unit.barcode})).sort((a,b)=>a.factor-b.factor),
    priceRules:rules.filter((rule)=>rule.product_id===product.id).map((rule)=>({id:rule.id,customerGroupId:rule.customer_group_id,minBaseQty:Number(rule.min_base_qty),unitPriceBase:Number(rule.unit_price_base),priority:rule.priority}))
  }));
}

function normalizeProductInput(input,id=null) {
  const units=Array.isArray(input.units)&&input.units.length?input.units:[{name:input.unitName||'pcs',factor:1,barcode:input.barcode||null}];
  const normalized={
    id:id??input.id??null,sku:String(input.sku??'').trim().toUpperCase(),name:String(input.name??'').trim(),
    category:String(input.category??'').trim()||'Lainnya',brand:String(input.brand??'').trim(),
    variantGroup:String(input.variantGroup??'').trim(),variantName:String(input.variantName??'').trim(),
    minimumStock:Number(input.minimumStock??0),trackExpiry:Boolean(input.trackExpiry),
    retailPrice:Number(input.retailPrice),wholesalePrice:Number(input.wholesalePrice??0),
    tierQty:Number(input.tierQty??0),tierPrice:Number(input.tierPrice??0),
    units:units.map((unit)=>({id:unit.id??null,name:String(unit.name??'').trim(),factor:Number(unit.factor),barcode:String(unit.barcode??'').trim()}))
  };
  if(!normalized.sku||!normalized.name)throw Object.assign(new Error('SKU dan nama produk wajib diisi'),{status:400});
  if(!(normalized.retailPrice>0))throw Object.assign(new Error('Harga ecer harus lebih dari nol'),{status:400});
  if(!(normalized.minimumStock>=0))throw Object.assign(new Error('Batas stok minimum tidak valid'),{status:400});
  if(normalized.units.filter((unit)=>unit.factor===1).length!==1||normalized.units.some((unit)=>!unit.name||!(unit.factor>0)))throw Object.assign(new Error('Satuan harus memiliki tepat satu satuan dasar berisi 1'),{status:400});
  const names=new Set(),barcodes=new Set();
  for(const unit of normalized.units){
    const name=unit.name.toLowerCase();
    if(names.has(name))throw Object.assign(new Error(`Satuan ${unit.name} tercatat dua kali`),{status:400});names.add(name);
    if(unit.barcode&&barcodes.has(unit.barcode))throw Object.assign(new Error(`Barcode ${unit.barcode} tercatat dua kali`),{status:400});
    if(unit.barcode)barcodes.add(unit.barcode);
  }
  return normalized;
}

async function loadPromotions(tenantId) {
  const tenant = encodeURIComponent(tenantId);
  const [promotions, versions] = await Promise.all([
    rest('promotions', `tenant_id=eq.${tenant}&select=*`),
    rest('promotion_versions', `tenant_id=eq.${tenant}&status=eq.PUBLISHED&select=*&order=priority.desc`)
  ]);
  return versions.filter((version)=>version.usage_limit_total==null||Number(version.usage_count??0)<Number(version.usage_limit_total)).map((version) => {
    const promotion = promotions.find((item) => item.id === version.promotion_id);
    return { id: version.id, promotionId: version.promotion_id, code: promotion?.code, name: promotion?.name, version: version.version, status: version.status, startsAt: version.starts_at, endsAt: version.ends_at, priority: version.priority, stackable: version.stackable, usageLimitTotal: version.usage_limit_total, usageLimitPerCustomer: version.usage_limit_per_customer, usageCount:Number(version.usage_count??0), condition: version.rule_json.condition, reward: version.rule_json.reward };
  });
}

async function loadPromotionManagement(tenantId) {
  const tenant=encodeURIComponent(tenantId);
  const [promotions,versions,redemptions]=await Promise.all([
    rest('promotions',`tenant_id=eq.${tenant}&select=*&order=created_at.desc`),
    rest('promotion_versions',`tenant_id=eq.${tenant}&select=*&order=published_at.desc.nullslast,created_at.desc`),
    rest('promotion_redemptions',`tenant_id=eq.${tenant}&select=promotion_version_id,discount_amount`)
  ]);
  return versions.map((version)=>{
    const promotion=promotions.find((item)=>item.id===version.promotion_id);
    const uses=redemptions.filter((item)=>item.promotion_version_id===version.id);
    return {
      id:version.id,promotionId:version.promotion_id,code:promotion?.code,name:promotion?.name,version:version.version,
      status:version.status,startsAt:version.starts_at,endsAt:version.ends_at,priority:version.priority,stackable:version.stackable,
      usageLimitTotal:version.usage_limit_total,usageLimitPerCustomer:version.usage_limit_per_customer,
      usageCount:Number(version.usage_count??uses.length),discountGiven:uses.reduce((sum,item)=>sum+Number(item.discount_amount),0),
      condition:version.rule_json?.condition??{},reward:version.rule_json?.reward??{}
    };
  });
}

async function cloudContext(session, request) {
  const tenantId = session.profile.tenant_id;
  const [allOutlets, allLocations] = await Promise.all([
    rest('outlets', `tenant_id=eq.${tenantId}&active=eq.true&select=*`),
    rest('stock_locations', `tenant_id=eq.${tenantId}&active=eq.true&select=*`)
  ]);
  const assigned = new Set(session.outletIds);
  const outlets = session.profile.role === 'OWNER' ? allOutlets : allOutlets.filter((item) => assigned.has(item.id));
  if (!outlets.length) { const error = new Error('User belum ditempatkan pada outlet aktif'); error.status = 403; throw error; }
  const requestedOutletId = request.headers['x-outlet-id'];
  const outlet = requestedOutletId ? outlets.find((item) => item.id === requestedOutletId) : outlets[0];
  if (!outlet) { const error = new Error('User tidak memiliki akses ke outlet tersebut'); error.status = 403; throw error; }
  const allowedOutlets = new Set(outlets.map((item) => item.id));
  const locations = session.profile.role === 'OWNER' ? allLocations : allLocations.filter((item) => item.outlet_id && allowedOutlets.has(item.outlet_id));
  const storeLocation = locations.find((item) => item.outlet_id === outlet?.id && item.kind === 'STORE');
  return { tenantId, outlets, locations, outlet, storeLocation, locationIds: locations.map((item) => item.id) };
}

function businessPayload(row = {}) {
  return {
    id: row.id ?? null, name: row.name ?? 'Kasir Nusa', legalName: row.legal_name ?? '',
    phone: row.phone ?? '', email: row.email ?? '', address: row.address ?? '', taxId: row.tax_id ?? '',
    currency: row.currency ?? 'IDR', receiptFooter: row.receipt_footer ?? 'Terima kasih telah berbelanja.',
    logoUrl: row.logo_url ?? ''
  };
}

function devicePayload(row, fallbackId = null) {
  return {
    id: row?.id ?? fallbackId, outletId: row?.outlet_id ?? null, name: row?.name ?? '',
    platform: row?.platform ?? '', paperWidth: Number(row?.paper_width ?? 80),
    autoPrint: Boolean(row?.auto_print), receiptCopies: Number(row?.receipt_copies ?? 1),
    active: row?.active !== false
  };
}

function requireLocationAccess(context, locationId) {
  if (!context.locationIds.includes(locationId)) { const error = new Error('User tidak memiliki akses ke lokasi stok tersebut'); error.status = 403; throw error; }
}

function inFilter(values) {
  return `in.(${values.map((value) => encodeURIComponent(value)).join(',')})`;
}

async function loadPurchaseOrders(tenantId, orderId = null, locationIds = []) {
  const tenant = encodeURIComponent(tenantId);
  const idFilter = orderId ? `&id=eq.${encodeURIComponent(orderId)}` : '';
  const locationFilter = locationIds.length ? `&location_id=${inFilter(locationIds)}` : '';
  const orders = await rest('purchase_orders', `tenant_id=eq.${tenant}${idFilter}${locationFilter}&select=*&order=created_at.desc&limit=100`);
  if (!orders.length) return [];
  const orderIds = orders.map((order) => order.id).join(',');
  const items = await rest('purchase_order_items', `tenant_id=eq.${tenant}&order_id=in.(${orderIds})&select=*&order=product_name`);
  const today = new Date().toISOString().slice(0, 10);
  return orders.map((order) => {
    const mappedItems = items.filter((item) => item.order_id === order.id).map((item) => ({
      ...item, ordered_qty: Number(item.ordered_qty), received_qty: Number(item.received_qty),
      remaining_qty: Number(item.ordered_qty) - Number(item.received_qty), unit_cost: Number(item.unit_cost),
      line_discount: Number(item.line_discount), line_total: Number(item.line_total)
    }));
    return {
    ...order, approval_required: Boolean(order.approval_required),
    subtotal: Number(order.subtotal), discount_amount: Number(order.discount_amount), tax_amount: Number(order.tax_amount),
    other_cost: Number(order.other_cost), grand_total: Number(order.grand_total),
    outstanding_qty: mappedItems.reduce((sum, item) => sum + item.remaining_qty, 0),
    overdue: Boolean(order.expected_on && order.expected_on < today && ['APPROVED','PARTIALLY_RECEIVED'].includes(order.status)),
    items: mappedItems
  }});
}

async function shiftDetail(tenantId, shift) {
  if (!shift) return null;
  const [sales, movements, cashier] = await Promise.all([
    rest('sales', `tenant_id=eq.${tenantId}&shift_id=eq.${shift.id}&status=eq.COMPLETED&select=id`),
    rest('cash_movements', `tenant_id=eq.${tenantId}&shift_id=eq.${shift.id}&select=*&order=occurred_at.desc`),
    profileFor(shift.cashier_id)
  ]);
  const payments=sales.length?await rest('payments',`tenant_id=eq.${tenantId}&sale_id=${inFilter(sales.map((sale)=>sale.id))}&select=method,amount`):[];
  const paymentTotals=Object.values(payments.reduce((totals,payment)=>{
    const rawMethod=String(payment.method??'').trim().toUpperCase()||'LAINNYA';
    const method=['CASH','TUNAI'].includes(rawMethod)?'CASH':rawMethod;
    totals[method]??={method,expectedAmount:0};
    totals[method].expectedAmount+=Number(payment.amount);
    return totals;
  },{}));
  const cashPayments=paymentTotals.find((item)=>item.method==='CASH')?.expectedAmount??0;
  const expectedNow = Number(shift.opening_cash) + cashPayments + movements.reduce((sum, item) => sum + (item.movement_type === 'CASH_IN' ? Number(item.amount) : -Number(item.amount)), 0);
  const cash=paymentTotals.find((item)=>item.method==='CASH');
  if(cash)cash.expectedAmount=expectedNow;
  else paymentTotals.unshift({method:'CASH',expectedAmount:expectedNow});
  return { ...shift, cashier_name: cashier?.display_name, expectedNow, paymentTotals, movements };
}

async function loadReturnableSale(context, { saleId = null, receiptNo = null } = {}) {
  const identifier = saleId ? `id=eq.${encodeURIComponent(saleId)}` : `receipt_no=eq.${encodeURIComponent(String(receiptNo ?? '').trim().toUpperCase())}`;
  const sales = await rest('sales', `tenant_id=eq.${context.tenantId}&${identifier}&outlet_id=${inFilter(context.outlets.map((outlet) => outlet.id))}&status=eq.COMPLETED&select=*&limit=1`);
  const sale = sales[0];
  if (!sale) return null;
  const [saleItems, returns, customers, cashiers] = await Promise.all([
    rest('sale_items', `tenant_id=eq.${context.tenantId}&sale_id=eq.${sale.id}&select=*&order=id`),
    rest('customer_returns', `tenant_id=eq.${context.tenantId}&sale_id=eq.${sale.id}&status=eq.COMPLETED&select=*&order=occurred_at.desc`),
    sale.customer_id ? rest('customers', `tenant_id=eq.${context.tenantId}&id=eq.${sale.customer_id}&select=id,name,phone&limit=1`) : [],
    rest('profiles', `tenant_id=eq.${context.tenantId}&user_id=eq.${sale.cashier_id}&select=user_id,display_name&limit=1`)
  ]);
  const returnIds = returns.map((item) => item.id);
  const [returnItems, refunds] = returnIds.length ? await Promise.all([
    rest('customer_return_items', `tenant_id=eq.${context.tenantId}&return_id=${inFilter(returnIds)}&select=*`),
    rest('customer_refunds', `tenant_id=eq.${context.tenantId}&return_id=${inFilter(returnIds)}&select=*`)
  ]) : [[], []];
  const directByLine = new Map(); const legacyByProduct = new Map();
  for (const item of returnItems) {
    if (item.sale_item_id) directByLine.set(item.sale_item_id, (directByLine.get(item.sale_item_id) ?? 0)+Number(item.base_qty));
    else legacyByProduct.set(item.product_id, (legacyByProduct.get(item.product_id) ?? 0)+Number(item.base_qty));
  }
  const lines = saleItems.map((line) => {
    const soldQty = Number(line.base_qty); const directQty = directByLine.get(line.id) ?? 0;
    const legacyAvailable = legacyByProduct.get(line.product_id) ?? 0;
    const legacyUsed = Math.min(Math.max(0, soldQty-directQty), legacyAvailable);
    legacyByProduct.set(line.product_id, Math.max(0, legacyAvailable-legacyUsed));
    const returnedQty = directQty+legacyUsed; const remainingQty = Math.max(0, soldQty-returnedQty);
    return {
      saleItemId: line.id, productId: line.product_id, productName: line.product_name,
      soldQty, returnedQty, remainingQty, gross: Number(line.gross), discount: Number(line.discount),
      total: Number(line.total), unitRefund: soldQty ? Number(line.total)/soldQty : 0
    };
  });
  return {
    id: sale.id, receiptNo: sale.receipt_no, outletId: sale.outlet_id,
    outletName: context.outlets.find((item) => item.id === sale.outlet_id)?.name ?? 'Outlet',
    customer: customers[0] ?? null, cashierName: cashiers[0]?.display_name ?? 'Kasir',
    paymentMethod: sale.payment_method, grandTotal: Number(sale.grand_total), creditAmount:Number(sale.credit_amount??0),
    paidCreditAmount:Number(sale.paid_credit_amount??0),returnedCreditAmount:Number(sale.returned_credit_amount??0), occurredAt: sale.occurred_at,
    status: lines.some((line) => line.remainingQty>0) ? (returnItems.length ? 'PARTIALLY_RETURNED' : 'RETURNABLE') : 'FULLY_RETURNED',
    refundableTotal: lines.reduce((sum, line) => sum+(line.remainingQty*line.unitRefund),0), lines,
    returns: returns.map((returned) => ({
      id: returned.id, returnNo: returned.return_no, reason: returned.reason, total: Number(returned.total),
      refundMethod: returned.refund_method, refundReference: returned.refund_reference, occurredAt: returned.occurred_at,
      items: returnItems.filter((item) => item.return_id === returned.id).map((item) => ({
        productId: item.product_id, baseQty: Number(item.base_qty), lineTotal: Number(item.line_total),
        condition: item.item_condition ?? 'SALEABLE', restockable: item.restockable !== false
      })),
      refund: refunds.find((refund) => refund.return_id === returned.id) ?? null
    }))
  };
}

async function loadPosSales(context, query = '') {
  const sales = await rest('sales', `tenant_id=eq.${context.tenantId}&outlet_id=eq.${context.outlet.id}&status=in.(COMPLETED,VOIDED)&select=*&order=occurred_at.desc&limit=50`);
  if (!sales.length) return [];
  const saleIds = sales.map((sale) => sale.id);
  const customerIds = [...new Set(sales.map((sale) => sale.customer_id).filter(Boolean))];
  const cashierIds = [...new Set(sales.map((sale) => sale.cashier_id).filter(Boolean))];
  const [items,payments,customers,cashiers] = await Promise.all([
    rest('sale_items', `tenant_id=eq.${context.tenantId}&sale_id=${inFilter(saleIds)}&select=*&order=id`),
    rest('payments', `tenant_id=eq.${context.tenantId}&sale_id=${inFilter(saleIds)}&select=*&order=created_at`),
    customerIds.length ? rest('customers', `tenant_id=eq.${context.tenantId}&id=${inFilter(customerIds)}&select=id,name,phone,notes`) : [],
    cashierIds.length ? rest('profiles', `tenant_id=eq.${context.tenantId}&user_id=${inFilter(cashierIds)}&select=user_id,display_name`) : []
  ]);
  const adjustmentIds=[...new Set(items.flatMap((item)=>
    (item.promotion_snapshot??[])
      .filter((promotion)=>promotion.manual&&promotion.id)
      .map((promotion)=>promotion.id)
  ))];
  const adjustments=adjustmentIds.length
    ? await rest('sale_adjustment_authorizations',`tenant_id=eq.${context.tenantId}&id=${inFilter(adjustmentIds)}&select=id,adjustment_json,discount_amount`)
    : [];
  const normalized = String(query ?? '').trim().toLowerCase();
  return sales.map((sale) => {
    const customer = customers.find((item) => item.id === sale.customer_id) ?? null;
    const cashier = cashiers.find((item) => item.user_id === sale.cashier_id)?.display_name ?? 'Kasir';
    const lines = items.filter((item) => item.sale_id === sale.id).map((item) => ({
      productId:item.product_id,productName:item.product_name,
      qty:Number(item.pricing_snapshot?.qty ?? item.base_qty),
      unitName:item.pricing_snapshot?.unitName ?? 'pcs',baseQty:Number(item.base_qty),
      gross:Number(item.gross),discount:Number(item.discount),total:Number(item.total),
      promotions:item.promotion_snapshot ?? []
    }));
    const adjustmentId=lines.flatMap((line)=>line.promotions)
      .find((promotion)=>promotion.manual&&promotion.id)?.id;
    const savedAdjustment=adjustments.find((adjustment)=>adjustment.id===adjustmentId);
    const manualAdjustment=savedAdjustment
      ? {
          ...savedAdjustment.adjustment_json,
          authorizationId:savedAdjustment.id,
          discountAmount:Number(savedAdjustment.discount_amount)
        }
      : null;
    return {
      id:sale.id,receiptNo:sale.receipt_no,status:sale.status,occurredAt:sale.occurred_at,
      cashier,outletName:context.outlet.name,customer,notes:sale.notes ?? '',
      voidReason:sale.void_reason ?? '',voidedAt:sale.voided_at ?? null,
      quote:{
        lines,subtotal:Number(sale.subtotal),discountTotal:Number(sale.discount_total),
        grandTotal:Number(sale.grand_total),...(manualAdjustment?{manualAdjustment}:{})
      },
      payments:payments.filter((item) => item.sale_id === sale.id).map((item) => ({
        method:item.method,amount:Number(item.amount),tendered:item.tendered_amount == null ? null : Number(item.tendered_amount),
        reference:item.reference ?? ''
      }))
    };
  }).filter((sale) => !normalized || `${sale.receiptNo} ${sale.cashier} ${sale.customer?.name ?? ''} ${sale.customer?.phone ?? ''}`.toLowerCase().includes(normalized));
}

async function approvedSupervisor(session, tenantId, input) {
  if (['OWNER','ADMIN'].includes(session.profile.role)) return { id:session.authUser.id, profile:session.profile };
  const email = String(input.approverEmail ?? '').trim().toLowerCase();
  const password = String(input.approverPassword ?? '');
  if (!email || !password) { const error = new Error('Email dan kata sandi Owner/Admin wajib diisi'); error.status = 400; throw error; }
  let auth;
  try {
    const config = env();
    auth = await supabase('/auth/v1/token?grant_type=password', {
      method:'POST',body:{email,password},token:config.anon
    });
  } catch {
    const error = new Error('Email atau kata sandi Owner/Admin salah'); error.status = 422; throw error;
  }
  const profile = await profileFor(auth.user.id);
  await supabase('/auth/v1/logout?scope=local', { method:'POST',token:auth.access_token }).catch(() => {});
  if (!profile?.active || profile.tenant_id !== tenantId || !['OWNER','ADMIN'].includes(profile.role)) {
    const error = new Error('Akun tersebut bukan Owner atau Admin aktif pada usaha ini'); error.status = 403; throw error;
  }
  return { id:auth.user.id, profile };
}

async function loadReturnablePurchase(context,{receiptId=null,documentNo=null,supplierId=null}={}) {
  const identifier=receiptId?`id=eq.${encodeURIComponent(receiptId)}`:`document_no=eq.${encodeURIComponent(String(documentNo??'').trim())}`;
  const supplierFilter=supplierId?`&supplier_id=eq.${encodeURIComponent(supplierId)}`:'';
  const receipts=await rest('purchase_receipts',`tenant_id=eq.${context.tenantId}&${identifier}${supplierFilter}&location_id=${inFilter(context.locationIds)}&status=eq.RECEIVED&select=*&limit=1`);
  const receipt=receipts[0];if(!receipt)return null;
  const [items,products,batches,returns]=await Promise.all([
    rest('purchase_receipt_items',`tenant_id=eq.${context.tenantId}&receipt_id=eq.${receipt.id}&select=*&order=id`),
    rest('products',`tenant_id=eq.${context.tenantId}&select=id,sku,name`),
    rest('inventory_batches',`tenant_id=eq.${context.tenantId}&receipt_id=eq.${receipt.id}&select=*`),
    rest('supplier_returns',`tenant_id=eq.${context.tenantId}&receipt_id=eq.${receipt.id}&status=eq.POSTED&select=*&order=occurred_at.desc`)
  ]);
  const returnIds=returns.map((item)=>item.id);
  const returnItems=returnIds.length?await rest('supplier_return_items',`tenant_id=eq.${context.tenantId}&return_id=${inFilter(returnIds)}&select=*`):[];
  const lines=items.map((item)=>{
    const product=products.find((row)=>row.id===item.product_id),batch=batches.find((row)=>row.receipt_item_id===item.id);
    const returnedQty=returnItems.filter((row)=>row.receipt_item_id===item.id).reduce((sum,row)=>sum+Number(row.base_qty),0);
    const receivedQty=Number(item.base_qty),batchAvailable=Number(batch?.available_qty??0);
    return {
      receiptItemId:item.id,batchId:batch?.id??null,productId:item.product_id,productName:product?.name??'Produk',
      sku:product?.sku??'',receivedQty,returnedQty,batchAvailable,
      remainingReceiptQty:Math.max(0,receivedQty-returnedQty),maxReturnQty:Math.max(0,Math.min(receivedQty-returnedQty,batchAvailable)),
      unitCost:Number(item.unit_cost),batchNo:item.batch_no,expiresOn:item.expires_on
    };
  });
  return {
    id:receipt.id,documentNo:receipt.document_no,supplierId:receipt.supplier_id,supplierName:receipt.supplier_name,
    locationId:receipt.location_id,locationName:context.locations.find((item)=>item.id===receipt.location_id)?.name??'Lokasi',
    occurredAt:receipt.occurred_at,totalReceived:lines.reduce((sum,line)=>sum+line.receivedQty*line.unitCost,0),
    returnableCredit:lines.reduce((sum,line)=>sum+line.maxReturnQty*line.unitCost,0),
    status:lines.some((line)=>line.maxReturnQty>0)?(returnItems.length?'PARTIALLY_RETURNED':'RETURNABLE'):'NOT_RETURNABLE',
    lines,returns:returns.map((doc)=>({
      id:doc.id,returnNo:doc.return_no,reason:doc.reason,settlementType:doc.settlement_type,
      supplierReference:doc.supplier_reference,totalCredit:Number(doc.total_credit),occurredAt:doc.occurred_at,
      items:returnItems.filter((item)=>item.return_id===doc.id).map((item)=>({productName:item.product_name,baseQty:Number(item.base_qty),lineTotal:Number(item.line_total)}))
    }))
  };
}

function importNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function normalizeImportRows(kind, rawRows) {
  const rows = [], errors = [], seenCodes = new Set(), seenBarcodes = new Set();
  const addError = (row, field, message) => errors.push({ row, field, message });
  if (!Array.isArray(rawRows) || !rawRows.length) return { rows, errors: [{ row: 0, field: 'file', message: 'File tidak memiliki data' }] };
  if (rawRows.length > 500) return { rows, errors: [{ row: 0, field: 'file', message: 'Maksimal 500 baris per impor' }] };

  rawRows.forEach((raw, index) => {
    const rowNo = index + 2;
    if (kind === 'PRODUCTS') {
      const row = {
        sku: String(raw.sku ?? '').trim().toUpperCase(), name: String(raw.name ?? '').trim(),
        category: String(raw.category ?? '').trim() || 'Lainnya', brand: String(raw.brand ?? '').trim(),
        baseUnit: String(raw.baseUnit ?? '').trim() || 'pcs', baseBarcode: String(raw.baseBarcode ?? '').trim(),
        retailPrice: importNumber(raw.retailPrice), wholesalePrice: importNumber(raw.wholesalePrice),
        tierQty: importNumber(raw.tierQty), tierPrice: importNumber(raw.tierPrice),
        bulkUnit: String(raw.bulkUnit ?? '').trim(), bulkFactor: importNumber(raw.bulkFactor),
        bulkBarcode: String(raw.bulkBarcode ?? '').trim(), openingQty: importNumber(raw.openingQty),
        openingCost: importNumber(raw.openingCost), batchNo: String(raw.batchNo ?? '').trim(),
        expiresOn: String(raw.expiresOn ?? '').trim()
      };
      if (!row.sku) addError(rowNo, 'sku', 'SKU wajib diisi');
      if (!row.name) addError(rowNo, 'name', 'Nama produk wajib diisi');
      if (!(row.retailPrice > 0)) addError(rowNo, 'retailPrice', 'Harga ecer harus lebih dari nol');
      if (seenCodes.has(row.sku)) addError(rowNo, 'sku', `SKU ${row.sku} muncul lebih dari sekali`);
      if (row.sku) seenCodes.add(row.sku);
      for (const [field, barcode] of [['baseBarcode',row.baseBarcode],['bulkBarcode',row.bulkBarcode]]) {
        if (barcode && seenBarcodes.has(barcode)) addError(rowNo, field, `Barcode ${barcode} muncul lebih dari sekali`);
        if (barcode) seenBarcodes.add(barcode);
      }
      if (row.wholesalePrice !== null && !(row.wholesalePrice >= 0)) addError(rowNo, 'wholesalePrice', 'Harga grosir tidak valid');
      if ((row.tierQty || row.tierPrice) && (!(row.tierQty > 1) || !(row.tierPrice > 0))) addError(rowNo, 'tierQty', 'Jumlah dan harga bertingkat harus diisi bersama');
      if ((row.bulkUnit || row.bulkFactor || row.bulkBarcode) && (!row.bulkUnit || !(row.bulkFactor > 1))) addError(rowNo, 'bulkUnit', 'Satuan besar dan isi per satuan harus diisi bersama');
      if (row.openingQty !== null && !(row.openingQty >= 0)) addError(rowNo, 'openingQty', 'Stok awal tidak valid');
      if (row.openingQty > 0 && !(row.openingCost >= 0)) addError(rowNo, 'openingCost', 'Modal awal wajib diisi');
      if (row.expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(row.expiresOn)) addError(rowNo, 'expiresOn', 'Tanggal EXP harus YYYY-MM-DD');
      rows.push(row);
      return;
    }
    const row = { code: String(raw.code ?? '').trim().toUpperCase(), name: String(raw.name ?? '').trim(), phone: String(raw.phone ?? '').trim() };
    if (!row.code) addError(rowNo, 'code', 'Kode wajib diisi');
    if (!row.name) addError(rowNo, 'name', 'Nama wajib diisi');
    if (seenCodes.has(row.code)) addError(rowNo, 'code', `Kode ${row.code} muncul lebih dari sekali`);
    if (row.code) seenCodes.add(row.code);
    if (kind === 'CUSTOMERS') {
      const group = String(raw.groupId ?? 'retail').trim().toLowerCase();
      row.groupId = ['retail','ecer','eceran'].includes(group) ? 'retail' : ['wholesale','grosir'].includes(group) ? 'wholesale' : group;
      if (!['retail','wholesale'].includes(row.groupId)) addError(rowNo, 'groupId', 'Kelompok harus eceran atau grosir');
    } else row.address = String(raw.address ?? '').trim();
    rows.push(row);
  });
  return { rows, errors };
}

async function previewImport(context, input) {
  const kind = String(input.kind ?? '').toUpperCase();
  if (!['PRODUCTS','CUSTOMERS','SUPPLIERS'].includes(kind)) return { valid: false, kind, rows: [], errors: [{ row: 0, field: 'kind', message: 'Jenis impor tidak valid' }] };
  const normalized = normalizeImportRows(kind, input.rows);
  const locationId = input.locationId || null;
  if (kind === 'PRODUCTS' && normalized.rows.some((row) => row.openingQty !== null) && !context.locationIds.includes(locationId)) {
    normalized.errors.push({ row: 0, field: 'locationId', message: 'Pilih lokasi untuk stok awal' });
  }
  const table = kind === 'PRODUCTS' ? 'products' : kind === 'CUSTOMERS' ? 'customers' : 'suppliers';
  const codeField = kind === 'PRODUCTS' ? 'sku' : 'code';
  const existing = await rest(table, `tenant_id=eq.${context.tenantId}&select=id,${codeField}`);
  const existingCodes = new Set(existing.map((row) => String(row[codeField]).toUpperCase()));
  if (kind === 'PRODUCTS') {
    const units = await rest('product_units', `tenant_id=eq.${context.tenantId}&barcode=not.is.null&select=product_id,barcode`);
    const productCodeById = new Map(existing.map((row) => [row.id,String(row.sku).toUpperCase()]));
    const barcodeOwner = new Map(units.map((unit) => [unit.barcode,productCodeById.get(unit.product_id)]));
    normalized.rows.forEach((row,index) => {
      for (const [field,barcode] of [['baseBarcode',row.baseBarcode],['bulkBarcode',row.bulkBarcode]]) {
        const owner = barcodeOwner.get(barcode);
        if (barcode && owner && owner !== row.sku) normalized.errors.push({ row: index+2, field, message: `Barcode sudah digunakan SKU ${owner}` });
      }
    });
    const existingIds = normalized.rows.map((row) => existing.find((item) => String(item.sku).toUpperCase() === row.sku)?.id).filter(Boolean);
    if (locationId && existingIds.length) {
      const ledger = await rest('stock_ledger', `tenant_id=eq.${context.tenantId}&location_id=eq.${locationId}&product_id=${inFilter(existingIds)}&select=product_id`);
      const withHistory = new Set(ledger.map((row) => row.product_id));
      normalized.rows.forEach((row,index) => {
        const productId = existing.find((item) => String(item.sku).toUpperCase() === row.sku)?.id;
        if (row.openingQty !== null && productId && withHistory.has(productId)) normalized.errors.push({ row: index+2, field: 'openingQty', message: 'Produk sudah memiliki transaksi; gunakan stok opname, bukan stok awal' });
      });
    }
  }
  const summary = {
    total: normalized.rows.length,
    create: normalized.rows.filter((row) => !existingCodes.has(String(row[codeField]).toUpperCase())).length,
    update: normalized.rows.filter((row) => existingCodes.has(String(row[codeField]).toUpperCase())).length,
    error: normalized.errors.length
  };
  return { valid: normalized.errors.length === 0, kind, locationId, rows: normalized.rows, errors: normalized.errors, summary };
}

function backupChecksum(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function buildBackup(context, session) {
  const entries = await Promise.all(BACKUP_TABLES.map(async (table) => {
    const query = table === 'tenants'
      ? `id=eq.${context.tenantId}&select=*`
      : `tenant_id=eq.${context.tenantId}&select=*`;
    return [table, await rest(table, query)];
  }));
  const tables = Object.fromEntries(entries);
  const payload = {
    format: 'KASIR_NUSA_BACKUP',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    tenantId: context.tenantId,
    createdBy: { userId: session.authUser.id, displayName: session.profile.display_name },
    tables
  };
  return { ...payload, checksum: backupChecksum(payload) };
}

function verifyBackup(snapshot, tenantId) {
  if (!snapshot || snapshot.format !== 'KASIR_NUSA_BACKUP') return { valid:false, message:'File ini bukan backup Kasir Nusa' };
  if (snapshot.schemaVersion !== 1) return { valid:false, message:'Versi file backup belum didukung' };
  if (snapshot.tenantId !== tenantId) return { valid:false, message:'Backup berasal dari usaha yang berbeda' };
  if (!snapshot.tables || typeof snapshot.tables !== 'object') return { valid:false, message:'Isi tabel backup tidak lengkap' };
  const { checksum, ...payload } = snapshot;
  const calculated = backupChecksum(payload);
  if (!checksum || calculated !== checksum) return { valid:false, message:'File berubah atau rusak; checksum tidak cocok' };
  const rowCounts = Object.fromEntries(Object.entries(snapshot.tables).map(([table,rows]) => [table,Array.isArray(rows)?rows.length:0]));
  return {
    valid:true, message:'Backup utuh dan dapat dibaca', schemaVersion:snapshot.schemaVersion,
    createdAt:snapshot.createdAt, totalRows:Object.values(rowCounts).reduce((sum,count)=>sum+count,0), rowCounts
  };
}

function hashApprovalToken(token) {
  return createHash('sha256').update(String(token ?? '')).digest('hex');
}

function saleAdjustmentFingerprint(lines, customerGroupId, adjustment) {
  return createHash('sha256')
    .update(saleAdjustmentFingerprintPayload(lines, customerGroupId, adjustment))
    .digest('hex');
}

async function baseSaleQuote(context, input) {
  return quoteBasket({
    lines: input.lines,
    customerGroupId: input.customerGroupId,
    products: await loadCatalog(context.tenantId, context.storeLocation?.id),
    promotions: await loadPromotions(context.tenantId),
    at: input.at ? new Date(input.at) : new Date()
  });
}

async function voucherSaleQuote(context, input, quote) {
  const code=String(input.voucherCode??'').trim();
  if(!code)return quote;
  const voucher=await rpc('quote_voucher_v1',{
    p_tenant_id:context.tenantId,p_customer_id:input.customerId??null,p_outlet_id:context.outlet.id,
    p_code:code,p_basket_total:Number(quote.grandTotal)
  });
  return applyVoucher(quote,voucher);
}

async function verifySaleAuthorization(context, session, input) {
  const authorization = input.authorization;
  if (!authorization?.id || !authorization?.token || !authorization?.adjustment) {
    const error = new Error('Persetujuan supervisor tidak lengkap');
    error.status = 409;
    throw error;
  }
  const adjustment = normalizeSaleAdjustment(authorization.adjustment);
  const fingerprint = saleAdjustmentFingerprint(input.lines, input.customerGroupId, adjustment);
  const rows = await rest(
    'sale_adjustment_authorizations',
    `tenant_id=eq.${context.tenantId}&id=eq.${encodeURIComponent(authorization.id)}&select=*&limit=1`
  );
  const approval = rows[0];
  if (!approval || approval.approval_token_hash !== hashApprovalToken(authorization.token)) {
    const error = new Error('Kode persetujuan supervisor tidak valid');
    error.status = 409;
    throw error;
  }
  if (approval.outlet_id !== context.outlet.id || approval.cashier_id !== session.authUser.id) {
    const error = new Error('Persetujuan bukan untuk kasir atau outlet ini');
    error.status = 409;
    throw error;
  }
  if (approval.status !== 'APPROVED') {
    const error = new Error('Persetujuan sudah digunakan atau dibatalkan');
    error.status = 409;
    throw error;
  }
  if (new Date(approval.expires_at).getTime() <= Date.now()) {
    const error = new Error('Persetujuan sudah kedaluwarsa; minta supervisor menyetujui kembali');
    error.status = 409;
    throw error;
  }
  if (approval.basket_fingerprint !== fingerprint) {
    const error = new Error('Keranjang berubah setelah disetujui');
    error.status = 409;
    throw error;
  }
  const approvedBy = await profileFor(approval.approved_by);
  return { approval, adjustment, fingerprint, approvedBy: approvedBy?.display_name ?? 'Supervisor' };
}

function normalizeSalePayments(input,total) {
  const legacyMethod=String(input.paymentMethod??'Tunai').toLowerCase();
  const legacyCanonical=legacyMethod.startsWith('tunai')?'CASH':legacyMethod.startsWith('qris')?'QRIS':legacyMethod.startsWith('edc')?'EDC':'TRANSFER';
  const source=Array.isArray(input.payments)&&input.payments.length?input.payments:[{method:legacyCanonical,amount:total,tendered:total}];
  if(source.length>4)throw Object.assign(new Error('Maksimal empat metode pembayaran'),{status:400});
  const payments=source.map((payment)=>({
    method:String(payment.method??'').trim().toUpperCase(),amount:Number(payment.amount),
    tendered:payment.tendered==null?null:Number(payment.tendered),reference:String(payment.reference??'').trim()
  }));
  if(payments.some((payment)=>!['CASH','QRIS','TRANSFER','EDC','CREDIT'].includes(payment.method)||!(payment.amount>0)))throw Object.assign(new Error('Metode atau jumlah pembayaran tidak valid'),{status:400});
  const paid=payments.reduce((sum,payment)=>sum+payment.amount,0);
  if(Math.abs(paid-total)>0.01)throw Object.assign(new Error(`Total pembayaran ${paid} tidak sama dengan total transaksi ${total}`),{status:400});
  for(const payment of payments)if(payment.method==='CASH'){
    payment.tendered=payment.tendered??payment.amount;
    if(payment.tendered<payment.amount)throw Object.assign(new Error('Uang tunai diterima kurang dari bagian tunai'),{status:400});
  }
  return payments;
}

async function routeRequest(request, response, route) {
  if (request.method === 'GET' && route === 'health') {
    const config = env();
    return send(response, 200, { status: 'ok', version: '1.26.0-cloud', database: 'supabase', configured: Boolean(config.url && config.anon && config.service) });
  }

  if (request.method === 'POST' && route === 'login') {
    const input = bodyOf(request);
    const portal = String(input.portal ?? '').trim().toUpperCase();
    if (!['OWNER','STAFF'].includes(portal)) {
      const error = new Error('Pilih jalur login Owner atau Staff');
      error.status = 400;
      throw error;
    }
    const config = env();
    let auth = await supabase('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: input.email, password: input.password }, token: config.anon });
    let profile = await profileFor(auth.user.id);
    if (!profile && portal === 'OWNER' && process.env.ALLOW_OWNER_BOOTSTRAP === 'true') {
      await rpc('bootstrap_owner', { p_user_id: auth.user.id, p_display_name: auth.user.user_metadata?.display_name ?? input.email, p_business_name: process.env.DEFAULT_BUSINESS_NAME ?? 'Kasir Nusa' });
      profile = await profileFor(auth.user.id);
    }
    if (!profile) { const error = new Error('User Auth belum dihubungkan ke profil usaha'); error.status = 403; throw error; }
    if (!profile.active) {
      await supabase('/auth/v1/logout?scope=local', { method:'POST', token:auth.access_token }).catch(() => {});
      const error = new Error('Akun pengguna tidak aktif');
      error.status = 403;
      throw error;
    }
    const portalMatches = portal === 'OWNER' ? profile.role === 'OWNER' : profile.role !== 'OWNER';
    if (!portalMatches) {
      await supabase('/auth/v1/logout?scope=local', { method:'POST', token:auth.access_token }).catch(() => {});
      const error = new Error(portal === 'OWNER'
        ? 'Akun ini bukan akun Owner. Gunakan login Staff.'
        : 'Akun Owner harus masuk melalui login Owner.');
      error.status = 403;
      throw error;
    }
    setRefreshCookie(response, auth.refresh_token);
    return send(response, 200, authPayload(auth, profile));
  }

  if (request.method === 'POST' && route === 'refresh') {
    const input = bodyOf(request);
    const refreshToken = input.refreshToken ?? cookieValue(request, REFRESH_COOKIE);
    if (!refreshToken) { const error = new Error('Refresh token tidak tersedia'); error.status = 401; throw error; }
    const config = env();
    const auth = await supabase('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', body: { refresh_token: refreshToken }, token: config.anon
    });
    const profile = await profileFor(auth.user.id);
    if (!profile?.active) { const error = new Error('Profil pengguna tidak aktif'); error.status = 403; throw error; }
    setRefreshCookie(response, auth.refresh_token);
    return send(response, 200, authPayload(auth, profile));
  }

  if (request.method === 'POST' && route === 'logout') {
    const input = bodyOf(request);
    const refreshToken = input.refreshToken ?? cookieValue(request, REFRESH_COOKIE);
    let token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    let revoked = false;
    try {
      if (!token && refreshToken) {
        const config = env();
        const refreshed = await supabase('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', body: { refresh_token: refreshToken }, token: config.anon
        });
        token = refreshed.access_token;
      }
      if (token) {
        await supabase('/auth/v1/logout?scope=local', { method: 'POST', token });
        revoked = true;
      }
    } catch {
      // Logout lokal harus tetap selesai walau token sudah dicabut/kedaluwarsa
      // atau penyedia autentikasi sedang tidak dapat dijangkau.
    } finally {
      setRefreshCookie(response, null);
    }
    return send(response, 200, { success: true, revoked });
  }

  const session = await sessionOf(request);
  if (!session) { const error = new Error('Sesi tidak valid'); error.status = 401; throw error; }
  const context = await cloudContext(session, request);

  if (request.method === 'GET' && route === 'system/health') {
    requirePermission(session, 'identity.manage');
    return send(response, 200, await rpc('operational_health_check', {
      p_tenant_id: context.tenantId,
      p_actor_id: session.authUser.id
    }));
  }

  if (request.method === 'GET' && route === 'owner-contexts') {
    if (session.authenticatedProfile.role !== 'OWNER') {
      const error = new Error('Hanya Owner yang dapat mengganti konteks Owner');
      error.status = 403;
      throw error;
    }
    const owners = await rest(
      'profiles',
      `tenant_id=eq.${context.tenantId}&role=eq.OWNER&active=eq.true&select=user_id,display_name,created_at&order=display_name`
    );
    return send(response, 200, {
      authenticatedOwnerId: session.authenticatedUser.id,
      activeOwnerId: session.authUser.id,
      owners: owners.map((owner) => ({
        id: owner.user_id, displayName: owner.display_name,
        authenticated: owner.user_id === session.authenticatedUser.id,
        active: owner.user_id === session.authUser.id
      }))
    });
  }

  if (request.method === 'POST' && route === 'owner-contexts/switch') {
    if (session.authenticatedProfile.role !== 'OWNER') {
      const error = new Error('Hanya Owner yang dapat mengganti konteks Owner');
      error.status = 403;
      throw error;
    }
    const input = bodyOf(request);
    const targetOwnerId = String(input.ownerId ?? '').trim();
    const targetOwner = await profileFor(targetOwnerId);
    if (!targetOwner?.active || targetOwner.role !== 'OWNER' || targetOwner.tenant_id !== context.tenantId) {
      const error = new Error('Owner tujuan tidak aktif atau tidak berada dalam usaha yang sama');
      error.status = 422;
      throw error;
    }
    await rest('audit_logs','',{method:'POST',body:{
      tenant_id:context.tenantId,actor_id:session.authenticatedUser.id,
      action:'OWNER_CONTEXT_SWITCHED',entity_type:'profile',entity_id:targetOwnerId,
      details_json:{
        fromOwnerId:session.authUser.id,toOwnerId:targetOwnerId,
        authenticatedOwnerId:session.authenticatedUser.id
      }
    }});
    return send(response, 200, {
      contextId: targetOwnerId === session.authenticatedUser.id ? null : targetOwnerId,
      owner: { id:targetOwner.user_id, displayName:targetOwner.display_name, role:targetOwner.role }
    });
  }

  if (request.method === 'GET' && route === 'bootstrap') {
    const deviceId = request.headers['x-device-id'];
    const [products, promotions, customers, suppliers, shifts, tenants, devices] = await Promise.all([
      loadCatalog(context.tenantId, context.storeLocation?.id), loadPromotions(context.tenantId),
      loadCustomerAccounts(context.tenantId),
      session.permissions.includes('purchasing.receive') ? loadSupplierAccounts(context.tenantId) : [],
      rest('shifts', `tenant_id=eq.${context.tenantId}&outlet_id=eq.${context.outlet.id}&cashier_id=eq.${session.authUser.id}&status=eq.OPEN&select=*&limit=1`),
      rest('tenants', `id=eq.${context.tenantId}&select=*`),
      deviceId ? rest('pos_devices', `tenant_id=eq.${context.tenantId}&id=eq.${encodeURIComponent(deviceId)}&select=*&limit=1`) : []
    ]);
    return send(response, 200, {
      session: {
        token: session.token,
        user: { id: session.authUser.id, displayName: session.profile.display_name, role: session.profile.role, outletIds: context.outlets.map((item) => item.id) },
        authenticatedOwnerId: session.authenticatedProfile.role === 'OWNER' ? session.authenticatedUser.id : null,
        ownerContextActive: session.ownerContextActive,
        canSwitchOwners: session.authenticatedProfile.role === 'OWNER',
        permissions: session.permissions
      },
      outlets: context.outlets, activeOutletId: context.outlet.id, locations: context.locations,
      business: businessPayload(tenants[0]), deviceSettings: devicePayload(devices[0], deviceId),
      customerGroups: [{ id: 'retail', name: 'Eceran' }, { id: 'wholesale', name: 'Grosir' }], customers, suppliers, products, promotions,
      currentShift: await shiftDetail(context.tenantId, shifts[0]), syncCursor: new Date().toISOString()
    });
  }

  if (request.method === 'GET' && route === 'settings') {
    requirePermission(session, 'identity.manage');
    const [tenants, outlets, locations, devices] = await Promise.all([
      rest('tenants', `id=eq.${context.tenantId}&select=*`),
      rest('outlets', `tenant_id=eq.${context.tenantId}&select=*&order=active.desc,name`),
      rest('stock_locations', `tenant_id=eq.${context.tenantId}&select=*&order=active.desc,name`),
      rest('pos_devices', `tenant_id=eq.${context.tenantId}&select=*&order=active.desc,name`)
    ]);
    return send(response, 200, {
      business: businessPayload(tenants[0]), outlets, locations,
      devices: devices.map((device) => devicePayload(device))
    });
  }

  if (request.method === 'PUT' && route === 'settings/business') {
    requirePermission(session, 'identity.manage');
    const input = bodyOf(request);
    const row = await rpc('save_business_settings', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_name: input.name,
      p_legal_name: input.legalName ?? '', p_phone: input.phone ?? '', p_email: input.email ?? '',
      p_address: input.address ?? '', p_tax_id: input.taxId ?? '', p_receipt_footer: input.receiptFooter ?? '',
      p_logo_url: input.logoUrl ?? ''
    });
    return send(response, 200, { business: businessPayload(row) });
  }

  if (request.method === 'POST' && route === 'settings/outlets') {
    requirePermission(session, 'identity.manage');
    const input = bodyOf(request);
    const outlet = await rpc('save_outlet_settings', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_outlet_id: null,
      p_code: input.code, p_name: input.name, p_phone: input.phone ?? '', p_address: input.address ?? '',
      p_timezone: input.timezone ?? 'Asia/Makassar', p_receipt_prefix: input.receiptPrefix ?? input.code,
      p_receipt_footer: input.receiptFooter ?? '', p_active: input.active !== false
    });
    return send(response, 201, { outlet });
  }

  if (request.method === 'PUT' && /^settings\/outlets\/[^/]+$/.test(route)) {
    requirePermission(session, 'identity.manage');
    const input = bodyOf(request);
    const outlet = await rpc('save_outlet_settings', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_outlet_id: route.split('/')[2],
      p_code: input.code, p_name: input.name, p_phone: input.phone ?? '', p_address: input.address ?? '',
      p_timezone: input.timezone ?? 'Asia/Makassar', p_receipt_prefix: input.receiptPrefix ?? input.code,
      p_receipt_footer: input.receiptFooter ?? '', p_active: input.active !== false
    });
    return send(response, 200, { outlet });
  }

  if (request.method === 'POST' && route === 'settings/locations') {
    requirePermission(session, 'identity.manage');
    const input = bodyOf(request);
    const location = await rpc('save_stock_location_settings', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_location_id: null,
      p_outlet_id: input.outletId, p_code: input.code, p_name: input.name,
      p_kind: input.kind, p_active: input.active !== false
    });
    return send(response, 201, { location });
  }

  if (request.method === 'PUT' && /^settings\/locations\/[^/]+$/.test(route)) {
    requirePermission(session, 'identity.manage');
    const input = bodyOf(request);
    const location = await rpc('save_stock_location_settings', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_location_id: route.split('/')[2],
      p_outlet_id: input.outletId, p_code: input.code, p_name: input.name,
      p_kind: input.kind, p_active: input.active !== false
    });
    return send(response, 200, { location });
  }

  if (request.method === 'PUT' && route === 'settings/device') {
    requirePermission(session, 'identity.manage');
    const input = bodyOf(request);
    const device = await rpc('save_pos_device_settings', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_device_id: input.id,
      p_outlet_id: input.outletId, p_name: input.name, p_platform: input.platform ?? '',
      p_paper_width: Number(input.paperWidth ?? 80), p_auto_print: Boolean(input.autoPrint),
      p_receipt_copies: Number(input.receiptCopies ?? 1)
    });
    return send(response, 200, { device: devicePayload(device) });
  }

  if (request.method === 'GET' && route === 'users') {
    requirePermission(session, 'identity.manage');
    const config = env();
    const [profiles, assignments, authPage] = await Promise.all([
      rest('profiles', `tenant_id=eq.${context.tenantId}&select=*&order=created_at`),
      rest('user_outlets', `tenant_id=eq.${context.tenantId}&select=*`),
      supabase('/auth/v1/admin/users?page=1&per_page=1000', { token: config.service })
    ]);
    const authUsers = authPage?.users ?? [];
    return send(response, 200, { users: profiles.map((profile) => ({
      id: profile.user_id, email: authUsers.find((user) => user.id === profile.user_id)?.email ?? null,
      displayName: profile.display_name, role: profile.role, active: profile.active, createdAt: profile.created_at,
      outletIds: assignments.filter((item) => item.user_id === profile.user_id).map((item) => item.outlet_id)
    })), outlets: context.outlets });
  }

  if (request.method === 'POST' && route === 'users') {
    requirePermission(session, 'identity.manage');
    const input = bodyOf(request);
    if (!input.email || !input.password || input.password.length < 8) { const error = new Error('Email dan kata sandi minimal 8 karakter wajib diisi'); error.status = 400; throw error; }
    const config = env();
    const created = await supabase('/auth/v1/admin/users', { method: 'POST', token: config.service, body: {
      email: input.email.trim().toLowerCase(), password: input.password, email_confirm: true,
      user_metadata: { display_name: input.displayName }
    } });
    const authUser = created.user ?? created;
    try {
      const profile = await rpc('manage_profile_access', {
        p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_user_id: authUser.id,
        p_display_name: input.displayName, p_role: input.role, p_active: true, p_outlet_ids: input.outletIds ?? []
      });
      return send(response, 201, { ...profile, email: authUser.email });
    } catch (error) {
      await supabase(`/auth/v1/admin/users/${authUser.id}`, { method: 'DELETE', token: config.service }).catch(() => {});
      throw error;
    }
  }

  if (request.method === 'PATCH' && /^users\/[^/]+$/.test(route)) {
    requirePermission(session, 'identity.manage');
    const userId = route.split('/')[1];
    const input = bodyOf(request);
    const profile = await rpc('manage_profile_access', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_user_id: userId,
      p_display_name: input.displayName, p_role: input.role, p_active: input.active !== false, p_outlet_ids: input.outletIds ?? []
    });
    return send(response, 200, profile);
  }

  if (request.method === 'POST' && route === 'sale-authorizations') {
    requirePermission(session, 'pos.sell');
    if (!context.outlet?.id) { const error = new Error('Outlet aktif tidak ditemukan'); error.status = 409; throw error; }
    const input = bodyOf(request);
    if (!Array.isArray(input.lines) || !input.lines.length) { const error = new Error('Keranjang masih kosong'); error.status = 400; throw error; }
    const adjustment = normalizeSaleAdjustment(input.adjustment);
    const approverEmail = String(input.approverEmail ?? '').trim().toLowerCase();
    const approverPassword = String(input.approverPassword ?? '');
    let approverUserId = session.authUser.id;
    let approverProfile = ['OWNER','ADMIN'].includes(session.profile.role) ? session.profile : null;
    if (!approverProfile) {
      if (!approverEmail || !approverPassword) { const error = new Error('Email dan kata sandi Owner/Admin wajib diisi'); error.status = 400; throw error; }
      try {
        const config = env();
        const approverAuth = await supabase('/auth/v1/token?grant_type=password', {
          method: 'POST', body: { email: approverEmail, password: approverPassword }, token: config.anon
        });
        approverUserId = approverAuth.user.id;
        approverProfile = await profileFor(approverUserId);
      } catch {
        const error = new Error('Email atau kata sandi Owner/Admin salah');
        error.status = 422;
        throw error;
      }
    }
    if (!approverProfile?.active || approverProfile.tenant_id !== context.tenantId || !['OWNER','ADMIN'].includes(approverProfile.role)) {
      const error = new Error('Akun tersebut bukan Owner atau Admin aktif pada usaha ini');
      error.status = 403;
      throw error;
    }

    const fingerprint = saleAdjustmentFingerprint(input.lines, input.customerGroupId, adjustment);
    const token = randomBytes(32).toString('hex');
    const baseQuote = await baseSaleQuote(context, input);
    const preview = applySaleAdjustment(baseQuote, adjustment, { approvedBy: approverProfile.display_name });
    const approved = await rpc('create_sale_adjustment_authorization', {
      p_tenant_id: context.tenantId,
      p_outlet_id: context.outlet.id,
      p_cashier_id: session.authUser.id,
      p_approved_by: approverUserId,
      p_basket_fingerprint: fingerprint,
      p_approval_token_hash: hashApprovalToken(token),
      p_adjustment: adjustment,
      p_discount_amount: preview.manualAdjustment.discountAmount,
      p_valid_minutes: 5
    });
    const authorization = {
      id: approved.id,
      token,
      expiresAt: approved.expiresAt,
      approvedBy: approved.approvedBy,
      discountAmount: Number(approved.discountAmount),
      adjustment
    };
    const quote = applySaleAdjustment(baseQuote, adjustment, authorization);
    return send(response, 201, { authorization, quote });
  }

  if (request.method === 'POST' && route === 'quote') {
    requirePermission(session, 'pos.sell');
    const input = bodyOf(request);
    let quote = await baseSaleQuote(context, input);
    if (input.authorization) {
      const verified = await verifySaleAuthorization(context, session, input);
      quote = applySaleAdjustment(quote, verified.adjustment, {
        id: verified.approval.id,
        approvedBy: verified.approvedBy
      });
    }
    quote = await voucherSaleQuote(context,input,quote);
    return send(response, 200, quote);
  }

  if (request.method === 'POST' && route === 'sales') {
    requirePermission(session, 'pos.sell');
    const input = bodyOf(request);
    const key = request.headers['idempotency-key'];
    if (!key) { const error = new Error('Idempotency-Key wajib diisi'); error.status = 400; throw error; }
    let quote = await baseSaleQuote(context, { ...input, at: new Date().toISOString() });
    let verifiedAuthorization = null;
    if (input.authorization) {
      verifiedAuthorization = await verifySaleAuthorization(context, session, input);
      quote = applySaleAdjustment(quote, verifiedAuthorization.adjustment, {
        id: verifiedAuthorization.approval.id,
        approvedBy: verifiedAuthorization.approvedBy
      });
    }
    quote = await voucherSaleQuote(context,input,quote);
    const payments=normalizeSalePayments(input,quote.grandTotal);
    const saleCommand = {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_idempotency_key: key,
      p_outlet_id: context.outlet.id, p_shift_id: input.shiftId, p_customer_id: input.customerId ?? null,
      p_customer_group_id: input.customerGroupId, p_payments:payments, p_quote: quote,
      p_authorization_id: verifiedAuthorization?.approval.id ?? null,
      p_basket_fingerprint: verifiedAuthorization?.fingerprint ?? null,
      p_notes: String(input.notes ?? '').trim().slice(0,500),
      p_voucher_code:String(input.voucherCode??'').trim()||null
    };
    let result;
    try {
      result = await rpc('complete_sale_v7', saleCommand);
    } catch (error) {
      if (!isSaleReceiptCollision(error)) throw error;
      await repairSaleReceiptSequence(context);
      result = await rpc('complete_sale_v7', saleCommand);
    }
    const tenants = await rest('tenants', `id=eq.${context.tenantId}&select=*`);
    return send(response, 201, { ...result, occurredAt: new Date().toISOString(), cashier: session.profile.display_name, outletName:context.outlet.name, outlet:context.outlet, business:businessPayload(tenants[0]), quote });
  }

  if(request.method==='GET'&&route==='held-sales'){
    requirePermission(session,'pos.sell');
    const rows=await rest('parked_sales',`tenant_id=eq.${context.tenantId}&outlet_id=eq.${context.outlet.id}&status=eq.HELD&select=*&order=created_at.asc&limit=50`);
    return send(response,200,{holds:rows.map((row)=>({id:row.id,label:row.label,customerId:row.customer_id,customerGroupId:row.customer_group_id,notes:row.sale_notes??'',cart:row.cart_json,quote:row.quote_json,cashierId:row.cashier_id,createdAt:row.created_at}))});
  }

  if(request.method==='POST'&&route==='held-sales'){
    requirePermission(session,'pos.sell');
    const input=bodyOf(request);
    if(!Array.isArray(input.lines)||!input.lines.length){const error=new Error('Keranjang kosong');error.status=400;throw error;}
    const quote=quoteBasket({lines:input.lines,customerGroupId:input.customerGroupId,products:await loadCatalog(context.tenantId,context.storeLocation?.id),promotions:await loadPromotions(context.tenantId),at:new Date()});
    const rows=await rest('parked_sales','',{method:'POST',prefer:'return=representation',body:{
      tenant_id:context.tenantId,outlet_id:context.outlet.id,cashier_id:session.authUser.id,label:String(input.label??'').trim()||`Tahan ${new Date().toLocaleTimeString('id-ID')}`,
      customer_id:input.customerId??null,customer_group_id:input.customerGroupId??'retail',sale_notes:String(input.notes??'').trim().slice(0,500)||null,cart_json:input.lines,quote_json:quote,status:'HELD'
    }});
    return send(response,201,{id:rows[0].id,label:rows[0].label,quote});
  }

  if(request.method==='POST'&&/^held-sales\/[^/]+\/(resume|cancel)$/.test(route)){
    requirePermission(session,'pos.sell');
    const [,holdId,action]=route.split('/');
    const rows=await rest('parked_sales',`tenant_id=eq.${context.tenantId}&outlet_id=eq.${context.outlet.id}&id=eq.${holdId}&status=eq.HELD&select=*`);
    if(!rows[0]){const error=new Error('Transaksi tertahan tidak ditemukan atau sudah digunakan');error.status=404;throw error;}
    const status=action==='resume'?'RESUMED':'CANCELLED';
    await rest('parked_sales',`id=eq.${holdId}&tenant_id=eq.${context.tenantId}`,{method:'PATCH',body:{status,updated_at:new Date().toISOString(),...(status==='RESUMED'?{resumed_at:new Date().toISOString()}:{})}});
    return send(response,200,{id:holdId,status,cart:rows[0].cart_json,customerId:rows[0].customer_id,customerGroupId:rows[0].customer_group_id,notes:rows[0].sale_notes??''});
  }

  if (request.method === 'POST' && route === 'sync/sales') {
    requirePermission(session, 'pos.sell');
    const input = bodyOf(request);
    const commands = Array.isArray(input.commands) ? input.commands.slice(0, 20) : [];
    if (!input.device?.id || !commands.length) { const error = new Error('Perangkat dan antrean sinkronisasi wajib diisi'); error.status = 400; throw error; }
    const outletId = input.device.outletId ?? context.outlet?.id;
    if (!context.outlets.some((outlet) => outlet.id === outletId)) { const error = new Error('Perangkat tidak terhubung ke outlet user'); error.status = 403; throw error; }
    const [products, promotions] = await Promise.all([loadCatalog(context.tenantId, context.storeLocation?.id), loadPromotions(context.tenantId)]);
    const results = [];
    for (const command of commands) {
      try {
        if (!command.key || !command.occurredAt || !command.payload?.lines?.length) throw new Error('Format transaksi offline tidak lengkap');
        const at = new Date(command.occurredAt);
        if (!Number.isFinite(at.getTime())) throw new Error('Waktu transaksi offline tidak valid');
        const quote = quoteBasket({ lines: command.payload.lines, customerGroupId: command.payload.customerGroupId, products, promotions, at });
        const result = await rpc('process_sync_sale', {
          p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_device_id: input.device.id,
          p_outlet_id: outletId, p_device_name: input.device.name ?? 'Perangkat POS', p_platform: input.device.platform ?? null,
          p_idempotency_key: command.key, p_occurred_at: command.occurredAt, p_payload: command.payload,
          p_expected_total: Number(command.expectedTotal), p_quote: quote
        });
        if (result.status === 'APPLIED' && result.result?.id && command.payload?.notes) {
          await rest('sales', `tenant_id=eq.${context.tenantId}&id=eq.${encodeURIComponent(result.result.id)}`, {
            method:'PATCH',body:{notes:String(command.payload.notes).trim().slice(0,500)}
          });
        }
        results.push(result);
      } catch (error) {
        results.push({ key: command.key ?? null, status: 'FAILED', error: error.message });
      }
    }
    return send(response, 200, { deviceId: input.device.id, processed: results.length, results });
  }

  if (request.method === 'GET' && route === 'sync/review') {
    requirePermission(session, 'audit.view');
    const commands = await rest('sync_commands', `tenant_id=eq.${context.tenantId}&status=eq.NEEDS_REVIEW&select=*&order=received_at.asc&limit=100`);
    const actorIds = [...new Set(commands.map((command) => command.actor_id).filter(Boolean))];
    const outletIds = [...new Set(commands.map((command) => command.outlet_id).filter(Boolean))];
    const deviceIds = [...new Set(commands.map((command) => command.device_id).filter(Boolean))];
    const [actors, reviewOutlets, devices] = await Promise.all([
      actorIds.length ? rest('profiles', `tenant_id=eq.${context.tenantId}&user_id=${inFilter(actorIds)}&select=user_id,display_name`) : [],
      outletIds.length ? rest('outlets', `tenant_id=eq.${context.tenantId}&id=${inFilter(outletIds)}&select=id,name`) : [],
      deviceIds.length ? rest('pos_devices', `tenant_id=eq.${context.tenantId}&id=${inFilter(deviceIds)}&select=id,name,platform,active,last_seen_at`) : []
    ]);
    return send(response, 200, { commands: commands.map((command) => ({
      id: command.id, deviceId: command.device_id, actorId: command.actor_id, outletId: command.outlet_id,
      key: command.idempotency_key, occurredAt: command.occurred_at, receivedAt: command.received_at,
      status: command.status,
      cashierName: actors.find((actor) => actor.user_id === command.actor_id)?.display_name ?? 'Kasir',
      outletName: reviewOutlets.find((outlet) => outlet.id === command.outlet_id)?.name ?? 'Outlet',
      device: devices.find((device) => device.id === command.device_id) ?? { id: command.device_id, name: 'Perangkat POS' },
      paymentMethod: command.payload?.paymentMethod ?? 'Tunai',
      customerGroupId: command.payload?.customerGroupId ?? 'retail',
      expectedTotal: Number(command.result_json?.expectedTotal ?? 0),
      serverTotal: Number(command.result_json?.serverTotal ?? 0),
      difference: Number(command.result_json?.serverTotal ?? 0)-Number(command.result_json?.expectedTotal ?? 0),
      canHonorOffline: Boolean(command.payload?.offlineQuote?.lines?.length),
      lines: (command.payload?._serverQuote?.lines ?? command.payload?.offlineQuote?.lines ?? []).map((line) => ({
        productId: line.productId, productName: line.productName, unitName: line.unitName,
        qty: Number(line.qty), baseQty: Number(line.baseQty), gross: Number(line.gross), discount: Number(line.discount), total: Number(line.total)
      })),
      error: command.error_json?.message ?? null
    })) });
  }

  if (request.method === 'POST' && /^sync\/commands\/[^/]+\/(approve|apply-server|honor-offline|reject)$/.test(route)) {
    requirePermission(session, 'audit.view');
    if (!['OWNER','ADMIN'].includes(session.profile.role)) { const error = new Error('Hanya Owner atau Admin yang dapat memutuskan transaksi konflik'); error.status = 403; throw error; }
    const [, , commandId, action] = route.split('/');
    const actionMap = { approve: 'APPLY_SERVER', 'apply-server': 'APPLY_SERVER', 'honor-offline': 'HONOR_OFFLINE', reject: 'REJECT' };
    const result = await rpc('resolve_sync_sale', { p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_command_id: commandId, p_action: actionMap[action] });
    return send(response, 200, result);
  }

  if (request.method === 'POST' && route === 'products') {
    requirePermission(session, 'catalog.manage');
    const input = normalizeProductInput(bodyOf(request));
    return send(response, 201, await rpc('save_product_v2', { p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_product: input }));
  }

  if (request.method === 'GET' && route === 'products/manage') {
    requirePermission(session, 'catalog.manage');
    return send(response,200,{products:await loadManagedProducts(context.tenantId)});
  }

  if (request.method === 'PUT' && /^products\/[^/]+$/.test(route)) {
    requirePermission(session, 'catalog.manage');
    const productId=route.split('/')[1];
    const input=normalizeProductInput(bodyOf(request),productId);
    return send(response,200,await rpc('save_product_v2',{p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_product:input}));
  }

  if (request.method === 'POST' && /^products\/[^/]+\/status$/.test(route)) {
    requirePermission(session, 'catalog.manage');
    const productId=route.split('/')[1],input=bodyOf(request);
    return send(response,200,await rpc('set_product_active',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_product_id:productId,p_active:Boolean(input.active)
    }));
  }

  if (request.method === 'POST' && route === 'imports/preview') {
    requirePermission(session, 'audit.view');
    if (!['OWNER','ADMIN'].includes(session.profile.role)) { const error = new Error('Hanya Owner atau Admin yang dapat mengimpor data'); error.status = 403; throw error; }
    return send(response, 200, await previewImport(context, bodyOf(request)));
  }

  if (request.method === 'POST' && route === 'imports/commit') {
    requirePermission(session, 'audit.view');
    if (!['OWNER','ADMIN'].includes(session.profile.role)) { const error = new Error('Hanya Owner atau Admin yang dapat mengimpor data'); error.status = 403; throw error; }
    const input = bodyOf(request);
    const preview = await previewImport(context, input);
    if (!preview.valid) { const error = new Error(`Masih ada ${preview.errors.length} kesalahan pada data impor`); error.status = 400; throw error; }
    const key = request.headers['idempotency-key'] || input.idempotencyKey;
    if (!key) { const error = new Error('Identitas proses impor tidak tersedia'); error.status = 400; throw error; }
    const result = await rpc('import_initial_data', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_idempotency_key: key,
      p_kind: preview.kind, p_file_name: input.fileName ?? null, p_location_id: preview.locationId, p_rows: preview.rows
    });
    return send(response, 201, result);
  }

  if (request.method === 'GET' && route === 'imports') {
    requirePermission(session, 'audit.view');
    if (!['OWNER','ADMIN'].includes(session.profile.role)) { const error = new Error('Hanya Owner atau Admin yang dapat melihat impor data'); error.status = 403; throw error; }
    const jobs = await rest('import_jobs', `tenant_id=eq.${context.tenantId}&select=*&order=created_at.desc&limit=20`);
    return send(response, 200, { jobs });
  }

  if (request.method === 'POST' && route === 'backups/export') {
    requirePermission(session, 'identity.manage');
    const snapshot = await buildBackup(context, session);
    const rowCounts = Object.fromEntries(Object.entries(snapshot.tables).map(([table,rows]) => [table,rows.length]));
    const totalRows = Object.values(rowCounts).reduce((sum,count)=>sum+count,0);
    const stamp = snapshot.createdAt.replace(/\D/g,'').slice(0,14);
    const fileName = `kasir-nusa-backup-${stamp}.json`;
    await rest('backup_exports','',{method:'POST',body:{
      tenant_id:context.tenantId,actor_id:session.authUser.id,file_name:fileName,
      schema_version:snapshot.schemaVersion,checksum_sha256:snapshot.checksum,total_rows:totalRows,row_counts:rowCounts,status:'COMPLETED'
    }});
    await rest('audit_logs','',{method:'POST',body:{
      tenant_id:context.tenantId,actor_id:session.authUser.id,action:'BACKUP_EXPORTED',entity_type:'backup',
      details_json:{fileName,totalRows,checksum:snapshot.checksum}
    }});
    return send(response,200,{fileName,snapshot,totalRows,rowCounts});
  }

  if (request.method === 'POST' && route === 'backups/verify') {
    requirePermission(session, 'identity.manage');
    return send(response,200,verifyBackup(bodyOf(request).snapshot,context.tenantId));
  }

  if (request.method === 'GET' && route === 'backups') {
    requirePermission(session, 'identity.manage');
    const exports = await rest('backup_exports',`tenant_id=eq.${context.tenantId}&select=*&order=created_at.desc&limit=20`);
    return send(response,200,{exports});
  }

  if (request.method === 'GET' && route === 'promotions/manage') {
    requirePermission(session, 'promotion.manage');
    return send(response,200,{promotions:await loadPromotionManagement(context.tenantId)});
  }

  if (request.method === 'POST' && route === 'promotions/publish') {
    requirePermission(session, 'promotion.manage');
    const input = bodyOf(request);
    return send(response, 201, { ...(await rpc('publish_promotion_v2', { p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_rule: input })), code: input.code, name: input.name });
  }

  if (request.method === 'POST' && /^promotions\/[^/]+\/retire$/.test(route)) {
    requirePermission(session,'promotion.manage');
    const versionId=route.split('/')[1];
    return send(response,200,await rpc('retire_promotion_version',{p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_version_id:versionId}));
  }

  if (request.method === 'POST' && route === 'promotions/simulate') {
    requirePermission(session, 'promotion.manage');
    const input = bodyOf(request);
    const temporary = { id: '00000000-0000-4000-8000-000000000000', promotionId: 'simulation', version: 0, code: input.promo.code, name: input.promo.name, status: 'PUBLISHED', startsAt: new Date(Date.now()-60000).toISOString(), endsAt: new Date(Date.now()+60000).toISOString(), priority: 999, stackable: Boolean(input.promo.stackable), condition: input.promo.condition, reward: input.promo.reward };
    return send(response, 200, quoteBasket({ lines: input.lines, customerGroupId: input.customerGroupId??'retail', products: await loadCatalog(context.tenantId, context.storeLocation?.id), promotions: [temporary], at: new Date() }));
  }

  if (request.method === 'GET' && route === 'customers/accounts') {
    requirePermission(session,'pos.sell');
    return send(response,200,{customers:await loadCustomerAccounts(context.tenantId)});
  }

  if(request.method==='GET'&&route==='crm/dashboard'){
    requirePermission(session,'report.view');
    const tenant=encodeURIComponent(context.tenantId);
    const [customers,tiers,settings]=await Promise.all([
      rest('customers',`tenant_id=eq.${tenant}&active=eq.true&select=id,lifetime_spend,last_purchase_at,loyalty_points,tier_id,birth_date`),
      rest('customer_tiers',`tenant_id=eq.${tenant}&active=eq.true&select=*`),
      rest('loyalty_settings',`tenant_id=eq.${tenant}&select=*&limit=1`)
    ]);
    const inactivityDays=Number(settings[0]?.inactivity_days??90),cutoff=Date.now()-inactivityDays*86400000;
    const active=customers.filter((item)=>item.last_purchase_at&&new Date(item.last_purchase_at).getTime()>=cutoff).length;
    return send(response,200,{metrics:{customers:customers.length,active,inactive:customers.length-active,
      lifetimeValue:customers.reduce((sum,item)=>sum+Number(item.lifetime_spend??0),0),
      pointsOutstanding:customers.reduce((sum,item)=>sum+Number(item.loyalty_points??0),0)},
      tiers:tiers.map((tier)=>({...tier,memberCount:customers.filter((item)=>item.tier_id===tier.id).length}))});
  }

  if(request.method==='GET'&&route==='loyalty'){
    requirePermission(session,'promotion.manage');
    const tenant=encodeURIComponent(context.tenantId);
    const [settings,tiers,vouchers]=await Promise.all([
      rest('loyalty_settings',`tenant_id=eq.${tenant}&select=*&limit=1`),
      rest('customer_tiers',`tenant_id=eq.${tenant}&select=*&order=min_lifetime_spend.asc`),
      rest('vouchers',`tenant_id=eq.${tenant}&select=*&order=created_at.desc`)
    ]);
    return send(response,200,{settings:settings[0]??null,tiers,vouchers});
  }

  if(request.method==='PUT'&&route==='loyalty/settings'){
    requirePermission(session,'promotion.manage');
    const input=bodyOf(request);
    const rows=await rest('loyalty_settings',`tenant_id=eq.${encodeURIComponent(context.tenantId)}`,{
      method:'PATCH',prefer:'return=representation',body:{enabled:input.enabled!==false,
        earn_amount_per_point:Number(input.earnAmountPerPoint??10000),inactivity_days:Number(input.inactivityDays??90),updated_at:new Date().toISOString()}
    });
    return send(response,200,rows[0]);
  }

  if(request.method==='POST'&&route==='loyalty/tiers'){
    requirePermission(session,'promotion.manage');
    const input=bodyOf(request),payload={tenant_id:context.tenantId,code:String(input.code??'').trim().toUpperCase(),
      name:String(input.name??'').trim(),min_lifetime_spend:Number(input.minLifetimeSpend??0),
      points_multiplier:Number(input.pointsMultiplier??1),color:input.color??'#0f766e',active:input.active!==false};
    const rows=await rest('customer_tiers','on_conflict=tenant_id,code',{method:'POST',prefer:'resolution=merge-duplicates,return=representation',body:payload});
    return send(response,201,rows[0]);
  }

  if(request.method==='POST'&&route==='vouchers'){
    requirePermission(session,'promotion.manage');
    const input=bodyOf(request);
    const payload={tenant_id:context.tenantId,outlet_id:input.outletId||null,code:String(input.code??'').trim().toUpperCase(),
      name:String(input.name??'').trim(),discount_type:input.discountType,discount_value:Number(input.discountValue),
      max_discount:input.maxDiscount?Number(input.maxDiscount):null,min_purchase:Number(input.minPurchase??0),
      starts_at:input.startsAt,ends_at:input.endsAt,usage_limit_total:input.usageLimitTotal?Number(input.usageLimitTotal):null,
      usage_limit_per_customer:input.usageLimitPerCustomer?Number(input.usageLimitPerCustomer):null,
      segment:input.segment??'ALL',one_time:Boolean(input.oneTime),active:true,created_by:session.authUser.id};
    if(!payload.code||!payload.name){const error=new Error('Kode dan nama voucher wajib diisi');error.status=400;throw error;}
    const rows=await rest('vouchers','',{method:'POST',prefer:'return=representation',body:payload});
    return send(response,201,rows[0]);
  }

  if(request.method==='POST'&&/^vouchers\/[^/]+\/status$/.test(route)){
    requirePermission(session,'promotion.manage');
    const input=bodyOf(request),voucherId=route.split('/')[1];
    const rows=await rest('vouchers',`tenant_id=eq.${encodeURIComponent(context.tenantId)}&id=eq.${encodeURIComponent(voucherId)}`,{
      method:'PATCH',prefer:'return=representation',body:{active:Boolean(input.active)}
    });
    if(!rows[0]){const error=new Error('Voucher tidak ditemukan');error.status=404;throw error;}
    return send(response,200,rows[0]);
  }

  if(request.method==='GET'&&/^customers\/[^/]+\/loyalty$/.test(route)){
    requirePermission(session,'pos.sell');
    const customerId=route.split('/')[1],tenant=encodeURIComponent(context.tenantId);
    const entries=await rest('customer_point_entries',`tenant_id=eq.${tenant}&customer_id=eq.${encodeURIComponent(customerId)}&select=*&order=occurred_at.desc&limit=100`);
    return send(response,200,{entries});
  }

  if (request.method === 'GET' && route === 'customer-credit/aging') {
    requirePermission(session,'pos.sell');
    return send(response,200,await rpc('customer_credit_aging',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_as_of:new Date().toISOString().slice(0,10)
    }));
  }

  if (request.method === 'GET' && /^customers\/[^/]+\/statement$/.test(route)) {
    requirePermission(session,'pos.sell');
    const customerId=route.split('/')[1];
    const customers=await loadCustomerAccounts(context.tenantId);
    const customer=customers.find((item)=>item.id===customerId);
    if(!customer){const error=new Error('Pelanggan tidak ditemukan');error.status=404;throw error;}
    const [entries,sales,payments]=await Promise.all([
      rest('customer_account_entries',`tenant_id=eq.${context.tenantId}&customer_id=eq.${encodeURIComponent(customerId)}&select=*&order=occurred_at.desc&limit=200`),
      rest('sales',`tenant_id=eq.${context.tenantId}&customer_id=eq.${encodeURIComponent(customerId)}&credit_amount=gt.0&select=id,receipt_no,credit_amount,paid_credit_amount,returned_credit_amount,due_on,account_status,occurred_at&order=occurred_at.desc&limit=100`),
      rest('customer_payment_receipts',`tenant_id=eq.${context.tenantId}&customer_id=eq.${encodeURIComponent(customerId)}&select=*&order=occurred_at.desc&limit=100`)
    ]);
    const today=new Date().toISOString().slice(0,10);
    return send(response,200,{customer,entries:entries.map((entry)=>({...entry,amount:Number(entry.amount),balanceAfter:Number(entry.balance_after)})),
      invoices:sales.map((sale)=>({...sale,creditAmount:Number(sale.credit_amount),paidAmount:Number(sale.paid_credit_amount),returnedAmount:Number(sale.returned_credit_amount??0),outstanding:Math.max(0,Number(sale.credit_amount)-Number(sale.paid_credit_amount)-Number(sale.returned_credit_amount??0)),overdue:Boolean(sale.due_on&&sale.due_on<today&&Number(sale.credit_amount)>Number(sale.paid_credit_amount)+Number(sale.returned_credit_amount??0))})),
      payments:payments.map((payment)=>({...payment,amount:Number(payment.amount)}))});
  }

  if (request.method === 'POST' && route === 'customer-payments') {
    requirePermission(session,'pos.sell');
    const input=bodyOf(request),key=request.headers['idempotency-key'];
    if(!key){const error=new Error('Idempotency-Key wajib diisi');error.status=400;throw error;}
    const result=await rpc('record_customer_payment',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_idempotency_key:key,
      p_customer_id:input.customerId,p_outlet_id:context.outlet.id,p_shift_id:input.method==='CASH'?input.shiftId??null:null,
      p_amount:Number(input.amount),p_method:input.method,p_reference:input.reference??'',p_note:input.note??''
    });
    return send(response,result.duplicate?200:201,result);
  }

  if (request.method === 'POST' && route === 'customers') {
    requirePermission(session, 'pos.sell');
    const input = bodyOf(request);
    const customer=await rpc('save_customer_profile',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_customer_id:null,p_name:input.name,
      p_phone:input.phone??'',p_email:input.email??'',p_address:input.address??'',p_group_id:input.groupId==='wholesale'?'wholesale':'retail',
      p_credit_enabled:Boolean(input.creditEnabled),p_credit_limit:Number(input.creditLimit??0),p_credit_days:Number(input.creditDays??0),
      p_notes:input.notes??'',p_active:true
    });
    const crm=await rpc('save_customer_crm_profile_v1',{p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,
      p_customer_id:customer.id,p_birth_date:input.birthDate||null,p_whatsapp_consent:Boolean(input.whatsappConsent)});
    return send(response,201,crm);
  }

  if (request.method === 'PUT' && /^customers\/[^/]+$/.test(route)) {
    if(!['OWNER','ADMIN'].includes(session.profile.role)){const error=new Error('Hanya Owner atau Admin yang dapat mengubah pelanggan');error.status=403;throw error;}
    const input=bodyOf(request),customerId=route.split('/')[1];
    const customer=await rpc('save_customer_profile',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_customer_id:customerId,p_name:input.name,
      p_phone:input.phone??'',p_email:input.email??'',p_address:input.address??'',p_group_id:input.groupId==='wholesale'?'wholesale':'retail',
      p_credit_enabled:Boolean(input.creditEnabled),p_credit_limit:Number(input.creditLimit??0),p_credit_days:Number(input.creditDays??0),
      p_notes:input.notes??'',p_active:input.active!==false
    });
    const crm=await rpc('save_customer_crm_profile_v1',{p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,
      p_customer_id:customer.id,p_birth_date:input.birthDate||null,p_whatsapp_consent:Boolean(input.whatsappConsent)});
    return send(response,200,crm);
  }

  if (request.method === 'POST' && route === 'suppliers') {
    requirePermission(session, 'purchasing.receive');
    const input = bodyOf(request);
    const count = await rest('suppliers', `tenant_id=eq.${context.tenantId}&select=id`);
    const rows = await rest('suppliers', '', { method: 'POST', prefer: 'return=representation', body: { tenant_id: context.tenantId, code: `SUP-${String(count.length + 1).padStart(4,'0')}`, name: input.name, phone: input.phone || null, address: input.address || null } });
    return send(response, 201, rows[0]);
  }

  if(request.method==='GET'&&/^suppliers\/[^/]+\/statement$/.test(route)){
    requirePermission(session,'purchasing.view_cost');const supplierId=route.split('/')[1];
    const suppliers=await loadSupplierAccounts(context.tenantId),supplier=suppliers.find((item)=>item.id===supplierId);
    if(!supplier){const error=new Error('Supplier tidak ditemukan');error.status=404;throw error;}
    const [bills,entries]=await Promise.all([
      rest('supplier_bills',`tenant_id=eq.${context.tenantId}&supplier_id=eq.${encodeURIComponent(supplierId)}&select=*&order=due_on.asc,occurred_at.asc`),
      rest('supplier_payable_entries',`tenant_id=eq.${context.tenantId}&supplier_id=eq.${encodeURIComponent(supplierId)}&select=*&order=occurred_at.desc&limit=200`)
    ]);
    return send(response,200,{supplier,bills:bills.map((bill)=>({...bill,originalAmount:Number(bill.original_amount),returnCredit:Number(bill.return_credit_amount),paidAmount:Number(bill.paid_amount),outstanding:Math.max(0,Number(bill.original_amount)-Number(bill.return_credit_amount)-Number(bill.paid_amount))})),entries:entries.map((entry)=>({...entry,amount:Number(entry.amount)}))});
  }

  if(request.method==='POST'&&route==='supplier-payments'){
    requirePermission(session,'purchasing.receive');const input=bodyOf(request),key=request.headers['idempotency-key'];
    if(!key){const error=new Error('Idempotency-Key wajib diisi');error.status=400;throw error;}
    const result=await rpc('record_supplier_payment',{p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_idempotency_key:key,p_supplier_id:input.supplierId,p_outlet_id:context.outlet.id,p_shift_id:input.method==='CASH'?input.shiftId??null:null,p_amount:Number(input.amount),p_method:input.method,p_reference:input.reference??'',p_note:input.note??''});
    return send(response,result.duplicate?200:201,result);
  }

  if(request.method==='GET'&&route==='workforce/overview'){
    requirePermission(session,'workforce.self');
    const canManage=session.permissions.includes('workforce.manage');
    const tenant=encodeURIComponent(context.tenantId);
    const today=todayInTimeZone(new Date(),context.outlet.timezone??'Asia/Makassar');
    const monthStart=`${today.slice(0,7)}-01`;
    const monthEnd=new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7)),0)).toISOString().slice(0,10);
    const userFilter=canManage?'':`&user_id=eq.${encodeURIComponent(session.authUser.id)}`;
    const [profiles,schedules,attendance,targets,sales]=await Promise.all([
      rest('profiles',`tenant_id=eq.${tenant}&active=eq.true${canManage?'':`&user_id=eq.${encodeURIComponent(session.authUser.id)}`}&select=user_id,display_name,role&order=display_name`),
      rest('employee_schedules',`tenant_id=eq.${tenant}${userFilter}&work_date=gte.${monthStart}&work_date=lte.${monthEnd}&select=*&order=work_date,starts_at`),
      rest('attendance_records',`tenant_id=eq.${tenant}${userFilter}&work_date=gte.${monthStart}&work_date=lte.${monthEnd}&select=*&order=clock_in_at.desc`),
      rest('employee_targets',`tenant_id=eq.${tenant}${userFilter}&period_start=lte.${today}&period_end=gte.${today}&active=eq.true&select=*`),
      rest('sales',`tenant_id=eq.${tenant}${canManage?'':`&cashier_id=eq.${encodeURIComponent(session.authUser.id)}`}&occurred_at=gte.${monthStart}T00:00:00Z&occurred_at=lt.${new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7)),1)).toISOString()}&status=eq.COMPLETED&select=id,cashier_id,outlet_id,grand_total,occurred_at`)
    ]);
    const performance=profiles.map((profile)=>{
      const target=targets.find((item)=>item.user_id===profile.user_id);
      const employeeSales=sales.filter((sale)=>sale.cashier_id===profile.user_id&&(!target?.outlet_id||sale.outlet_id===target.outlet_id));
      const salesTotal=employeeSales.reduce((sum,sale)=>sum+Number(sale.grand_total),0);
      const commission=calculateEmployeeCommission({
        salesTotal,transactions:employeeSales.length,
        commissionType:target?.commission_type??'SALES_PERCENT',
        commissionValue:Number(target?.commission_value??0)
      });
      return {userId:profile.user_id,displayName:profile.display_name,role:profile.role,target,salesTotal,transactions:employeeSales.length,commission};
    });
    return send(response,200,{
      canManage,today,profiles,outlets:context.outlets,schedules,attendance,targets,performance,
      activeAttendance:attendance.find((item)=>item.user_id===session.authUser.id&&!item.clock_out_at)??null
    });
  }

  if(request.method==='POST'&&route==='workforce/schedules'){
    requirePermission(session,'workforce.manage');
    const input=bodyOf(request),deviceId=request.headers['x-device-id']||null;
    const employee=await profileFor(input.userId);
    if(!employee?.active||employee.tenant_id!==context.tenantId)throw Object.assign(new Error('Karyawan aktif tidak ditemukan'),{status:404});
    if(!context.outlets.some((outlet)=>outlet.id===input.outletId))throw Object.assign(new Error('Outlet tidak dapat diakses'),{status:403});
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(input.workDate??''))||!/^\d{2}:\d{2}$/.test(String(input.startsAt??''))||!/^\d{2}:\d{2}$/.test(String(input.endsAt??''))){
      throw Object.assign(new Error('Tanggal dan jam jadwal tidak valid'),{status:400});
    }
    const rows=await rest('employee_schedules','',{method:'POST',prefer:'return=representation',body:{
      tenant_id:context.tenantId,user_id:input.userId,outlet_id:input.outletId,work_date:input.workDate,
      starts_at:input.startsAt,ends_at:input.endsAt,note:String(input.note??'').trim().slice(0,240)||null,
      created_by:session.authUser.id
    }});
    await rest('audit_logs','',{method:'POST',body:{tenant_id:context.tenantId,actor_id:session.authUser.id,
      action:'EMPLOYEE_SCHEDULE_CREATED',entity_type:'employee_schedule',entity_id:rows[0].id,
      details_json:{userId:input.userId,outletId:input.outletId,workDate:input.workDate,deviceId}}});
    return send(response,201,rows[0]);
  }

  if(request.method==='POST'&&route==='workforce/attendance'){
    requirePermission(session,'workforce.self');
    const input=bodyOf(request);
    const result=await rpc('clock_employee_attendance',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_outlet_id:context.outlet.id,
      p_device_id:request.headers['x-device-id']||null,p_action:input.action,p_note:String(input.note??'').trim().slice(0,240)
    });
    return send(response,200,result);
  }

  if(request.method==='POST'&&route==='workforce/targets'){
    requirePermission(session,'workforce.manage');
    const input=bodyOf(request),employee=await profileFor(input.userId),deviceId=request.headers['x-device-id']||null;
    if(!employee?.active||employee.tenant_id!==context.tenantId)throw Object.assign(new Error('Karyawan aktif tidak ditemukan'),{status:404});
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(input.periodStart??''))||!/^\d{4}-\d{2}-\d{2}$/.test(String(input.periodEnd??''))||input.periodEnd<input.periodStart){
      throw Object.assign(new Error('Periode target tidak valid'),{status:400});
    }
    if(input.outletId&&!context.outlets.some((outlet)=>outlet.id===input.outletId))throw Object.assign(new Error('Outlet tidak dapat diakses'),{status:403});
    const commissionType=input.commissionType==='FIXED_PER_TRANSACTION'?'FIXED_PER_TRANSACTION':'SALES_PERCENT';
    const commissionValue=moneyInput(input.commissionValue,'Nilai komisi',{allowZero:true});
    calculateEmployeeCommission({commissionType,commissionValue,salesTotal:0,transactions:0});
    const row={tenant_id:context.tenantId,user_id:input.userId,outlet_id:input.outletId||null,
      period_start:input.periodStart,period_end:input.periodEnd,
      sales_target:moneyInput(input.salesTarget,'Target penjualan',{allowZero:true}),
      transaction_target:Math.max(0,Math.trunc(Number(input.transactionTarget)||0)),
      commission_type:commissionType,commission_value:commissionValue,
      active:true,created_by:session.authUser.id,updated_at:new Date().toISOString()};
    const outletFilter=row.outlet_id?`outlet_id=eq.${encodeURIComponent(row.outlet_id)}`:'outlet_id=is.null';
    const matches=await rest('employee_targets',
      `tenant_id=eq.${context.tenantId}&user_id=eq.${encodeURIComponent(input.userId)}&${outletFilter}&period_start=eq.${input.periodStart}&period_end=eq.${input.periodEnd}&select=id&limit=1`);
    const rows=matches[0]
      ?await rest('employee_targets',`id=eq.${matches[0].id}`,{
        method:'PATCH',prefer:'return=representation',body:{
          sales_target:row.sales_target,transaction_target:row.transaction_target,
          commission_type:row.commission_type,commission_value:row.commission_value,
          active:true,updated_at:row.updated_at
        }
      })
      :await rest('employee_targets','',{method:'POST',prefer:'return=representation',body:row});
    await rest('audit_logs','',{method:'POST',body:{tenant_id:context.tenantId,actor_id:session.authUser.id,
      action:'EMPLOYEE_TARGET_SAVED',entity_type:'employee_target',entity_id:rows[0].id,
      details_json:{userId:input.userId,periodStart:input.periodStart,periodEnd:input.periodEnd,deviceId}}});
    return send(response,200,rows[0]);
  }

  if(request.method==='GET'&&route==='approvals'){
    requirePermission(session,'workforce.self');
    const canManage=session.permissions.includes('approval.manage');
    const requests=await rest('approval_requests',`tenant_id=eq.${context.tenantId}${canManage?'':`&requester_id=eq.${encodeURIComponent(session.authUser.id)}`}&select=*&order=requested_at.desc&limit=100`);
    const policies=canManage?await rest('approval_policies',`tenant_id=eq.${context.tenantId}&select=*&order=action_type,minimum_amount`):[];
    const actorIds=[...new Set(requests.flatMap((item)=>[item.requester_id,...(item.decisions_json??[]).map((decision)=>decision.actorId)].filter(Boolean)))];
    const actors=actorIds.length?await rest('profiles',`tenant_id=eq.${context.tenantId}&user_id=${inFilter(actorIds)}&select=user_id,display_name,role`):[];
    return send(response,200,{canManage,requests,policies,actors});
  }

  if(request.method==='POST'&&route==='approvals/requests'){
    requirePermission(session,'workforce.self');
    const input=bodyOf(request),action=String(input.actionType??'').toUpperCase(),deviceId=request.headers['x-device-id']||null;
    if(!['DISCOUNT','VOID','PURCHASE','STOCK_COUNT'].includes(action))throw Object.assign(new Error('Jenis persetujuan tidak valid'),{status:400});
    const reason=String(input.reason??'').trim();
    if(reason.length<5)throw Object.assign(new Error('Alasan minimal 5 karakter'),{status:400});
    const amount=moneyInput(input.amount,'Nilai permintaan',{allowZero:true});
    const policies=await rest('approval_policies',`tenant_id=eq.${context.tenantId}&action_type=eq.${action}&active=eq.true&minimum_amount=lte.${amount}&select=*&order=minimum_amount.desc&limit=1`);
    const rows=await rest('approval_requests','',{method:'POST',prefer:'return=representation',body:{
      tenant_id:context.tenantId,outlet_id:context.outlet.id,requester_id:session.authUser.id,
      action_type:action,entity_type:String(input.entityType??'').trim()||null,
      entity_id:input.entityId||null,amount,reason,required_levels:Number(policies[0]?.required_levels??1)
    }});
    await rest('audit_logs','',{method:'POST',body:{tenant_id:context.tenantId,actor_id:session.authUser.id,
      action:'APPROVAL_REQUESTED',entity_type:'approval_request',entity_id:rows[0].id,
      details_json:{actionType:action,amount,requiredLevels:Number(policies[0]?.required_levels??1),deviceId}}});
    return send(response,201,rows[0]);
  }

  if(request.method==='POST'&&/^approvals\/[^/]+\/decision$/.test(route)){
    requirePermission(session,'approval.manage');
    const input=bodyOf(request),requestId=route.split('/')[1];
    return send(response,200,await rpc('decide_approval_request',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_request_id:requestId,
      p_decision:input.decision,p_note:String(input.note??'').trim().slice(0,240)
    }));
  }

  if(request.method==='POST'&&route==='approvals/policies'){
    requirePermission(session,'approval.manage');
    const input=bodyOf(request),action=String(input.actionType??'').toUpperCase();
    if(!['DISCOUNT','VOID','PURCHASE','STOCK_COUNT'].includes(action))throw Object.assign(new Error('Jenis kebijakan tidak valid'),{status:400});
    const row={tenant_id:context.tenantId,action_type:action,
      minimum_amount:moneyInput(input.minimumAmount,'Batas nilai',{allowZero:true}),
      required_levels:Math.max(1,Math.min(2,Math.trunc(Number(input.requiredLevels)||1))),
      active:true,updated_by:session.authUser.id,updated_at:new Date().toISOString()};
    const rows=await rest('approval_policies','on_conflict=tenant_id,action_type,minimum_amount',{
      method:'POST',prefer:'resolution=merge-duplicates,return=representation',body:row
    });
    return send(response,200,rows[0]);
  }

  if(request.method==='GET'&&route==='workforce/activity'){
    requirePermission(session,'workforce.manage');
    const logs=await rest('audit_logs',`tenant_id=eq.${context.tenantId}&select=*&order=occurred_at.desc&limit=200`);
    const actorIds=[...new Set(logs.map((item)=>item.actor_id).filter(Boolean))];
    const actors=actorIds.length?await rest('profiles',`tenant_id=eq.${context.tenantId}&user_id=${inFilter(actorIds)}&select=user_id,display_name,role`):[];
    return send(response,200,{logs:logs.map((log)=>({...log,actor:actors.find((actor)=>actor.user_id===log.actor_id)??null}))});
  }

  if(request.method==='GET'&&route==='workforce/reconciliations'){
    requirePermission(session,'workforce.manage');
    const shifts=await rest('shifts',`tenant_id=eq.${context.tenantId}&outlet_id=${inFilter(context.outlets.map((outlet)=>outlet.id))}&status=eq.CLOSED&select=*&order=closed_at.desc&limit=50`);
    const ids=shifts.map((shift)=>shift.id);
    const [rows,cashiers]=ids.length?await Promise.all([
      rest('shift_reconciliations',`tenant_id=eq.${context.tenantId}&shift_id=${inFilter(ids)}&select=*&order=reconciled_at.desc`),
      rest('profiles',`tenant_id=eq.${context.tenantId}&user_id=${inFilter([...new Set(shifts.map((shift)=>shift.cashier_id))])}&select=user_id,display_name`)
    ]):[[],[]];
    return send(response,200,{shifts:shifts.map((shift)=>({...shift,cashierName:cashiers.find((item)=>item.user_id===shift.cashier_id)?.display_name??'Karyawan',
      methods:rows.filter((row)=>row.shift_id===shift.id)}))});
  }

  if (request.method === 'POST' && route === 'shifts/open') {
    requirePermission(session, 'pos.sell');
    const input = bodyOf(request);
    const openingCash = moneyInput(input.openingCash, 'Modal awal', { allowZero: true });
    const existing = await rest('shifts', `tenant_id=eq.${context.tenantId}&outlet_id=eq.${context.outlet.id}&cashier_id=eq.${session.authUser.id}&status=eq.OPEN&select=*&limit=1`);
    if (existing[0]) return send(response, 200, existing[0]);
    const rows = await rest('shifts', '', { method: 'POST', prefer: 'return=representation', body: { tenant_id: context.tenantId, outlet_id: context.outlet.id, cashier_id: session.authUser.id, opening_cash: openingCash, status: 'OPEN' } });
    return send(response, 201, rows[0]);
  }

  if (request.method === 'GET' && route === 'shifts/current') {
    requirePermission(session, 'pos.sell');
    const shifts = await rest('shifts', `tenant_id=eq.${context.tenantId}&outlet_id=eq.${context.outlet.id}&cashier_id=eq.${session.authUser.id}&status=eq.OPEN&select=*&limit=1`);
    return send(response, 200, { shift: await shiftDetail(context.tenantId, shifts[0]) });
  }

  if (request.method === 'POST' && route === 'shifts/cash-movement') {
    requirePermission(session, 'pos.sell');
    const input = bodyOf(request);
    const movementType = String(input.movementType ?? '').toUpperCase();
    if (!['CASH_IN','CASH_OUT'].includes(movementType)) { const error = new Error('Jenis pergerakan kas tidak valid'); error.status = 400; throw error; }
    const amount = moneyInput(input.amount, 'Jumlah kas');
    const shifts = await rest('shifts', `tenant_id=eq.${context.tenantId}&outlet_id=eq.${context.outlet.id}&cashier_id=eq.${session.authUser.id}&id=eq.${encodeURIComponent(input.shiftId ?? '')}&status=eq.OPEN&select=id&limit=1`);
    if (!shifts[0]) { const error = new Error('Shift aktif milik pengguna ini tidak ditemukan'); error.status = 404; throw error; }
    const rows = await rest('cash_movements', '', { method: 'POST', prefer: 'return=representation', body: { tenant_id: context.tenantId, shift_id: shifts[0].id, movement_type: movementType, amount, note: String(input.note ?? '').trim().slice(0, 240) || null, actor_id: session.authUser.id } });
    return send(response, 201, rows[0]);
  }

  if (request.method === 'POST' && route === 'shifts/close') {
    requirePermission(session, 'pos.sell');
    const input = bodyOf(request);
    const declarations=Array.isArray(input.declarations)&&input.declarations.length
      ?input.declarations.map((item)=>({method:String(item.method??'').trim().toUpperCase().replace(/^TUNAI$/,'CASH'),declaredAmount:moneyInput(item.declaredAmount,'Jumlah rekonsiliasi',{allowZero:true})}))
      :[{method:'CASH',declaredAmount:moneyInput(input.closingCash,'Kas fisik',{allowZero:true})}];
    if(declarations.some((item)=>!item.method)||new Set(declarations.map((item)=>item.method)).size!==declarations.length){
      throw Object.assign(new Error('Metode rekonsiliasi kosong atau ganda'),{status:400});
    }
    return send(response,200,await rpc('close_shift_with_reconciliation',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_shift_id:input.shiftId,p_declarations:declarations
    }));
  }

  if (request.method === 'GET' && route === 'inventory') {
    requirePermission(session, 'inventory.manage');
    const [balances, ledger] = await Promise.all([
      rest('stock_balances', `tenant_id=eq.${context.tenantId}&location_id=${inFilter(context.locationIds)}&select=*&order=location_id`),
      rest('stock_ledger', `tenant_id=eq.${context.tenantId}&location_id=${inFilter(context.locationIds)}&select=*&order=occurred_at.desc&limit=50`)
    ]);
    return send(response, 200, { balances, ledger });
  }

  if (request.method === 'GET' && route === 'expiry-dashboard') {
    requirePermission(session, 'inventory.manage');
    const [batches, products] = await Promise.all([
      rest('inventory_batches', `tenant_id=eq.${context.tenantId}&location_id=${inFilter(context.locationIds)}&available_qty=gt.0&select=*&order=expires_on.asc.nullslast,received_at.asc`),
      rest('products', `tenant_id=eq.${context.tenantId}&select=id,sku,name,brand`)
    ]);
    const dashboard = summarizeExpiryBatches({
      rows: batches,
      products,
      locations: context.locations,
      today: todayInTimeZone(new Date(), 'Asia/Makassar')
    });
    return send(response, 200, dashboard);
  }

  if (request.method === 'POST' && route === 'transfers') {
    requirePermission(session, 'inventory.manage');
    const input = bodyOf(request);
    const key = request.headers['idempotency-key'];
    if (!key) { const error = new Error('Idempotency-Key wajib diisi'); error.status = 400; throw error; }
    requireLocationAccess(context, input.fromLocationId); requireLocationAccess(context, input.toLocationId);
    const result = await rpc('post_stock_transfer', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_idempotency_key: key,
      p_from_location_id: input.fromLocationId, p_to_location_id: input.toLocationId, p_items: input.items
    });
    return send(response, result.duplicate ? 200 : 201, result);
  }

  if (request.method === 'POST' && route === 'stock-counts') {
    requirePermission(session, 'inventory.manage');
    const input = bodyOf(request);
    const key = request.headers['idempotency-key'];
    if (!key) { const error = new Error('Idempotency-Key wajib diisi'); error.status = 400; throw error; }
    requireLocationAccess(context, input.locationId);
    const result = await rpc('post_stock_count', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_idempotency_key: key,
      p_location_id: input.locationId, p_items: input.items
    });
    return send(response, result.duplicate ? 200 : 201, result);
  }

  if (request.method === 'POST' && route === 'returns') {
    requirePermission(session, 'sales.return');
    const input = bodyOf(request);
    const key = request.headers['idempotency-key'];
    if (!key) { const error = new Error('Idempotency-Key wajib diisi'); error.status = 400; throw error; }
    const accessibleSale = await rest('sales', `tenant_id=eq.${context.tenantId}&id=eq.${encodeURIComponent(input.saleId)}&outlet_id=${inFilter(context.outlets.map((outlet) => outlet.id))}&select=id&limit=1`);
    if (!accessibleSale[0]) { const error = new Error('Transaksi penjualan tidak ditemukan pada outlet user'); error.status = 404; throw error; }
    const result = await rpc('process_customer_return_v3', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_idempotency_key: key,
      p_sale_id: input.saleId, p_reason: input.reason, p_refund_method: input.refundMethod ?? 'ORIGINAL',
      p_refund_reference: input.refundReference ?? null, p_refund_shift_id: input.refundShiftId ?? null, p_items: input.items
    });
    return send(response, result.duplicate ? 200 : 201, result);
  }

  if (request.method === 'GET' && route === 'returns/recent') {
    requirePermission(session, 'sales.return');
    const candidates = await rest('customer_returns', `tenant_id=eq.${context.tenantId}&status=eq.COMPLETED&select=*&order=occurred_at.desc&limit=100`);
    if (!candidates.length) return send(response, 200, { returns: [] });
    const sales = await rest('sales', `tenant_id=eq.${context.tenantId}&id=${inFilter([...new Set(candidates.map((item)=>item.sale_id))])}&outlet_id=${inFilter(context.outlets.map((outlet) => outlet.id))}&select=id,receipt_no`);
    if (!sales.length) return send(response, 200, { returns: [] });
    const saleById = new Map(sales.map((sale) => [sale.id,sale]));
    const returned = candidates.filter((item)=>saleById.has(item.sale_id)).slice(0,50);
    if (!returned.length) return send(response, 200, { returns: [] });
    const actorIds = [...new Set(returned.map((item) => item.actor_id))];
    const [items,actors] = await Promise.all([
      rest('customer_return_items', `tenant_id=eq.${context.tenantId}&return_id=${inFilter(returned.map((item) => item.id))}&select=return_id,base_qty,item_condition,restockable`),
      rest('profiles', `tenant_id=eq.${context.tenantId}&user_id=${inFilter(actorIds)}&select=user_id,display_name`)
    ]);
    return send(response, 200, { returns: returned.map((item) => ({
      id:item.id,returnNo:item.return_no,receiptNo:saleById.get(item.sale_id)?.receipt_no ?? '-',reason:item.reason,
      total:Number(item.total),refundMethod:item.refund_method,refundReference:item.refund_reference,
      actorName:actors.find((actor)=>actor.user_id===item.actor_id)?.display_name ?? 'Pengguna',occurredAt:item.occurred_at,
      itemCount:items.filter((line)=>line.return_id===item.id).length,
      restockedQty:items.filter((line)=>line.return_id===item.id && line.restockable!==false).reduce((sum,line)=>sum+Number(line.base_qty),0),
      damagedQty:items.filter((line)=>line.return_id===item.id && line.restockable===false).reduce((sum,line)=>sum+Number(line.base_qty),0)
    })) });
  }

  if(request.method==='GET'&&route==='purchase-returns/lookup'){
    requirePermission(session,'purchasing.view_cost');
    const documentNo=queryValue(request,'documentNo');
    const supplierId=queryValue(request,'supplierId');
    if(!documentNo?.trim()){const error=new Error('Nomor faktur pembelian wajib diisi');error.status=400;throw error;}
    const receipt=await loadReturnablePurchase(context,{documentNo,supplierId});
    if(!receipt){const error=new Error('Faktur penerimaan tidak ditemukan pada lokasi yang dapat diakses');error.status=404;throw error;}
    return send(response,200,{receipt});
  }

  if(request.method==='POST'&&route==='purchase-returns'){
    requirePermission(session,'purchasing.receive');
    const input=bodyOf(request),key=request.headers['idempotency-key'];
    if(!key){const error=new Error('Idempotency-Key wajib diisi');error.status=400;throw error;}
    const receipt=await loadReturnablePurchase(context,{receiptId:input.receiptId});
    if(!receipt){const error=new Error('Penerimaan pembelian tidak ditemukan pada lokasi yang dapat diakses');error.status=404;throw error;}
    const allowed=new Map(receipt.lines.map((line)=>[line.receiptItemId,line]));
    for(const item of input.items??[]){
      const line=allowed.get(item.receiptItemId);
      if(!line||Number(item.baseQty)>line.maxReturnQty){const error=new Error(`Jumlah retur ${line?.productName??'barang'} melebihi stok batch yang tersedia`);error.status=400;throw error;}
    }
    const result=await rpc('post_supplier_return',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_idempotency_key:key,p_receipt_id:input.receiptId,
      p_reason:input.reason,p_settlement_type:input.settlementType,p_supplier_reference:input.supplierReference??'',p_items:input.items
    });
    return send(response,result.duplicate?200:201,result);
  }

  if(request.method==='GET'&&route==='purchase-returns/recent'){
    requirePermission(session,'purchasing.view_cost');
    const docs=await rest('supplier_returns',`tenant_id=eq.${context.tenantId}&location_id=${inFilter(context.locationIds)}&status=eq.POSTED&select=*&order=occurred_at.desc&limit=50`);
    if(!docs.length)return send(response,200,{returns:[]});
    const [items,receipts]=await Promise.all([
      rest('supplier_return_items',`tenant_id=eq.${context.tenantId}&return_id=${inFilter(docs.map((item)=>item.id))}&select=return_id,base_qty`),
      rest('purchase_receipts',`tenant_id=eq.${context.tenantId}&id=${inFilter([...new Set(docs.map((item)=>item.receipt_id))])}&select=id,document_no`)
    ]);
    return send(response,200,{returns:docs.map((doc)=>({
      id:doc.id,returnNo:doc.return_no,documentNo:receipts.find((item)=>item.id===doc.receipt_id)?.document_no??'-',supplierName:doc.supplier_name,reason:doc.reason,
      settlementType:doc.settlement_type,supplierReference:doc.supplier_reference,totalCredit:Number(doc.total_credit),
      occurredAt:doc.occurred_at,itemCount:items.filter((item)=>item.return_id===doc.id).length,
      totalQty:items.filter((item)=>item.return_id===doc.id).reduce((sum,item)=>sum+Number(item.base_qty),0)
    }))});
  }

  if (request.method === 'GET' && route === 'purchase-orders') {
    requirePermission(session, 'purchasing.view_cost');
    return send(response, 200, { orders: await loadPurchaseOrders(context.tenantId, null, context.locationIds) });
  }

  if (request.method === 'GET' && route === 'restock-planning') {
    requirePermission(session, 'purchasing.view_cost');
    const locationId = queryValue(request, 'locationId') ?? context.storeLocation?.id ?? context.locationIds[0];
    requireLocationAccess(context, locationId);
    const supplierId = queryValue(request, 'supplierId');
    const lookback = queryValue(request, 'lookbackDays');
    const result = await rpc('get_restock_recommendations_v1', {
      p_tenant_id: context.tenantId, p_location_id: locationId,
      p_supplier_id: supplierId || null, p_lookback_days: lookback ? Number(lookback) : null
    });
    return send(response, 200, result);
  }

  if (request.method === 'PUT' && route === 'restock-planning/settings') {
    if (!['OWNER','ADMIN'].includes(session.profile.role)) {
      const error = new Error('Hanya Owner/Admin yang dapat mengubah batas persetujuan pembelian');
      error.status = 403;
      throw error;
    }
    const input = bodyOf(request);
    const result = await rpc('save_purchase_planning_settings_v1', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id,
      p_approval_threshold: moneyInput(input.approvalThreshold, 'Batas persetujuan', { allowZero: true }),
      p_lookback_days: Number(input.lookbackDays)
    });
    return send(response, 200, result);
  }

  if (request.method === 'PUT' && route === 'restock-planning/policy') {
    requirePermission(session, 'purchasing.receive');
    const input = bodyOf(request);
    requireLocationAccess(context, input.locationId);
    const result = await rpc('save_restock_policy_v1', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id,
      p_location_id: input.locationId, p_product_id: input.productId, p_supplier_id: input.supplierId,
      p_minimum_stock: Number(input.minimumStock ?? 0), p_maximum_stock: Number(input.maximumStock ?? 0),
      p_safety_stock: Number(input.safetyStock ?? 0), p_lead_time_days: Number(input.leadTimeDays ?? 7),
      p_preferred: input.preferred !== false
    });
    return send(response, 200, result);
  }

  if (request.method === 'POST' && route === 'restock-planning/draft') {
    requirePermission(session, 'purchasing.receive');
    const input = bodyOf(request);
    requireLocationAccess(context, input.locationId);
    if (!Array.isArray(input.items) || !input.items.length) {
      const error = new Error('Pilih minimal satu rekomendasi restok');
      error.status = 400;
      throw error;
    }
    const items = input.items.map((item) => {
      const qty = Number(item.baseQty);
      const cost = Number(item.unitCost ?? 0);
      if (!(qty > 0) || !(cost >= 0)) {
        const error = new Error('Jumlah atau estimasi modal rekomendasi tidak valid');
        error.status = 400;
        throw error;
      }
      return { productId: item.productId, baseQty: qty, unitCost: cost, lineDiscount: 0 };
    });
    const result = await rpc('create_restock_purchase_order_v1', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id,
      p_supplier_id: input.supplierId, p_location_id: input.locationId,
      p_expected_on: input.expectedOn ?? null,
      p_notes: input.notes ?? 'Draft otomatis dari rekomendasi restok', p_items: items
    });
    return send(response, 201, result);
  }

  if (request.method === 'GET' && /^purchase-orders\/[^/]+$/.test(route)) {
    requirePermission(session, 'purchasing.view_cost');
    const orderId = route.split('/')[1];
    const order = (await loadPurchaseOrders(context.tenantId, orderId, context.locationIds))[0];
    if (!order) { const error = new Error('Purchase Order tidak ditemukan'); error.status = 404; throw error; }
    return send(response, 200, { order });
  }

  if (request.method === 'POST' && route === 'purchase-orders') {
    requirePermission(session, 'purchasing.receive');
    const input = bodyOf(request);
    requireLocationAccess(context, input.locationId);
    const result = await rpc('save_purchase_order', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_order_id: input.orderId ?? null,
      p_supplier_id: input.supplierId, p_location_id: input.locationId, p_expected_on: input.expectedOn ?? null,
      p_notes: input.notes ?? null, p_discount_amount: Number(input.discountAmount ?? 0),
      p_tax_amount: Number(input.taxAmount ?? 0), p_other_cost: Number(input.otherCost ?? 0), p_items: input.items
    });
    return send(response, input.orderId ? 200 : 201, result);
  }

  if (request.method === 'POST' && /^purchase-orders\/[^/]+\/(submit|approve|cancel)$/.test(route)) {
    const [, orderId, action] = route.split('/');
    requirePermission(session, action === 'approve' || action === 'cancel' ? 'purchasing.receive' : 'purchasing.receive');
    const accessibleOrder = (await loadPurchaseOrders(context.tenantId, orderId, context.locationIds))[0];
    if (!accessibleOrder) { const error = new Error('Purchase Order tidak ditemukan pada lokasi user'); error.status = 404; throw error; }
    const result = await rpc('transition_purchase_order', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_order_id: orderId, p_action: action.toUpperCase()
    });
    return send(response, 200, result);
  }

  if (request.method === 'POST' && /^purchase-orders\/[^/]+\/receipts$/.test(route)) {
    requirePermission(session, 'purchasing.receive');
    const [, orderId] = route.split('/');
    const input = bodyOf(request);
    const key = request.headers['idempotency-key'];
    if (!key) { const error = new Error('Idempotency-Key wajib diisi'); error.status = 400; throw error; }
    const accessibleOrder = (await loadPurchaseOrders(context.tenantId, orderId, context.locationIds))[0];
    if (!accessibleOrder) { const error = new Error('Purchase Order tidak ditemukan pada lokasi user'); error.status = 404; throw error; }
    const result = await rpc('receive_purchase_order', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_order_id: orderId,
      p_idempotency_key: key, p_document_no: input.documentNo, p_items: input.items
    });
    return send(response, result.duplicate ? 200 : 201, result);
  }

  if (request.method === 'POST' && route === 'purchase-receipts') {
    requirePermission(session, 'purchasing.receive');
    const input = bodyOf(request);
    const key = request.headers['idempotency-key'];
    if (!key) { const error = new Error('Idempotency-Key wajib diisi'); error.status = 400; throw error; }
    requireLocationAccess(context, input.locationId);
    const result = await rpc('receive_purchase', {
      p_tenant_id: context.tenantId,
      p_actor_id: session.authUser.id,
      p_idempotency_key: key,
      p_supplier_id: input.supplierId,
      p_location_id: input.locationId,
      p_document_no: input.documentNo,
      p_items: input.items
    });
    return send(response, result.duplicate ? 200 : 201, result);
  }

  if (request.method === 'POST' && route === 'cost-comparison') {
    requirePermission(session, 'purchasing.view_cost');
    const input = bodyOf(request);
    const supplierFilter = input.supplierId ? `&supplier_id=eq.${encodeURIComponent(input.supplierId)}` : '';
    const items = await rest('purchase_receipt_items', `tenant_id=eq.${context.tenantId}&product_id=eq.${encodeURIComponent(input.productId)}${supplierFilter}&select=*&order=received_at.desc&limit=50`);
    const history = items.map((item) => ({
      occurredAt: item.received_at,
      costPerBase: Number(item.unit_cost),
      supplier: item.supplier_name,
      batch: item.batch_no
    }));
    const comparison = compareCost(Number(input.newCost), history);
    return send(response, 200, { ...comparison, lastDocument: items[0]?.document_no ?? null, supplierScoped: Boolean(input.supplierId) });
  }

  if (request.method === 'GET' && route.startsWith('supplier-comparison/')) {
    requirePermission(session, 'purchasing.view_cost');
    const productId = route.split('/').pop();
    const [items, rules] = await Promise.all([
      rest('purchase_receipt_items', `tenant_id=eq.${context.tenantId}&product_id=eq.${encodeURIComponent(productId)}&select=*&order=received_at.desc&limit=500`),
      rest('price_rules', `tenant_id=eq.${context.tenantId}&product_id=eq.${encodeURIComponent(productId)}&select=*`)
    ]);
    const historyBySupplier = new Map();
    for (const item of items) {
      const key = item.supplier_id ?? item.supplier_name;
      const history = historyBySupplier.get(key) ?? [];
      history.push(item);
      historyBySupplier.set(key, history);
    }
    const suppliers = [...historyBySupplier.values()].map((history) => {
      const item = history[0];
      const previous = history[1] ?? null;
      const lastCost = Number(item.unit_cost);
      const previousCost = previous ? Number(previous.unit_cost) : null;
      return {
      supplierId: item.supplier_id, supplier: item.supplier_name, lastCost,
      previousCost, costTrend: previousCost === null ? null : lastCost - previousCost,
      trendPercentage: previousCost > 0 ? Math.round(((lastCost - previousCost) / previousCost) * 10000) / 100 : null,
      lastDate: item.received_at, previousDate: previous?.received_at ?? null,
      batch: item.batch_no, documentNo: item.document_no, baseQty: Number(item.base_qty)
    };
    }).sort((a,b)=>a.lastCost-b.lastCost);
    const bestCost = suppliers[0]?.lastCost ?? null;
    const retailRule = rules.filter((rule)=>rule.customer_group_id==='retail' && Number(rule.min_base_qty)===1)
      .sort((a,b)=>Number(b.priority)-Number(a.priority))[0];
    return send(response, 200, {
      productId, currentRetailPrice: retailRule ? Number(retailRule.unit_price_base) : null, bestCost,
      suppliers: suppliers.map((supplier) => ({
        ...supplier,
        differenceFromBest: bestCost === null ? null : supplier.lastCost-bestCost,
        percentageFromBest: bestCost > 0 ? Math.round(((supplier.lastCost-bestCost)/bestCost)*10000)/100 : null
      }))
    });
  }

  if (request.method === 'GET' && route.startsWith('cost-history/')) {
    requirePermission(session, 'purchasing.view_cost');
    const productId = route.split('/').pop();
    const supplierId = request.query?.supplierId;
    const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : '';
    const items = await rest('purchase_receipt_items', `tenant_id=eq.${context.tenantId}&product_id=eq.${encodeURIComponent(productId)}${supplierFilter}&select=*&order=received_at.desc&limit=50`);
    const history = items.map((item) => ({
      id: item.id,
      baseQty: Number(item.base_qty),
      costPerBase: Number(item.unit_cost),
      supplierId: item.supplier_id,
      supplier: item.supplier_name,
      batch: item.batch_no,
      expiresOn: item.expires_on,
      documentNo: item.document_no,
      occurredAt: item.received_at
    }));
    return send(response, 200, { productId, supplierId: supplierId ?? null, history });
  }

  if (request.method === 'GET' && route === 'sales/lookup') {
    requirePermission(session, 'sales.return');
    const receiptNo = queryValue(request,'receiptNo');
    if (!receiptNo?.trim()) { const error = new Error('Nomor struk wajib diisi'); error.status = 400; throw error; }
    const sale = await loadReturnableSale(context,{receiptNo});
    if (!sale) { const error = new Error('Nomor struk tidak ditemukan pada outlet yang dapat diakses'); error.status = 404; throw error; }
    return send(response,200,{sale});
  }

  if (request.method === 'GET' && route === 'pos-sales') {
    requirePermission(session, 'pos.sell');
    return send(response, 200, { sales: await loadPosSales(context, queryValue(request,'q') ?? '') });
  }

  if (request.method === 'POST' && /^pos-sales\/[^/]+\/void$/.test(route)) {
    requirePermission(session, 'pos.sell');
    const input = bodyOf(request);
    const saleId = route.split('/')[1];
    const supervisor = await approvedSupervisor(session, context.tenantId, input);
    const result = await rpc('void_sale_v2', {
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_approved_by:supervisor.id,
      p_sale_id:saleId,p_outlet_id:context.outlet.id,p_reason:String(input.reason ?? '')
    });
    return send(response, 200, result);
  }

  if (request.method === 'GET' && route.startsWith('sales/')) {
    requirePermission(session, 'sales.return');
    const saleId = route.split('/').pop();
    const sale = await loadReturnableSale(context,{saleId});
    if (!sale) { const error = new Error('Transaksi penjualan tidak ditemukan'); error.status = 404; throw error; }
    return send(response, 200, { sale });
  }

  if (request.method === 'GET' && route === 'reports/summary') {
    requirePermission(session, 'report.view');
    const timezone = context.outlet.timezone ?? 'Asia/Makassar';
    const today = todayInTimeZone(new Date(), timezone);
    const from = queryValue(request, 'from') ?? shiftIsoDate(today, -29);
    const to = queryValue(request, 'to') ?? today;
    const outletId = queryValue(request, 'outletId');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      const error = new Error('Format periode laporan tidak valid'); error.status = 400; throw error;
    }
    if (outletId && !context.outlets.some((outlet) => outlet.id === outletId)) {
      const error = new Error('User tidak memiliki akses ke outlet laporan'); error.status = 403; throw error;
    }
    const outletIds = outletId ? [outletId] : context.outlets.map((outlet) => outlet.id);
    const locationIds=context.locations.filter((location)=>outletIds.includes(location.outlet_id)).map((location)=>location.id);
    const [report,returnAdjustments] = await Promise.all([
      rpc('report_operational_summary', {
        p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_outlet_ids: outletIds,
        p_from: from, p_to: to, p_timezone: timezone
      }),
      rpc('supplier_return_report_adjustments',{p_tenant_id:context.tenantId,p_location_ids:locationIds,p_from:from,p_to:to,p_timezone:timezone})
    ]);
    const returnBySupplier=new Map((returnAdjustments.suppliers??[]).map((item)=>[item.supplierId,item]));
    report.metrics.purchaseReturnValue=Number(returnAdjustments.totalReturnCredit??0);
    report.metrics.netPurchaseValue=Number(report.metrics.purchaseValue??0)-report.metrics.purchaseReturnValue;
    report.suppliers=(report.suppliers??[]).map((supplier)=>{
      const returned=returnBySupplier.get(supplier.supplierId),returnCredit=Number(returned?.returnCredit??0);
      return{...supplier,returnCount:Number(returned?.returnCount??0),returnCredit,netPurchaseValue:Number(supplier.purchaseValue??0)-returnCredit};
    });
    return send(response, 200, report);
  }

  if(request.method==='GET'&&route==='owner-finance'){
    requirePermission(session,'finance.owner');
    const timezone=context.outlet.timezone??'Asia/Makassar';
    const today=todayInTimeZone(new Date(),timezone);
    const from=queryValue(request,'from')??shiftIsoDate(today,-29);
    const to=queryValue(request,'to')??today;
    const outletId=queryValue(request,'outletId');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to){
      throw Object.assign(new Error('Periode laporan keuangan tidak valid'),{status:400});
    }
    if(outletId&&!context.outlets.some((outlet)=>outlet.id===outletId)){
      throw Object.assign(new Error('Outlet laporan tidak dapat diakses'),{status:403});
    }
    const outletIds=outletId?[outletId]:context.outlets.map((outlet)=>outlet.id);
    const [finance,products,categories]=await Promise.all([
      rpc('report_owner_finance',{
        p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_outlet_ids:outletIds,
        p_from:from,p_to:to,p_timezone:timezone
      }),
      rpc('owner_product_analytics',{
        p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_outlet_ids:outletIds,
        p_from:from,p_to:to,p_timezone:timezone
      }),
      rest('expense_categories',`tenant_id=eq.${context.tenantId}&active=eq.true&select=*&order=name`)
    ]);
    return send(response,200,{...finance,products:products.products??[],categories,outlets:context.outlets});
  }

  if(request.method==='POST'&&route==='expense-categories'){
    requirePermission(session,'finance.owner');
    const input=bodyOf(request),name=String(input.name??'').trim();
    const cashFlowGroup=['OPERATING','INVESTING','FINANCING'].includes(input.cashFlowGroup)?input.cashFlowGroup:'OPERATING';
    if(name.length<2||name.length>80)throw Object.assign(new Error('Nama kategori harus 2–80 karakter'),{status:400});
    const rows=await rest('expense_categories','on_conflict=tenant_id,name',{
      method:'POST',prefer:'resolution=merge-duplicates,return=representation',
      body:{tenant_id:context.tenantId,name,cash_flow_group:cashFlowGroup,active:true,
        created_by:session.authUser.id,updated_at:new Date().toISOString()}
    });
    await rest('audit_logs','',{method:'POST',body:{
      tenant_id:context.tenantId,actor_id:session.authUser.id,action:'EXPENSE_CATEGORY_SAVED',
      entity_type:'expense_category',entity_id:rows[0].id,
      details_json:{name,cashFlowGroup,deviceId:request.headers['x-device-id']||null}
    }});
    return send(response,200,rows[0]);
  }

  if(request.method==='POST'&&route==='outlet-expenses'){
    requirePermission(session,'finance.owner');
    const input=bodyOf(request),key=request.headers['idempotency-key'];
    if(!key)throw Object.assign(new Error('Idempotency-Key wajib diisi'),{status:400});
    if(!context.outlets.some((outlet)=>outlet.id===input.outletId))throw Object.assign(new Error('Outlet biaya tidak dapat diakses'),{status:403});
    const result=await rpc('record_outlet_expense',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_idempotency_key:key,
      p_outlet_id:input.outletId,p_category_id:input.categoryId,p_occurred_on:input.occurredOn,
      p_amount:moneyInput(input.amount,'Nominal biaya'),p_payment_method:input.paymentMethod,
      p_reference:String(input.reference??'').trim(),p_vendor_name:String(input.vendorName??'').trim(),
      p_note:String(input.note??'').trim(),p_shift_id:input.shiftId||null
    });
    return send(response,result.duplicate?200:201,result);
  }

  if(request.method==='POST'&&/^outlet-expenses\/[^/]+\/void$/.test(route)){
    requirePermission(session,'finance.owner');
    const input=bodyOf(request),expenseId=route.split('/')[1];
    return send(response,200,await rpc('void_outlet_expense',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_expense_id:expenseId,
      p_reason:String(input.reason??'').trim()
    }));
  }

  if (request.method === 'GET' && route === 'audit') {
    requirePermission(session, 'audit.view');
    const logs = await rest('audit_logs', `tenant_id=eq.${context.tenantId}&select=*&order=occurred_at.desc&limit=50`);
    const actorIds = [...new Set(logs.map((item) => item.actor_id).filter(Boolean))];
    const actors = actorIds.length ? await rest('profiles', `tenant_id=eq.${context.tenantId}&user_id=${inFilter(actorIds)}&select=user_id,display_name`) : [];
    return send(response, 200, { logs: logs.map((item) => ({
      ...item, actor_name: actors.find((actor) => actor.user_id === item.actor_id)?.display_name ?? null,
      details: item.details_json
    })) });
  }

  const error = new Error(`Endpoint cloud ${request.method} /${route} belum tersedia`);
  error.status = 501;
  throw error;
}

export default async function handler(request, response) {
  try {
    const url = new URL(request.url, 'http://localhost');
    const rawRoute = request.query?.route ?? url.searchParams.get('route') ?? url.pathname.replace(/^\/api\/?/, '');
    const route = Array.isArray(rawRoute) ? rawRoute.join('/') : String(rawRoute).replace(/^\/+|\/+$/g, '');
    await routeRequest(request, response, route);
  } catch (error) {
    send(response, error.status && error.status < 600 ? error.status : 500, { error: error.message ?? 'Kesalahan server cloud', details: process.env.NODE_ENV === 'development' ? error.details : undefined });
  }
}
