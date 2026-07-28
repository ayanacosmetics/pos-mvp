import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PosStore } from './storage.mjs';
import {
  PERMISSIONS, can, compareCost, costHistory, customerGroups, demoUsers,
  outlets, permissionsFor, products, promotionVersions, quoteBasket,
  applySaleAdjustment, normalizeSaleAdjustment, saleAdjustmentFingerprintPayload,
  operatingProfitSummary, productHealth
} from '../../../packages/domain/src/index.mjs';

const webRoot = fileURLToPath(new URL('../../web/', import.meta.url));
const dataPath = process.env.POS_DB_PATH ?? fileURLToPath(new URL('../data/pos-mvp.sqlite', import.meta.url));
export const store = new PosStore(dataPath, products, promotionVersions);
const sessions = new Map();
const saleAuthorizations = new Map();
const port = Number(process.env.PORT ?? 4173);
const defaultReceiptLayout = {
  headerAlignment:'center', footerAlignment:'center', titleSize:'large', density:'normal',
  separator:'dashed', logoSize:64, customHeader:'', customFooter:'', contactLabel:'Tel.', showLogo:true, showBusinessName:true,
  showOutletName:true, showAddress:true, showPhone:true, showDate:true,
  showReceiptNumber:true, showCashier:true, showCustomer:true, showPriceType:true,
  showPaymentDetail:true, showTransactionNote:true, showLoyaltyPoints:true
};
let localBusiness = { id:'tenant-demo', name:'Kasir Nusa Demo', legalName:'', phone:'', email:'', address:'', taxId:'', currency:'IDR', receiptFooter:'Terima kasih telah berbelanja.', logoUrl:'', receiptLayout:{...defaultReceiptLayout} };
let localOutletSettings = outlets.map((outlet) => ({ ...outlet, code:outlet.code ?? 'UTM', timezone:'Asia/Makassar', active:true, receipt_prefix:outlet.code ?? 'UTM', phone:'', address:'', receipt_footer:'' }));
let localCustomerGroups = customerGroups.map((group,index)=>({...group,isDefault:group.id==='retail',active:true,sortOrder:index*10}));
let localLocations = [
  { id: 'outlet-utama', outlet_id: 'outlet-utama', code: 'TOKO', name: 'Toko Utama', kind: 'STORE', active:true },
  { id: 'gudang-utama', outlet_id: 'outlet-utama', code: 'GDG', name: 'Gudang Utama', kind: 'WAREHOUSE', active:true }
];
const localWorkforce = {
  schedules: [],
  attendance: [],
  targets: [],
  approvals: [],
  policies: [],
  reconciliations: []
};
const localFinance = {
  categories: [
    ['Gaji dan tunjangan','OPERATING'],['Sewa tempat','OPERATING'],
    ['Listrik, air, dan internet','OPERATING'],['Perlengkapan toko','OPERATING'],
    ['Pemasaran','OPERATING'],['Pembelian aset','INVESTING'],
  ].map(([name,cash_flow_group])=>({id:crypto.randomUUID(),name,cash_flow_group,active:true})),
  expenses: []
};

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
    if (raw.length > 2_000_000) throw new Error('Payload terlalu besar');
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
  if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { status: 'ok', version: '2.8.3-local', storage: 'sqlite' });

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
    return json(response, 200, { session, business:localBusiness, deviceSettings:{ id:request.headers['x-device-id'],paperWidth:80,autoPrint:false,receiptCopies:1 }, outlets: accessibleOutlets, activeOutletId:accessibleOutlets[0]?.id, locations:localLocations.filter((location)=>location.active), customerGroups:localCustomerGroups, customers: store.customers(), suppliers: can(session, PERMISSIONS.RECEIVE_PURCHASE) ? store.suppliers() : [], products: catalog, promotions: store.promotions(), currentShift: store.currentShift(session.user.id), syncCursor: Date.now().toString() });
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

  if (request.method === 'PUT' && url.pathname === '/api/settings/receipt') {
    const session = requirePermission(request,response,PERMISSIONS.MANAGE_USERS); if(!session)return;
    const input=await bodyOf(request);
    localBusiness={
      ...localBusiness,
      logoUrl:typeof input.logoUrl==='string'?input.logoUrl:localBusiness.logoUrl,
      receiptLayout:{...defaultReceiptLayout,...(input.layout??{})}
    };
    return json(response,200,{business:localBusiness});
  }

  if (request.method === 'GET' && url.pathname === '/api/sync/review') {
    if (!requirePermission(request, response, PERMISSIONS.VIEW_AUDIT)) return;
    return json(response, 200, { commands: [] });
  }

  if (request.method === 'POST' && url.pathname === '/api/sale-authorizations') {
    const session = requirePermission(request, response, PERMISSIONS.POS_SELL);
    if (!session) return;
    if (!can(session,PERMISSIONS.ADJUST_SALE)) return json(response,403,{error:'Akun ini tidak diizinkan mengubah harga atau memberi diskon manual'});
    const input = await bodyOf(request);
    try {
      const adjustment = normalizeSaleAdjustment(input.adjustment);
      const baseQuote = quoteBasket({ lines: input.lines, customerGroupId: input.customerGroupId, products: store.catalog(), promotions: store.promotions(), at: new Date() });
      const id = crypto.randomUUID();
      const token = crypto.randomUUID();
      const approvedBy = session.user.displayName;
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
    const persisted = store.recordSale({ key, quote, lines: input.lines, cashier: session.user, customerId:input.customerId??null, customerGroupId: input.customerGroupId, paymentMethod: input.paymentMethod, shiftId: shift.id, notes:input.notes??'' });
    if (approval) approval.consumed = true;
    const receipt = { id: persisted.id, receiptNo: persisted.receipt_no, status: persisted.status, occurredAt: persisted.occurred_at, cashier: persisted.cashier_name, quote };
    return json(response, 201, receipt);
  }

  if (request.method === 'GET' && url.pathname === '/api/sales/lookup') {
    if (!requirePermission(request, response, PERMISSIONS.PROCESS_RETURN)) return;
    const sale = store.saleByReceipt(url.searchParams.get('receiptNo'));
    return sale ? json(response, 200, { sale }) : json(response, 404, { error: 'Nomor struk tidak ditemukan' });
  }

  if (request.method === 'GET' && url.pathname === '/api/pos-sales') {
    const reportScope=url.searchParams.get('scope')==='report';
    if (!requirePermission(request,response,reportScope?PERMISSIONS.VIEW_REPORTS:PERMISSIONS.POS_SELL)) return;
    const query=String(url.searchParams.get('q')??'').trim().toLowerCase();
    const from=url.searchParams.get('from'),to=url.searchParams.get('to');
    if(reportScope&&(!/^\d{4}-\d{2}-\d{2}$/.test(from??'')||!/^\d{4}-\d{2}-\d{2}$/.test(to??'')||from>to)){
      return json(response,400,{error:'Periode riwayat transaksi tidak valid'});
    }
    const sales=store.recentPosSales(reportScope?500:50).filter((sale)=>{
      const date=String(sale.occurredAt??'').slice(0,10);
      return (!reportScope||(date>=from&&date<=to))
        &&(!query||`${sale.receiptNo} ${sale.cashier} ${sale.customer?.name??''} ${sale.customer?.phone??''}`.toLowerCase().includes(query));
    });
    return json(response,200,{sales});
  }

  if (request.method === 'POST' && /^\/api\/pos-sales\/[^/]+\/void$/.test(url.pathname)) {
    const session=requirePermission(request,response,PERMISSIONS.POS_SELL);if(!session)return;
    if(!can(session,PERMISSIONS.VOID_SALE))return json(response,403,{error:'Akun ini tidak diizinkan melakukan void transaksi'});
    const input=await bodyOf(request);
    try{
      const saleId=decodeURIComponent(url.pathname.split('/')[3]);
      return json(response,200,store.voidSale({saleId,reason:input.reason,actorId:session.user.id,approvedBy:session.user.id}));
    }catch(error){return json(response,409,{error:error.message});}
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

  if (request.method === 'POST' && url.pathname === '/api/media/product-image') {
    if (!requirePermission(request, response, PERMISSIONS.MANAGE_PRODUCTS)) return;
    const input=await bodyOf(request);
    if(!/^data:image\/(png|jpeg|webp);base64,/i.test(String(input.dataUrl??'')))return json(response,400,{error:'Pilih foto PNG, JPEG, atau WebP yang valid'});
    return json(response,201,{imageUrl:input.dataUrl});
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

  if (request.method === 'POST' && url.pathname === '/api/customer-groups') {
    const session=requirePermission(request,response,PERMISSIONS.MANAGE_PRODUCTS);if(!session)return;
    const input=await bodyOf(request),name=String(input.name??'').trim().replace(/\s+/g,' ');
    const id=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,36);
    if(name.length<2||id.length<2)return json(response,400,{error:'Nama tipe pelanggan tidak valid'});
    if(localCustomerGroups.some((group)=>group.id===id))return json(response,409,{error:'Tipe pelanggan sudah ada'});
    const group={id,name,isDefault:false,active:true,sortOrder:localCustomerGroups.length*10};
    localCustomerGroups.push(group);
    return json(response,201,group);
  }

  if(request.method==='GET'&&url.pathname==='/api/workforce/overview'){
    const session=requirePermission(request,response,PERMISSIONS.WORKFORCE_SELF);if(!session)return;
    const canManage=can(session,PERMISSIONS.MANAGE_WORKFORCE);
    const profiles=(canManage?demoUsers:demoUsers.filter((user)=>user.id===session.user.id)).map((user)=>({user_id:user.id,display_name:user.displayName,role:user.role}));
    const sales=store.recentPosSales(500);
    const performance=profiles.map((profile)=>{
      const target=localWorkforce.targets.find((item)=>item.user_id===profile.user_id);
      const rows=sales.filter((sale)=>sale.cashier_id===profile.user_id&&sale.status==='COMPLETED');
      const salesTotal=rows.reduce((sum,sale)=>sum+Number(sale.grandTotal??sale.grand_total??0),0);
      const commission=target?.commission_type==='FIXED_PER_TRANSACTION'?rows.length*Number(target.commission_value):salesTotal*Number(target?.commission_value??0)/100;
      return{userId:profile.user_id,displayName:profile.display_name,role:profile.role,target,salesTotal,transactions:rows.length,commission};
    });
    return json(response,200,{canManage,today:new Date().toISOString().slice(0,10),profiles,outlets:localOutletSettings,
      schedules:localWorkforce.schedules.filter((item)=>canManage||item.user_id===session.user.id),
      attendance:localWorkforce.attendance.filter((item)=>canManage||item.user_id===session.user.id),
      targets:localWorkforce.targets.filter((item)=>canManage||item.user_id===session.user.id),performance,
      activeAttendance:localWorkforce.attendance.find((item)=>item.user_id===session.user.id&&!item.clock_out_at)??null});
  }

  if(request.method==='POST'&&url.pathname==='/api/workforce/schedules'){
    const session=requirePermission(request,response,PERMISSIONS.MANAGE_WORKFORCE);if(!session)return;
    const input=await bodyOf(request),row={id:crypto.randomUUID(),user_id:input.userId,outlet_id:input.outletId,
      work_date:input.workDate,starts_at:input.startsAt,ends_at:input.endsAt,note:input.note||null,status:'SCHEDULED',
      created_by:session.user.id,created_at:new Date().toISOString()};
    localWorkforce.schedules.push(row);return json(response,201,row);
  }

  if(request.method==='POST'&&url.pathname==='/api/workforce/attendance'){
    const session=requirePermission(request,response,PERMISSIONS.WORKFORCE_SELF);if(!session)return;
    const input=await bodyOf(request),active=localWorkforce.attendance.find((item)=>item.user_id===session.user.id&&!item.clock_out_at);
    if(input.action==='CLOCK_IN'){
      if(active)return json(response,409,{error:'Absensi masuk masih aktif'});
      const row={id:crypto.randomUUID(),user_id:session.user.id,outlet_id:session.user.outletIds[0],work_date:new Date().toISOString().slice(0,10),clock_in_at:new Date().toISOString(),clock_out_at:null,status:'PRESENT',note:input.note||null};
      localWorkforce.attendance.push(row);return json(response,200,row);
    }
    if(!active)return json(response,409,{error:'Belum ada absensi masuk aktif'});
    active.clock_out_at=new Date().toISOString();active.status='COMPLETED';return json(response,200,active);
  }

  if(request.method==='POST'&&url.pathname==='/api/workforce/targets'){
    const session=requirePermission(request,response,PERMISSIONS.MANAGE_WORKFORCE);if(!session)return;
    const input=await bodyOf(request),row={id:crypto.randomUUID(),user_id:input.userId,outlet_id:input.outletId,
      period_start:input.periodStart,period_end:input.periodEnd,sales_target:Number(input.salesTarget),
      transaction_target:Number(input.transactionTarget),commission_type:input.commissionType,
      commission_value:Number(input.commissionValue),active:true,created_by:session.user.id};
    const index=localWorkforce.targets.findIndex((item)=>item.user_id===row.user_id&&item.period_start===row.period_start&&item.period_end===row.period_end);
    if(index>=0)localWorkforce.targets[index]={...localWorkforce.targets[index],...row};else localWorkforce.targets.push(row);
    return json(response,200,row);
  }

  if(request.method==='GET'&&url.pathname==='/api/approvals'){
    const session=requirePermission(request,response,PERMISSIONS.WORKFORCE_SELF);if(!session)return;
    const canManage=can(session,PERMISSIONS.MANAGE_APPROVALS);
    return json(response,200,{canManage,requests:localWorkforce.approvals.filter((item)=>canManage||item.requester_id===session.user.id),
      policies:canManage?localWorkforce.policies:[],actors:demoUsers.map((user)=>({user_id:user.id,display_name:user.displayName,role:user.role}))});
  }

  if(request.method==='POST'&&url.pathname==='/api/approvals/requests'){
    const session=requirePermission(request,response,PERMISSIONS.WORKFORCE_SELF);if(!session)return;
    const input=await bodyOf(request),policy=localWorkforce.policies.filter((item)=>item.action_type===input.actionType&&item.minimum_amount<=Number(input.amount)).sort((a,b)=>b.minimum_amount-a.minimum_amount)[0];
    const row={id:crypto.randomUUID(),requester_id:session.user.id,outlet_id:session.user.outletIds[0],action_type:input.actionType,
      amount:Number(input.amount),reason:input.reason,required_levels:Number(policy?.required_levels??1),current_level:0,status:'PENDING',decisions_json:[],requested_at:new Date().toISOString()};
    localWorkforce.approvals.push(row);return json(response,201,row);
  }

  if(request.method==='POST'&&/^\/api\/approvals\/[^/]+\/decision$/.test(url.pathname)){
    const session=requirePermission(request,response,PERMISSIONS.MANAGE_APPROVALS);if(!session)return;
    const item=localWorkforce.approvals.find((row)=>row.id===url.pathname.split('/')[3]),input=await bodyOf(request);
    if(!item)return json(response,404,{error:'Permintaan tidak ditemukan'});
    if(item.requester_id===session.user.id)return json(response,409,{error:'Pemohon tidak dapat menyetujui permintaan sendiri'});
    if(input.decision==='REJECT'){item.status='REJECTED';item.decided_at=new Date().toISOString();}
    else{item.current_level+=1;item.status=item.current_level>=item.required_levels?'APPROVED':'PENDING';}
    item.decisions_json.push({actorId:session.user.id,decision:input.decision,at:new Date().toISOString()});
    return json(response,200,item);
  }

  if(request.method==='POST'&&url.pathname==='/api/approvals/policies'){
    const session=requirePermission(request,response,PERMISSIONS.MANAGE_APPROVALS);if(!session)return;
    const input=await bodyOf(request),row={id:crypto.randomUUID(),action_type:input.actionType,minimum_amount:Number(input.minimumAmount),required_levels:Number(input.requiredLevels),active:true};
    localWorkforce.policies.push(row);return json(response,200,row);
  }

  if(request.method==='GET'&&url.pathname==='/api/workforce/activity'){
    if(!requirePermission(request,response,PERMISSIONS.MANAGE_WORKFORCE))return;
    return json(response,200,{logs:store.auditLogs(200).map((log)=>({...log,actor:{display_name:demoUsers.find((user)=>user.id===log.actor_id)?.displayName??'Sistem'}}))});
  }

  if(request.method==='GET'&&url.pathname==='/api/workforce/reconciliations'){
    if(!requirePermission(request,response,PERMISSIONS.MANAGE_WORKFORCE))return;
    return json(response,200,{shifts:localWorkforce.reconciliations});
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
    const input=await bodyOf(request),cash=input.declarations?.find((item)=>['CASH','TUNAI'].includes(String(item.method).toUpperCase()));
    const closed=store.closeShift({shiftId:input.shiftId,closingCash:Number(cash?.declaredAmount??input.closingCash),actorId:session.user.id});
    localWorkforce.reconciliations.unshift({...closed,cashierName:session.user.displayName,methods:(input.declarations??[]).map((item)=>({payment_method:item.method,expected_amount:item.declaredAmount,declared_amount:item.declaredAmount,difference:0}))});
    return json(response, 200, closed);
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

  if(request.method==='GET'&&url.pathname==='/api/owner-finance'){
    if(!requirePermission(request,response,PERMISSIONS.OWNER_FINANCE))return;
    const report=store.reportSummary({from:url.searchParams.get('from'),to:url.searchParams.get('to')});
    const selectedExpenses=localFinance.expenses.filter((item)=>item.occurredOn>=report.period.from&&item.occurredOn<=report.period.to);
    const operatingExpenses=selectedExpenses.filter((item)=>item.status==='POSTED'&&item.cashFlowGroup==='OPERATING').reduce((sum,item)=>sum+item.amount,0);
    const cashOutflow=selectedExpenses.filter((item)=>item.status==='POSTED').reduce((sum,item)=>sum+item.amount,0);
    const metrics={...operatingProfitSummary({netSales:report.metrics.netSales,costOfGoods:report.metrics.costOfGoods,operatingExpenses}),receivables:0,payables:0};
    const daily=report.daily.map((day)=>{
      const expenses=selectedExpenses.filter((item)=>item.status==='POSTED'&&item.cashFlowGroup==='OPERATING'&&item.occurredOn===day.date).reduce((sum,item)=>sum+item.amount,0);
      return{date:day.date,netSales:day.netSales,grossProfit:day.grossProfit,expenses,operatingProfit:day.grossProfit-expenses};
    });
    const inventory=store.inventory(),catalog=store.catalog();
    const products=catalog.map((product)=>{
      const balance=inventory.filter((item)=>item.product_id===product.id).reduce((row,item)=>({qty:row.qty+Number(item.quantity),value:row.value+Number(item.quantity)*Number(item.avg_cost)}),{qty:0,value:0});
      const sold=report.products.find((item)=>item.productId===product.id)??{netQty:0,netRevenue:0,grossProfit:0};
      const health=productHealth({stockQty:balance.qty,netQty:sold.netQty,netRevenue:sold.netRevenue,grossProfit:sold.grossProfit,lastSaleOn:sold.netQty>0?report.period.to:null,asOf:report.period.to,fastMoving:report.products.slice(0,Math.max(1,Math.ceil(report.products.length/5))).some((item)=>item.productId===product.id)});
      return{productId:product.id,sku:product.sku,productName:product.name,category:product.category,brand:product.brand,stockQty:balance.qty,stockValue:balance.value,netQty:sold.netQty,netRevenue:sold.netRevenue,grossProfit:sold.grossProfit,lastSaleOn:sold.netQty>0?report.period.to:null,...health};
    }).filter((item)=>item.stockQty||item.netQty);
    const expenseBreakdown=localFinance.categories.map((category)=>({categoryId:category.id,categoryName:category.name,cashFlowGroup:category.cash_flow_group,amount:selectedExpenses.filter((item)=>item.status==='POSTED'&&item.categoryId===category.id).reduce((sum,item)=>sum+item.amount,0)}));
    return json(response,200,{period:report.period,metrics,daily,expenses:selectedExpenses,expenseBreakdown,
      cashFlow:{totalInflow:report.metrics.netSales,totalOutflow:cashOutflow,netCashFlow:report.metrics.netSales-cashOutflow,methods:[{method:'CASH',inflow:report.metrics.netSales,outflow:cashOutflow,net:report.metrics.netSales-cashOutflow}]},
      aging:{receivables:{current:0,days1To30:0,days31To60:0,daysOver60:0,dueNext30:0},payables:{current:0,days1To30:0,days31To60:0,daysOver60:0,dueNext30:0}},
      supplierActions:[],customerActions:[],products,categories:localFinance.categories,outlets:localOutletSettings,generatedAt:new Date().toISOString()});
  }

  if(request.method==='POST'&&url.pathname==='/api/expense-categories'){
    if(!requirePermission(request,response,PERMISSIONS.OWNER_FINANCE))return;
    const input=await bodyOf(request),existing=localFinance.categories.find((item)=>item.name.toLowerCase()===String(input.name).trim().toLowerCase());
    if(existing){existing.cash_flow_group=input.cashFlowGroup;return json(response,200,existing);}
    const row={id:crypto.randomUUID(),name:String(input.name).trim(),cash_flow_group:input.cashFlowGroup,active:true};
    localFinance.categories.push(row);return json(response,200,row);
  }

  if(request.method==='POST'&&url.pathname==='/api/outlet-expenses'){
    const session=requirePermission(request,response,PERMISSIONS.OWNER_FINANCE);if(!session)return;
    const input=await bodyOf(request),key=request.headers['idempotency-key'];
    const existing=localFinance.expenses.find((item)=>item.idempotencyKey===key);if(existing)return json(response,200,{id:existing.id,expenseNo:existing.expenseNo,duplicate:true});
    const category=localFinance.categories.find((item)=>item.id===input.categoryId),outlet=localOutletSettings.find((item)=>item.id===input.outletId);
    if(!category||!outlet)return json(response,400,{error:'Kategori atau outlet tidak valid'});
    const row={id:crypto.randomUUID(),idempotencyKey:key,expenseNo:`BYA-DEMO-${String(localFinance.expenses.length+1).padStart(4,'0')}`,
      occurredOn:input.occurredOn,outletId:outlet.id,outletName:outlet.name,categoryId:category.id,categoryName:category.name,
      cashFlowGroup:category.cash_flow_group,amount:Number(input.amount),paymentMethod:input.paymentMethod,reference:input.reference||null,
      vendorName:input.vendorName||null,note:input.note,status:'POSTED',createdBy:session.user.id};
    localFinance.expenses.unshift(row);return json(response,201,{id:row.id,expenseNo:row.expenseNo,amount:row.amount,duplicate:false});
  }

  if(request.method==='POST'&&/^\/api\/outlet-expenses\/[^/]+\/void$/.test(url.pathname)){
    if(!requirePermission(request,response,PERMISSIONS.OWNER_FINANCE))return;
    const row=localFinance.expenses.find((item)=>item.id===url.pathname.split('/')[3]);if(!row)return json(response,404,{error:'Biaya tidak ditemukan'});
    row.status='VOIDED';row.voidReason=(await bodyOf(request)).reason;return json(response,200,row);
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
