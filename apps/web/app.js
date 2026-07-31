import { formatExpiryValue, parseExpiryDate } from './date.mjs';
import { quoteBasket as quoteOffline } from './pricing.mjs';
import { deviceIdentity, enqueueCommand, listCommands, migrateLegacyQueue, removeCommand, updateCommand } from './offline-store.mjs';
import { clearStoredAuth, isAuthStorageEvent, loadAuth, saveAuth, shouldRefreshAuth } from './auth-store.mjs';
import { customerReceiptView } from './receipt.mjs';
import { disconnectBluetoothPrinter, printEscPosProductLabels, printEscPosReceipt, printEscPosTest, printerConnected, printerSelected, renderEscPosProductLabelCanvas, restoreGrantedPrinter, selectBluetoothPrinter, supportsBluetoothClassicPrinting } from './escpos-printer.mjs';
import { productBaseQuantity, shouldChooseUnitAfterScan, sortedProductUnits, unitFitsStock } from './pos-units.mjs';
import { appendMoneyKey, suggestedCashAmounts } from './payment-keypad.mjs';
import { createProductExportWorkbook, createTemplateWorkbook, productExportRows, productExtensionExportRows, workbookMatrix, workbookTemplates } from './product-workbook.mjs';
import { barcodeModuleCount, barcodeSvg, labelSize, normalizeCode128Text } from './product-labels.mjs';
import { parseKaspinProductWorkbook, parseKaspinProductExtensionWorkbook, parseKaspinFifoWorkbooks, parseKaspinSalesWorkbooks, parseKaspinCustomerWorkbook } from './kaspin-import.mjs';

const storedAuth = loadAuth();
const state = { token: storedAuth.token, refreshToken: storedAuth.refreshToken, expiresAt: storedAuth.expiresAt, session: null, business: { name: 'Kasir Nusa', receiptFooter: 'Terima kasih telah berbelanja.' }, deviceSettings: { paperWidth: 80, autoPrint: false, receiptCopies: 1 }, settings: { outlets: [], locations: [], devices: [] }, systemHealth: null, dataResetScopesSignature:'', dataRestoreSnapshot:null,dataRestoreOtpReady:false, outlets: [], activeOutletId: null, products: [], posCategoryFilter: '', favoriteOnly: false, posProductLimit:100, unitPicker:null, posSales: [], selectedPosSaleId: null, managedProducts: [], productAdminPage:1, selectedProductIds:new Set(), productActionId:null, productLabelCopies:new Map(), productImportMode:'GENERAL', importSourceReport:null, productUnitsDraft: [], productPriceTiers: {}, pricePolicyRules: [], pricePolicyPreview:null, productImageFile:null, productImagePreviewUrl:'', promotions: [], promotionVersions: [], loyalty: { settings:null,tiers:[],vouchers:[],receiptCampaigns:[] }, crmDashboard:null, voucherCode:'', customerGroups: [], customers: [], customerEditorSource: 'relations', customerAging: null, activeCustomerStatement:null, suppliers: [], activeSupplierStatement:null, locations: [], purchaseOrders: [], editingOrderId: null, poLines: [], activePurchaseOrder: null, supplierReturnReceipt: null, recentSupplierReturns: [], currentShift: null, cart: [], quote: null, saleAuthorization: null, adjustmentTargetIndex: null, paymentDraft: [], paymentKeypadIndex:0, paymentKeypadFresh:true, heldSales: [], lastReceipt: null, inventory: [], inventoryProducts: [], ledger: [], stockProductId:null, stockProductDetail:null, stockProductView:'overview', stockLogEntryId:null, expiryBatches: [], expiryMetrics: null, expiryError: null, report: null, ownerFinance: null, accounting:null, manualJournalLines:[], users: [], syncReview: [], returnSale: null, recentReturns: [], importDraft: null, importJobs: [], backupExports: [], workforce: { overview:null, approvals:null,activity:[], reconciliations:[] }, multioutlet:{transfers:[],pricing:{overrides:[],baseRules:[]},promotions:[],consolidation:null,notifications:[]}, pilot:null };
const money = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
state.loginPortal = sessionStorage.getItem('pos_login_portal') === 'STAFF' ? 'STAFF' : 'OWNER';
state.ownerContextId = localStorage.getItem('pos_owner_context_id');
state.restockPlanning = { recommendations: [], settings: { approvalThreshold: 5000000, lookbackDays: 30 }, locationId: null };
state.restockSelection = new Map();
state.restockPlanningLimit = 100;
state.restockWizardStep = 'document';
state.salesPeriodLevel = 'DAY';
state.salesPeriodValue = null;
state.salesReportOpen = false;
state.salesMetricKey = 'transactions';
state.salesMetrics = null;
state.salesYears = [];
state.salesPeriodTrail = [];
state.salesReportFilter = {staffId:'',paymentState:'ALL',sort:'DESC',paymentMethods:['CASH','QRIS','TRANSFER','EDC','CREDIT','MULTIPAYMENT'],includeCreditProfit:true,includeCreditRevenue:false};
state.salesAnalysis = {preset:'TODAY',sort:'QTY_DESC',data:null,view:'sales-products'};
state.purchaseReportOpen = false;
state.purchaseReportPeriod = 'TODAY';
state.purchaseReportReceipts = [];
const el = (id) => document.getElementById(id);
const posDevice = deviceIdentity();
const roleLabels = { OWNER: 'Owner', ADMIN: 'Admin', MANAGER: 'Manajer Outlet', CASHIER: 'Kasir', PURCHASING: 'Pembelian', WAREHOUSE: 'Gudang' };
const permissionOptions=[
  ['pos.sell','Penjualan kasir','Transaksi, member, shift, dan pembayaran'],
  ['sale.adjust','Ubah harga & diskon manual','Penyesuaian sensitif tanpa sandi Owner'],
  ['sale.void','Void transaksi','Batalkan transaksi dan kembalikan stok'],
  ['sales.return','Retur pelanggan','Proses pengembalian barang dan dana'],
  ['purchasing.view_cost','Lihat harga modal','Harga beli dan perbandingan supplier'],
  ['purchasing.receive','Restok & penerimaan','Pesanan serta penerimaan supplier'],
  ['inventory.manage','Kelola stok','Transfer, opname, batch, dan jurnal stok'],
  ['catalog.manage','Kelola produk & harga','Produk, satuan, barcode, dan harga jual'],
  ['promotion.manage','Promo & loyalitas','Aturan promo, poin, tier, dan voucher'],
  ['report.view','Lihat laporan','Pendapatan, keuntungan, produk, dan transaksi'],
  ['audit.view','Audit & sinkronisasi','Jejak aktivitas dan konflik offline'],
  ['workforce.self','Fitur karyawan sendiri','Jadwal, absensi, target, dan permintaan'],
  ['workforce.manage','Kelola karyawan','Jadwal, target, aktivitas, rekonsiliasi'],
  ['approval.manage','Putuskan persetujuan','Setujui permintaan operasional'],
  ['multioutlet.view','Lihat multi-outlet','Ringkasan lintas cabang'],
  ['multioutlet.manage','Kelola multi-outlet','Transfer, harga, dan promo cabang']
];
const permissionDefaults={
  CASHIER:['pos.sell','workforce.self'],
  PURCHASING:['purchasing.view_cost','purchasing.receive','workforce.self'],
  WAREHOUSE:['inventory.manage','workforce.self'],
  MANAGER:['pos.sell','inventory.manage','sales.return','catalog.manage','promotion.manage','report.view','audit.view','workforce.self','workforce.manage','approval.manage','multioutlet.view','multioutlet.manage'],
  ADMIN:permissionOptions.map(([permission])=>permission)
};
const defaultReceiptLayout={
  headerAlignment:'center',footerAlignment:'center',titleSize:'large',
  density:'normal',separator:'dashed',logoSize:64,customHeader:'',customFooter:'',contactLabel:'Tel.',
  showLogo:true,showBusinessName:true,showOutletName:true,showAddress:true,
  showPhone:true,showDate:true,showReceiptNumber:true,showCashier:true,
  showCustomer:true,showPriceType:true,showPaymentDetail:true,
  showTransactionNote:true,showLoyaltyPoints:true
};
let refreshPromise = null;
let deferredInstallPrompt = null;
let quoteRevision = 0;
let quoteVerificationTimer = null;
let barcodeCameraStream = null;
let barcodeCameraTimer = null;
let barcodeCameraTarget = null;
let barcodeCameraControls = null;
let barcodeCameraCompleting = false;
let lastTelemetryAt = 0;
let productManagementPromise = null;
let deferredBootstrapRun = 0;

function storeAuth(data) {
  const auth = saveAuth(data, state);
  state.token = auth.token;
  state.refreshToken = auth.refreshToken;
  state.expiresAt = auth.expiresAt;
}

function clearAuth() {
  state.token = null; state.refreshToken = null; state.expiresAt = null; state.session = null;
  state.ownerContextId = null;
  clearStoredAuth();
  localStorage.removeItem('pos_bootstrap_cache');
  localStorage.removeItem('pos_owner_context_id');
}

async function refreshSession(allowStorageRecovery = true) {
  const latest = loadAuth();
  if (latest.refreshToken && latest.refreshToken !== state.refreshToken) {
    state.token = latest.token;
    state.refreshToken = latest.refreshToken;
    state.expiresAt = latest.expiresAt;
  }
  if (!refreshPromise) {
    const attemptedRefreshToken = state.refreshToken;
    refreshPromise = fetch('/api/refresh', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(attemptedRefreshToken ? { refreshToken: attemptedRefreshToken } : {})
    }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (allowStorageRecovery && [400,401,403].includes(response.status)) {
          const recovered = loadAuth();
          if (recovered.refreshToken && recovered.refreshToken !== attemptedRefreshToken) {
            state.token = recovered.token;
            state.refreshToken = recovered.refreshToken;
            state.expiresAt = recovered.expiresAt;
            if (recovered.token) return recovered;
          }
        }
        const error = new Error(data.error ?? 'Sesi berakhir');
        error.status = [400,401,403].includes(response.status) ? 401 : response.status;
        throw error;
      }
      storeAuth(data);
      return data;
    }).finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

function reportClientTelemetry(eventType,path,{statusCode=null,durationMs=null}={}){
  if(!state.token||path==='/api/pilot/telemetry')return;
  const now=Date.now();
  if(eventType==='NETWORK_ERROR'&&now-lastTelemetryAt<10000)return;
  lastTelemetryAt=now;
  const headers={'content-type':'application/json',authorization:`Bearer ${state.token}`,'x-device-id':posDevice.id};
  if(state.ownerContextId)headers['x-owner-context-id']=state.ownerContextId;
  if(state.activeOutletId)headers['x-outlet-id']=state.activeOutletId;
  fetch('/api/pilot/telemetry',{method:'POST',headers,body:JSON.stringify({
    eventType,endpoint:path.split('?')[0],statusCode,durationMs,
    online:navigator.onLine,platform:navigator.userAgent.slice(0,80)
  })}).catch(()=>{});
}

async function request(path, options = {}, allowRefresh = true) {
  const started=globalThis.performance?.now?.()??Date.now();
  const publicAuthPaths = ['/api/login','/api/register-owner','/api/refresh','/api/logout'];
  if (allowRefresh && !publicAuthPaths.includes(path) && shouldRefreshAuth(state)) {
    try {
      await refreshSession();
    } catch (error) {
      if ([401,403].includes(error.status)) clearAuth();
      throw error;
    }
  }
  const headers = { 'content-type': 'application/json', ...(options.headers ?? {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (state.ownerContextId) headers['x-owner-context-id'] = state.ownerContextId;
  if (state.session && state.activeOutletId) headers['x-outlet-id'] = state.activeOutletId;
  headers['x-device-id'] = posDevice.id;
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    reportClientTelemetry('NETWORK_ERROR',path,{durationMs:Math.round((globalThis.performance?.now?.()??Date.now())-started)});
    const error = new Error(navigator.onLine ? 'Server belum dapat dihubungi. Coba lagi beberapa saat.' : 'Perangkat sedang offline. Periksa koneksi internet.');
    error.code = 'NETWORK_ERROR';
    throw error;
  }
  const durationMs=Math.round((globalThis.performance?.now?.()??Date.now())-started);
  if(response.status>=500)reportClientTelemetry('HTTP_ERROR',path,{statusCode:response.status,durationMs});
  else if(durationMs>=2500)reportClientTelemetry('SLOW_REQUEST',path,{statusCode:response.status,durationMs});
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && allowRefresh && !publicAuthPaths.includes(path) && state.refreshToken) {
    try { await refreshSession(); return request(path, options, false); }
    catch (error) { if ([401,403].includes(error.status)) clearAuth(); throw error; }
  }
  if (!response.ok) { const error = new Error(data.error ?? 'Permintaan gagal'); error.status = response.status; throw error; }
  return data;
}

function toast(message) {
  el('toast').textContent = message;
  el('toast').classList.add('show');
  setTimeout(() => el('toast').classList.remove('show'), 2400);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function productImageUrl(product) {
  const value = String(product?.imageUrl ?? '').trim();
  if (!value) return '';
  if(/^data:image\/(png|jpeg|webp);base64,/i.test(value))return value;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function productThumbnail(product) {
  const imageUrl = productImageUrl(product);
  const initial = String(product?.name ?? '?').trim().charAt(0).toLocaleUpperCase('id-ID') || '?';
  return `<span class="product-thumb" aria-hidden="true"><span>${escapeHtml(initial)}</span>${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" loading="lazy" decoding="async">` : ''}</span>`;
}

function bindProductImageFallbacks(container) {
  container?.querySelectorAll('.product-thumb img').forEach((image) => {
    image.addEventListener('error', () => image.remove(), { once: true });
  });
}

function setLoginPortal(portal) {
  state.loginPortal = portal === 'STAFF' ? 'STAFF' : 'OWNER';
  sessionStorage.setItem('pos_login_portal', state.loginPortal);
  const owner = state.loginPortal === 'OWNER';
  el('login-title').textContent = owner ? 'Masuk sebagai Owner' : 'Masuk sebagai Staff';
  el('login-description').textContent = owner
    ? 'Kelola usaha, laporan, pengguna, harga, dan seluruh outlet.'
    : 'Masuk sebagai Admin, Kasir, Pembelian, atau Gudang.';
  el('login-role-label').textContent = owner ? 'Owner' : 'Staff';
  el('login-help').textContent = owner
    ? 'Gunakan akun Owner aktif pada usaha Anda.'
    : 'Hak akses Staff mengikuti peran dan outlet yang diberikan Owner.';
  el('login-form').querySelector('button[type="submit"]').textContent = owner ? 'Masuk sebagai Owner' : 'Masuk sebagai Staff';
  el('open-owner-registration').classList.toggle('hidden', !owner);
  document.querySelectorAll('[data-login-portal]').forEach((button) => {
    const active = button.dataset.loginPortal === state.loginPortal;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  el('login-error').textContent = '';
}

async function login(email, password, portal) {
  const data = await request('/api/login', { method: 'POST', body: JSON.stringify({ email, password, portal }) });
  storeAuth(data);
  sessionStorage.setItem('pos_login_portal', portal);
  await bootstrap({ reportError: true });
}

function setAuthView(view) {
  const registering = view === 'register';
  el('login-form').classList.toggle('hidden', registering);
  el('register-owner-form').classList.toggle('hidden', !registering);
  el('register-owner-error').textContent = '';
  el('register-owner-success').textContent = '';
  el('register-owner-success').classList.add('hidden');
  el('register-owner-form').querySelector('button[type="submit"]').classList.remove('hidden');
  if (registering) {
    setLoginPortal('OWNER');
    el('register-owner-email').value = el('email').value.trim();
    requestAnimationFrame(() => el('register-owner-name').focus());
  } else {
    requestAnimationFrame(() => el('email').focus());
  }
}

async function registerOwner(input) {
  const data = await request('/api/register-owner', {
    method: 'POST',
    body: JSON.stringify(input)
  });
  if (data.token) {
    storeAuth(data);
    sessionStorage.setItem('pos_login_portal', 'OWNER');
    await bootstrap({ reportError: true });
  }
  return data;
}

function saveBootstrapCache(data) {
  const session = { ...data.session };
  delete session.token;
  localStorage.setItem('pos_bootstrap_cache', JSON.stringify({ ...data, session, cachedAt: new Date().toISOString() }));
}

function cacheCurrentShift() {
  const cached = localStorage.getItem('pos_bootstrap_cache');
  if (!cached) return;
  const data = JSON.parse(cached);
  data.currentShift = state.currentShift;
  data.cachedAt = new Date().toISOString();
  localStorage.setItem('pos_bootstrap_cache', JSON.stringify(data));
}

async function applyBootstrap(data, { offline = false } = {}) {
  state.session = data.session;
  state.ownerContextId = data.session.ownerContextActive ? data.session.user.id : null;
  if (state.ownerContextId) localStorage.setItem('pos_owner_context_id', state.ownerContextId);
  else localStorage.removeItem('pos_owner_context_id');
  state.business = data.business ?? state.business;
  state.deviceSettings = { ...state.deviceSettings, ...(data.deviceSettings ?? {}) };
  state.outlets = data.outlets ?? [];
  state.activeOutletId = data.activeOutletId ?? state.outlets[0]?.id ?? null;
  state.products = data.products ?? [];
  // Katalog aktif dari bootstrap sudah cukup untuk langsung mengisi halaman
  // Produk. Data master lengkap (termasuk produk nonaktif) menyusul di latar
  // belakang agar pengguna tidak melihat angka nol palsu.
  state.managedProducts = state.products.map((product)=>({...product,active:product.active!==false}));
  state.customerGroups = data.customerGroups?.length ? data.customerGroups : [{id:'retail',name:'Umum',isDefault:true}];
  state.promotions = data.promotions ?? [];
  state.customers = data.customers ?? [];
  state.suppliers = data.suppliers ?? [];
  state.locations = data.locations ?? [];
  state.currentShift = data.currentShift;
  renderOutletSwitcher();
  await migrateLegacyQueue(state.session.user.id);
  await updateQueueCount();
  el('user-name').textContent = state.session.user.displayName;
  el('user-role').textContent = roleLabels[state.session.user.role] ?? state.session.user.role;
  el('switch-account').classList.toggle('hidden', !state.session.canSwitchOwners);
  renderLastSync();
  document.querySelectorAll('[data-permission]').forEach((node) => node.classList.toggle('hidden', !state.session.permissions.includes(node.dataset.permission)));
  syncNavigationPermissions();
  el('session-view').classList.add('hidden');
  el('login-view').classList.add('hidden');
  el('app-view').classList.remove('hidden');
  renderProducts();
  renderProductTable();
  renderRestock();
  renderCustomerGroupControls();
  renderRelations();
  renderPromotionEditorOptions();
  renderPromotionList();
  renderShift();
  renderImportLocations();
  await updateQuote();
  if (!offline) startDeferredBootstrapLoads();
}

async function bootstrap({ reportError = false } = {}) {
  const cached = localStorage.getItem('pos_bootstrap_cache');
  let cacheApplied = false;
  if (cached) {
    try {
      await applyBootstrap(JSON.parse(cached), { offline: true });
      cacheApplied = true;
    } catch {
      localStorage.removeItem('pos_bootstrap_cache');
    }
  }
  try {
    const data = await request('/api/bootstrap');
    saveBootstrapCache(data);
    await applyBootstrap(data);
    recordLastSync();
  } catch (error) {
    if (!error.status && cacheApplied) {
      toast('Mode offline aktif. Katalog terakhir siap digunakan.');
      return;
    }
    if ([401,403].includes(error.status)) clearAuth();
    el('session-view').classList.add('hidden');
    el('login-view').classList.remove('hidden');
    el('app-view').classList.add('hidden');
    if (![401,403].includes(error.status)) el('login-error').textContent = `Sesi masih tersimpan, tetapi data gagal dimuat: ${error.message}`;
    if (reportError) throw error;
  }
}

async function refreshCatalog() {
  const data = await request('/api/bootstrap');
  saveBootstrapCache(data);
  state.products = data.products;
  state.customerGroups = data.customerGroups?.length ? data.customerGroups : state.customerGroups;
  state.business = data.business ?? state.business;
  state.deviceSettings = { ...state.deviceSettings, ...(data.deviceSettings ?? {}) };
  state.outlets = data.outlets ?? state.outlets;
  state.activeOutletId = data.activeOutletId ?? state.activeOutletId;
  state.promotions = data.promotions;
  state.customers = data.customers;
  state.suppliers = data.suppliers;
  state.locations = data.locations ?? state.locations;
  state.currentShift = data.currentShift;
  renderOutletSwitcher();
  renderProducts(el('product-search').value);
  renderProductTable();
  renderCustomerGroupControls();
  renderRelations();
  renderPromotionEditorOptions();
  renderPromotionList();
  renderShift();
  renderImportLocations();
  if (state.session.permissions.includes('catalog.manage')) await loadProductManagement();
}

function startDeferredBootstrapLoads() {
  const run = ++deferredBootstrapRun;
  const can = (permission) => state.session?.permissions?.includes(permission);
  const tasks = [
    ...(can('catalog.manage') ? [loadProductManagement] : []),
    ...(can('pos.sell') ? [loadHeldSales, loadCustomerAging] : []),
    ...(can('purchasing.view_cost') ? [loadPurchaseOrders, loadRestockPlanning, loadRecentSupplierReturns] : []),
    ...(can('inventory.manage') ? [loadInventory] : []),
    ...(can('report.view') ? [loadReport, loadCrmDashboard] : []),
    ...(can('promotion.manage') ? [loadPromotionManagement] : []),
    ...(can('finance.owner') ? [loadOwnerFinance] : []),
    ...(can('audit.view') ? [loadSyncReview, loadImportHistory] : []),
    ...(can('identity.manage') ? [loadBackupHistory, loadSettings, loadSystemHealth] : []),
    ...(can('workforce.self') ? [loadWorkforceOverview, loadApprovals] : []),
    ...(can('workforce.manage') ? [loadWorkforceActivity, loadWorkforceReconciliations] : [])
  ];
  setTimeout(async () => {
    let cursor = 0;
    const worker = async () => {
      while (run === deferredBootstrapRun && cursor < tasks.length) {
        const task = tasks[cursor++];
        await Promise.resolve().then(task).catch(() => {});
      }
    };
    await Promise.all(Array.from({length:Math.min(3,tasks.length)}, worker));
  }, 0);
}

function lastSyncStorageKey() {
  return `pos_last_manual_sync:${state.session?.user?.id ?? 'anonymous'}:${state.activeOutletId ?? 'default'}`;
}

function renderLastSync(value = localStorage.getItem(lastSyncStorageKey())) {
  const label = el('sync-last-time');
  if (!label) return;
  const occurredAt = value ? new Date(value) : null;
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) {
    label.textContent = 'Belum disinkronkan';
    label.removeAttribute('title');
    return;
  }
  label.textContent = `Terakhir ${new Intl.DateTimeFormat('id-ID', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(occurredAt).replace(',', '')}`;
  label.title = `Sinkron terakhir ${occurredAt.toLocaleString('id-ID')}`;
}

function recordLastSync(value = new Date().toISOString()) {
  localStorage.setItem(lastSyncStorageKey(), value);
  renderLastSync(value);
  return value;
}

async function synchronizeData() {
  if (!navigator.onLine) return toast('Perangkat sedang offline. Hubungkan internet lalu coba sinkronkan lagi.');
  const button = el('sync-now');
  const label = el('sync-last-time');
  const activeItem = document.querySelector('.feature-nav-item.active:not(.hidden)');
  const page = activeItem?.dataset.page ?? 'pos';
  const target = activeItem?.dataset.targetPage ?? page;
  button.disabled = true;
  button.classList.add('syncing');
  label.textContent = 'Menyinkronkan...';
  try {
    await refreshCatalog();
    await updateQuote();
    const tasks = [];
    if (target === 'stock' && state.session.permissions.includes('inventory.manage')) tasks.push(loadInventory());
    if (target === 'restock' && state.session.permissions.includes('purchasing.view_cost')) {
      tasks.push(loadPurchaseOrders(), loadRestockPlanning(), loadRecentSupplierReturns());
    }
    if (target === 'reports' && state.session.permissions.includes('report.view')) tasks.push(
      ['sales-products','sales-categories','sales-addons','stock-flow'].includes(state.reportView)?loadSalesAnalysis():loadReport()
    );
    if (target === 'users' && state.session.permissions.includes('identity.manage')) tasks.push(loadUsers());
    if (target === 'settings' && state.session.permissions.includes('identity.manage')) tasks.push(loadSettingsWorkspace());
    if (target === 'sync-review' && state.session.permissions.includes('audit.view')) tasks.push(loadSyncReview());
    if (['promotions', 'loyalty'].includes(target) && state.session.permissions.includes('promotion.manage')) tasks.push(loadPromotionManagement());
    if (target === 'customers' && state.session.permissions.includes('pos.sell')) tasks.push(loadCrmDashboard(), loadCustomerAging());
    if (target === 'imports' && state.session.permissions.includes('audit.view')) tasks.push(loadImportHistory());
    if (target === 'backups' && state.session.permissions.includes('identity.manage')) tasks.push(loadBackupHistory());
    if (target === 'pos' && state.session.permissions.includes('pos.sell')) tasks.push(loadHeldSales());
    if (multioutletPages.has(page)) tasks.push(loadMultiOutletWorkspace());
    if (accountingPages.has(page)) tasks.push(loadAccounting({ sync: true }));
    if (pilotPages.has(page) && page !== 'pilot-sop') tasks.push(loadPilotDashboard());
    if (page.startsWith('owner-') && state.session.permissions.includes('finance.owner')) tasks.push(loadOwnerFinance());
    if (page === 'workforce-schedule' || page === 'workforce-targets') tasks.push(loadWorkforceOverview());
    if (page === 'workforce-approvals') tasks.push(loadApprovals());
    if (page === 'workforce-activity' && state.session.permissions.includes('workforce.manage')) tasks.push(loadWorkforceActivity());
    if (page === 'workforce-reconciliation' && state.session.permissions.includes('workforce.manage')) tasks.push(loadWorkforceReconciliations());
    await Promise.all(tasks);
    recordLastSync();
    toast('Data terbaru berhasil disinkronkan.');
  } catch (error) {
    renderLastSync();
    toast(`Sinkronisasi gagal: ${error.message}`);
  } finally {
    button.disabled = false;
    button.classList.remove('syncing');
  }
}

function favoriteProductIds() {
  try { return new Set(JSON.parse(localStorage.getItem(`pos_favorites:${state.session?.user?.id ?? 'anonymous'}`) ?? '[]')); }
  catch { return new Set(); }
}

function saveFavoriteProductIds(ids) {
  localStorage.setItem(`pos_favorites:${state.session.user.id}`, JSON.stringify([...ids]));
}

function renderPosCategoryFilters() {
  const categories=[...new Set(state.products.map((product)=>product.category).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'id'));
  el('pos-category-filters').innerHTML=['',...categories].map((category)=>`<button class="category-filter ${state.posCategoryFilter===category?'active':''}" type="button" data-category="${escapeHtml(category)}">${escapeHtml(category||'Semua')}</button>`).join('');
}

function renderProducts(query = '') {
  const normalized = query.trim().toLowerCase();
  const favorites=favoriteProductIds();
  const list = state.products.filter((product) =>
    (!normalized || `${product.name} ${product.sku} ${product.units.map((unit) => unit.barcode).join(' ')}`.toLowerCase().includes(normalized))
    && (!state.posCategoryFilter || product.category===state.posCategoryFilter)
    && (!state.favoriteOnly || favorites.has(product.id))
  );
  const visible=list.slice(0,state.posProductLimit);
  renderPosCategoryFilters();
  el('favorite-filter').setAttribute('aria-pressed',String(state.favoriteOnly));
  el('product-grid').innerHTML = visible.map((product) => {
    const unit = sortedProductUnits(product)[0];
    const rule = product.priceRules.find((item) => item.customerGroupId === 'retail') ?? product.priceRules[0];
    const empty = Number(product.stockBase ?? 0) <= 0;
    return `<article class="product-card-shell"><button class="product-card ${empty ? 'out-of-stock' : ''}" data-product="${product.id}" data-unit="${unit.id}" ${empty ? 'disabled' : ''}>${productThumbnail(product)}<span class="product-list-copy"><span class="category">${escapeHtml(product.category)}</span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.sku)}</small></span><span class="product-list-meta"><strong>${money.format(rule?.unitPriceBase ?? 0)}</strong><small class="${empty?'stock-empty':''}">${empty ? 'STOK KOSONG' : `Stok ${Number(product.stockBase).toLocaleString('id-ID')} pcs`}</small></span></button><button class="favorite-product ${favorites.has(product.id)?'active':''}" type="button" data-favorite-product="${product.id}" aria-label="${favorites.has(product.id)?'Hapus dari':'Tambahkan ke'} favorit" aria-pressed="${favorites.has(product.id)}">★</button></article>`;
  }).join('') || '<div class="empty-state compact">Tidak ada produk untuk filter ini.</div>';
  if(list.length>visible.length)el('product-grid').insertAdjacentHTML('beforeend',`<div class="catalog-load-more"><small>Menampilkan ${visible.length.toLocaleString('id-ID')} dari ${list.length.toLocaleString('id-ID')} barang</small><button class="button secondary" type="button" data-product-load-more>Tampilkan 100 berikutnya</button></div>`);
  bindProductImageFallbacks(el('product-grid'));
  document.querySelectorAll('.product-card').forEach((button) => button.addEventListener('click', () => choosePosProduct(button.dataset.product)));
  document.querySelectorAll('.favorite-product').forEach((button)=>button.addEventListener('click',()=>{
    const ids=favoriteProductIds();if(ids.has(button.dataset.favoriteProduct))ids.delete(button.dataset.favoriteProduct);else ids.add(button.dataset.favoriteProduct);
    saveFavoriteProductIds(ids);renderProducts(el('product-search').value);
  }));
}

async function loadProductManagement() {
  if (productManagementPromise) return productManagementPromise;
  productManagementPromise=(async()=>{
    try {
      const data=await request('/api/products/manage');
      state.managedProducts=data.products??[];
    } catch {
      if(!state.managedProducts.length)state.managedProducts=state.products.map((product)=>({...product,active:true}));
    }
    renderProductTable();
    renderProductExportFilters();
  })().finally(()=>{productManagementPromise=null;});
  return productManagementPromise;
}

function productExportFilters(){return {category:el('export-product-category')?.value??'',brand:el('export-product-brand')?.value??'',status:el('export-product-status')?.value??'ALL',sort:el('export-product-sort')?.value??'SKU_ASC'};}

function renderProductExportFilters(){
  if(!el('export-product-category'))return;
  const products=state.managedProducts,categories=[...new Set(products.map((product)=>product.category).filter(Boolean))].sort(),brands=[...new Set(products.map((product)=>product.brand).filter(Boolean))].sort();
  const category=el('export-product-category').value,brand=el('export-product-brand').value;
  el('export-product-category').innerHTML=`<option value="">Semua kategori</option>${categories.map((value)=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`;
  el('export-product-brand').innerHTML=`<option value="">Semua merek</option>${brands.map((value)=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`;
  if(categories.includes(category))el('export-product-category').value=category;if(brands.includes(brand))el('export-product-brand').value=brand;
  updateProductExportCount();
}

function updateProductExportCount(){
  if(!el('export-product-count'))return;
  const kind=['PRODUCTS','PRODUCT_UNITS','PRODUCT_VARIANTS','PRODUCT_PRICES'].includes(el('import-kind')?.value)?el('import-kind').value:'PRODUCTS';
  const rows=kind==='PRODUCTS'?productExportRows(state.managedProducts,productExportFilters()):productExtensionExportRows(state.managedProducts,kind,productExportFilters());
  el('export-product-count').textContent=`${rows.length.toLocaleString('id-ID')} baris ${workbookTemplates[kind].sheet} akan diexport.`;
}

function exportProductsXlsx(){
  try{
    if(!window.XLSX)throw new Error('Komponen Excel belum siap. Muat ulang aplikasi.');
    const kind=['PRODUCTS','PRODUCT_UNITS','PRODUCT_VARIANTS','PRODUCT_PRICES'].includes(el('import-kind').value)?el('import-kind').value:'PRODUCTS';
    const {workbook,count}=createProductExportWorkbook(window.XLSX,state.managedProducts,productExportFilters(),kind);
    if(!count)throw new Error('Tidak ada barang yang cocok dengan filter export');
    const names={PRODUCTS:'barang',PRODUCT_UNITS:'satuan-barang',PRODUCT_VARIANTS:'varian-barang',PRODUCT_PRICES:'harga-pelanggan'};
    window.XLSX.writeFile(workbook,`${names[kind]}-kasir-nusa-${new Date().toISOString().slice(0,10)}.xlsx`,{compression:true});
    toast(`${count.toLocaleString('id-ID')} baris berhasil diexport`);
  }catch(error){toast(error.message);}
}

function customerGroup(groupId) {
  return state.customerGroups.find((group)=>group.id===groupId)??null;
}

function customerGroupName(groupId) {
  return groupId==='retail'?'Umum':customerGroup(groupId)?.name??groupId;
}

function customCustomerGroups() {
  return state.customerGroups.filter((group)=>group.id!=='retail'&&group.active!==false);
}

function setGroupSelectOptions(id,{includeAny=false}={}) {
  const select=el(id);if(!select)return;
  const previous=select.value;
  select.innerHTML=`${includeAny?'<option value="ANY">Semua pelanggan</option>':''}${state.customerGroups.map((group)=>`<option value="${escapeHtml(group.id)}">${escapeHtml(group.id==='retail'?'Umum':group.name)}</option>`).join('')}`;
  if([...select.options].some((option)=>option.value===previous))select.value=previous;
}

function renderCustomerGroupControls() {
  setGroupSelectOptions('customer-group');
  setGroupSelectOptions('customer-new-group');
  setGroupSelectOptions('outlet-price-group');
  setGroupSelectOptions('promo-customer-group',{includeAny:true});
  if(el('manage-customer-groups'))el('manage-customer-groups').classList.toggle('hidden',!['OWNER','ADMIN'].includes(state.session?.user?.role));
}

function productPrices(product) {
  const legacyTiers=product.priceRules.filter((rule)=>!rule.customerGroupId&&rule.minBaseQty>1);
  const tiersByGroup=Object.fromEntries(state.customerGroups.map((group)=>{
    const explicit=product.priceRules.filter((rule)=>rule.customerGroupId===group.id);
    const merged=[...explicit,...legacyTiers.filter((legacy)=>!explicit.some((rule)=>rule.minBaseQty===legacy.minBaseQty))]
      .map((rule)=>({minBaseQty:Number(rule.minBaseQty),unitPriceBase:Number(rule.unitPriceBase)}))
      .sort((a,b)=>a.minBaseQty-b.minBaseQty);
    if(!merged.some((rule)=>rule.minBaseQty===1))merged.unshift({minBaseQty:1,unitPriceBase:0});
    return [group.id,merged];
  }));
  const byGroup=Object.fromEntries(Object.entries(tiersByGroup).map(([groupId,tiers])=>[
    groupId,tiers.find((rule)=>rule.minBaseQty===1)?.unitPriceBase??0
  ]));
  return {retail:byGroup.retail??0,byGroup,tiersByGroup};
}

function renderProductTable() {
  const query=el('product-admin-search')?.value.trim().toLowerCase()??'';
  const status=el('product-admin-status')?.value??'ACTIVE';
  const all=state.managedProducts;
  const availableIds=new Set(all.map((product)=>product.id));
  for(const productId of state.selectedProductIds)if(!availableIds.has(productId))state.selectedProductIds.delete(productId);
  const list=all.filter((product)=>{
    const matches=!query||`${product.sku} ${product.name} ${product.brand??''} ${product.category} ${product.variantGroup??''} ${product.variantName??''} ${product.units.map((unit)=>unit.barcode??'').join(' ')}`.toLowerCase().includes(query);
    const statusMatch=status==='ALL'||(status==='ACTIVE'&&product.active)||(status==='INACTIVE'&&!product.active)||(status==='LOW_STOCK'&&product.active&&product.minimumStock>0&&product.stockBase<=product.minimumStock);
    return matches&&statusMatch;
  });
  const active=all.filter((product)=>product.active).length,inactive=all.length-active,low=all.filter((product)=>product.active&&product.minimumStock>0&&product.stockBase<=product.minimumStock).length;
  el('product-metrics').innerHTML=[['Total SKU',all.length],['Aktif dijual',active],['Nonaktif',inactive],['Stok menipis',low]].map(([label,value])=>`<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join('');
  const categories=[...new Set(all.map((product)=>product.category).filter(Boolean))].sort();
  const brands=[...new Set(all.map((product)=>product.brand).filter(Boolean))].sort();
  el('product-category-options').innerHTML=categories.map((value)=>`<option value="${escapeHtml(value)}">`).join('');
  el('product-brand-options').innerHTML=brands.map((value)=>`<option value="${escapeHtml(value)}">`).join('');
  const pageSize=100,totalPages=Math.max(1,Math.ceil(list.length/pageSize));
  state.productAdminPage=Math.min(Math.max(1,state.productAdminPage),totalPages);
  const pageStart=(state.productAdminPage-1)*pageSize;
  const visible=list.slice(pageStart,pageStart+pageSize);
  const allVisibleSelected=visible.length>0&&visible.every((product)=>state.selectedProductIds.has(product.id));
  if(state.productActionId&&!list.some((product)=>product.id===state.productActionId))state.productActionId=null;
  const canViewCost=state.session?.permissions?.includes('purchasing.view_cost')??false;
  const columnCount=canViewCost?12:11;
  el('product-table').innerHTML=list.length?`<table class="product-admin-table ${canViewCost?'cost-visible':''}"><thead><tr><th class="product-select-cell product-col-select"><input id="select-all-products" type="checkbox" aria-label="Pilih semua barang yang tampil" ${allVisibleSelected?'checked':''}></th><th class="product-col-sku">SKU</th><th class="product-col-barcode">Barcode</th><th class="product-col-name">Nama produk</th><th class="product-col-type">Tipe barang</th><th class="product-col-category">Kategori</th><th class="product-col-brand">Merek</th><th class="product-col-price">Harga umum</th>${canViewCost?'<th class="product-col-cost" title="Modal rata-rata tertimbang seluruh stok">Modal</th>':''}<th class="product-col-stock">Stok</th><th class="product-col-minimum">Min. stok</th><th class="product-col-status">Status</th></tr></thead><tbody>${visible.map((product)=>{
    const prices=productPrices(product);
    const variant=[product.variantGroup,product.variantName].filter(Boolean).join(' · ');
    const customPrices=customCustomerGroups().filter((group)=>prices.byGroup[group.id]>0).map((group)=>`${escapeHtml(group.name)} ${money.format(prices.byGroup[group.id])}`).join(' · ');
    const baseUnit=product.units.find((unit)=>Number(unit.factor)===1)??product.units[0]??{};
    const hasVariant=Boolean(variant);
    const hasMultipleUnits=product.units.length>1;
    const productType=hasVariant&&hasMultipleUnits?'Varian + Multisatuan':hasVariant?'Varian':hasMultipleUnits?'Multisatuan':'Default';
    const barcodeDetails=product.units.map((unit)=>unit.barcode).filter(Boolean).join(' · ');
    const actionsOpen=state.productActionId===product.id;
    const typedDetails=[
      hasVariant?`<div class="product-detail-fact"><small>Varian</small><strong>${escapeHtml(variant)}</strong></div>`:'',
      product.trackExpiry?'<div class="product-detail-fact"><small>Persediaan</small><strong>Pantau kedaluwarsa</strong></div>':''
    ].filter(Boolean).join('');
    const multiUnitDetails=hasMultipleUnits?`<div class="product-detail-units"><small>Multi-satuan</small><div>${product.units.map((unit)=>`<span title="${escapeHtml(unit.barcode||'Tanpa barcode')}"><strong>${escapeHtml(unit.name)}</strong> · isi ${Number(unit.factor).toLocaleString('id-ID')}${unit.barcode?` · <code>${escapeHtml(unit.barcode)}</code>`:''}</span>`).join('')}</div></div>`:'';
    const emptyTypedDetails=!typedDetails&&!multiUnitDetails?'<small class="product-detail-empty">Barang default tanpa varian atau satuan tambahan.</small>':'';
    return `<tr data-product-id="${product.id}" class="product-admin-row ${state.selectedProductIds.has(product.id)?'selected':''} ${actionsOpen?'actions-open':''}" tabindex="0" aria-expanded="${actionsOpen}" title="Tekan untuk melihat detail dan tindakan produk"><td class="product-select-cell product-col-select"><input class="select-product" type="checkbox" aria-label="Pilih ${escapeHtml(product.name)}" ${state.selectedProductIds.has(product.id)?'checked':''}></td><td class="product-code product-col-sku" title="${escapeHtml(product.sku)}">${escapeHtml(product.sku)}</td><td class="product-barcode-cell product-col-barcode" title="${escapeHtml(barcodeDetails||'Tanpa barcode')}">${escapeHtml(baseUnit.barcode||'-')}</td><td class="product-name-cell product-col-name" title="${escapeHtml(product.name)}"><strong>${escapeHtml(product.name)}</strong></td><td class="product-col-type"><span class="product-type-badge">${escapeHtml(productType)}</span></td><td class="product-col-category" title="${escapeHtml(product.category)}">${escapeHtml(product.category||'-')}</td><td class="product-col-brand" title="${escapeHtml(product.brand||'Tanpa merek')}">${escapeHtml(product.brand||'-')}</td><td class="product-col-price" title="${escapeHtml(customPrices||money.format(prices.retail))}"><strong>${money.format(prices.retail)}</strong></td>${canViewCost?`<td class="numeric-cell product-col-cost" title="Modal rata-rata tertimbang seluruh stok">${Number(product.averageCost)>0?money.format(product.averageCost):'-'}</td>`:''}<td class="numeric-cell product-col-stock"><strong>${product.stockBase}</strong></td><td class="numeric-cell product-col-minimum">${product.minimumStock||0}</td><td class="product-col-status"><span class="badge ${product.active?'ok':'danger'}">${product.active?'Aktif':'Nonaktif'}</span></td></tr>${actionsOpen?`<tr class="product-action-row product-detail-row" data-product-id="${product.id}"><td colspan="${columnCount}"><div class="product-detail-drawer"><div class="product-detail-content"><div class="product-detail-heading"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.sku)} · ${escapeHtml(productType)}</small></div>${typedDetails?`<div class="product-detail-facts">${typedDetails}</div>`:''}${multiUnitDetails}${emptyTypedDetails}</div><div class="product-detail-actions"><button class="button secondary edit-product" type="button">Edit produk</button><button class="button ${product.active?'danger-button':'secondary'} toggle-product" type="button" data-active="${!product.active}">${product.active?'Nonaktifkan':'Aktifkan'}</button></div></div></td></tr>`:''}`;
  }).join('')}</tbody></table><div class="product-table-pager"><small>Menampilkan ${(pageStart+1).toLocaleString('id-ID')}–${Math.min(pageStart+pageSize,list.length).toLocaleString('id-ID')} dari ${list.length.toLocaleString('id-ID')} barang</small><div><button class="button secondary" type="button" data-product-page="-1" ${state.productAdminPage===1?'disabled':''}>Sebelumnya</button><span>Halaman ${state.productAdminPage} / ${totalPages}</span><button class="button secondary" type="button" data-product-page="1" ${state.productAdminPage===totalPages?'disabled':''}>Berikutnya</button></div></div>`:'<div class="empty-state compact">Tidak ada produk yang cocok dengan filter.</div>';
  const selectAll=el('select-all-products');
  if(selectAll)selectAll.indeterminate=!allVisibleSelected&&visible.some((product)=>state.selectedProductIds.has(product.id));
  const selectedCount=state.selectedProductIds.size;
  el('selected-product-count').textContent=`${selectedCount.toLocaleString('id-ID')} barang dipilih`;
  el('delete-selected-products').disabled=selectedCount===0;
  el('print-selected-product-labels').disabled=selectedCount===0;
}

function selectedProductLabels(){
  return [...state.selectedProductIds].map((id)=>state.managedProducts.find((product)=>product.id===id)).filter(Boolean);
}

function productLabelBarcode(product,source='BARCODE'){
  if(source==='SKU')return normalizeCode128Text(product.sku);
  const unit=product.units.find((item)=>Number(item.factor)===1)??product.units[0];
  return normalizeCode128Text(unit?.barcode||product.sku);
}

function productLabelNumber(id,fallback,min,max){
  const raw=el(id).value.trim(),value=raw===''?fallback:Number(raw);
  return Math.min(max,Math.max(min,Number.isFinite(value)?value:fallback));
}

function productLabelConfig(){
  const size=labelSize(el('product-label-width').value,el('product-label-height').value);
  return {
    size,
    columns:productLabelNumber('product-label-columns',1,1,10),
    rows:productLabelNumber('product-label-rows',1,1,20),
    type:el('product-label-type').value,source:el('product-label-source').value,position:el('product-label-text-position').value,
    align:el('product-label-align').value.toLowerCase(),
    verticalAlign:el('product-label-vertical-align').value,
    printerWidth:productLabelNumber('product-label-printer-width',58,58,80),
    marginX:productLabelNumber('product-label-margin-x',.5,0,10),
    marginY:productLabelNumber('product-label-margin-y',.25,0,10),
    offsetX:productLabelNumber('product-label-offset-x',0,-10,10),
    offsetY:productLabelNumber('product-label-offset-y',0,-10,10),
    nameSize:productLabelNumber('product-label-name-size',1.6,1,12),
    priceSize:productLabelNumber('product-label-price-size',2.2,1,12),
    codeSize:productLabelNumber('product-label-code-size',1.2,1,8),
    barcodeHeight:productLabelNumber('product-label-barcode-height',4.8,3,40),
    moduleWidth:productLabelNumber('product-label-module-width',.26,.2,.6),
    gap:productLabelNumber('product-label-gap',0,0,10),
    showName:el('product-label-show-name').checked,showPrice:el('product-label-show-price').checked,
    showCode:el('product-label-show-code').checked,showSku:el('product-label-show-sku').checked
  };
}

function renderProductLabelSheet(target,{preview=false}={}){
  const products=selectedProductLabels(),config=productLabelConfig(),errors=[];
  const totalRequested=products.reduce((sum,product)=>sum+(state.productLabelCopies.get(product.id)??1),0);
  let remainingPreview=Math.min(6,config.columns*config.rows);
  const labels=products.flatMap((product)=>{
    const requested=state.productLabelCopies.get(product.id)??1;
    const copies=preview?Math.min(requested,Math.max(0,remainingPreview)):requested;
    remainingPreview-=copies;
    return Array.from({length:copies},()=>{
    const barcode=productLabelBarcode(product,config.source),price=productPrices(product).retail;
    const label={name:product.name,sku:product.sku,barcode,priceText:money.format(price)};
    if(preview){
      try{
        const canvas=renderEscPosProductLabelCanvas(label,{...config,width:config.size.width,height:config.size.height,paperWidth:config.printerWidth});
        return `<article class="product-print-label raster-label" style="--label-width:${config.size.width}mm;--label-height:${config.size.height}mm"><img class="product-label-raster-preview" src="${canvas.toDataURL('image/png')}" alt="Pratinjau raster ${escapeHtml(product.name)}"></article>`;
      }catch(error){
        errors.push(`${product.name}: ${error.message}`);
        return `<article class="product-print-label raster-label" style="--label-width:${config.size.width}mm;--label-height:${config.size.height}mm"><span class="barcode-invalid">Periksa ukuran label</span></article>`;
      }
    }
    let graphic='',barcodeWidth=config.size.width-1.2;
    try{
      graphic=barcodeSvg(barcode,{height:42,type:config.type});
      barcodeWidth=Math.min(config.size.width-1.2,barcodeModuleCount(barcode,config.type)*config.moduleWidth);
    }
    catch(error){errors.push(`${product.name}: ${error.message}`);graphic='<span class="barcode-invalid">Barcode tidak valid</span>';}
    const text=`${config.showName?`<strong>${escapeHtml(product.name)}</strong>`:''}${config.showPrice?`<b>${money.format(price)}</b>`:''}`;
    const code=config.showCode||config.showSku?`<small>${config.showSku?`${escapeHtml(product.sku)}${config.showCode?' · ':''}`:''}${config.showCode?escapeHtml(barcode):''}</small>`:'';
    const itemAlign=config.align==='left'?'start':config.align==='right'?'end':'center';
    return `<article class="product-print-label ${config.position==='BELOW'?'text-below':''}" style="--label-width:${config.size.width}mm;--label-height:${config.size.height}mm;--label-align:${config.align};--label-item-align:${itemAlign};--name-size:${config.nameSize}mm;--price-size:${config.priceSize}mm;--code-size:${config.codeSize}mm;--barcode-height:${Math.min(config.barcodeHeight,config.size.height-2)}mm;--barcode-width:${barcodeWidth}mm"><div class="product-label-text">${text}</div><div class="product-label-graphic">${graphic}${code}</div></article>`;
  })});
  const perPage=config.columns*config.rows,pages=[];
  for(let index=0;index<labels.length;index+=perPage)pages.push(labels.slice(index,index+perPage));
  if(preview)el('product-label-preview-note').textContent=`${config.size.width} × ${config.size.height} mm · jarak +${config.gap} mm · printer ${config.printerWidth} mm · geser ${config.offsetX}/${config.offsetY} mm · ${totalRequested.toLocaleString('id-ID')} label`;
  const pageWidth=config.size.width*config.columns,pageHeight=(config.size.height+config.gap)*config.rows;
  target.innerHTML=`${preview?'':`<style>@page{size:${pageWidth}mm ${pageHeight}mm;margin:0}</style>`}<div class="product-label-sheet ${preview?'is-preview':''}" style="--label-columns:${config.columns};--label-gap:${config.gap}mm;--page-width:${pageWidth}mm;--page-height:${pageHeight}mm">${pages.map((page)=>`<section class="product-label-page">${page.join('')}</section>`).join('')}</div>`;
  target.dataset.errors=String(errors.length);
  if(preview){
    const fallback=products.filter((product)=>!product.units.some((unit)=>unit.barcode)).length;
    el('product-label-warning').innerHTML=[
      fallback?`<span><strong>${fallback} barang belum memiliki barcode.</strong> SKU dipakai sebagai pengganti.</span>`:'',
      errors.length?`<span><strong>${errors.length} label belum muat atau barcodenya tidak valid.</strong> ${escapeHtml(errors[0])}</span>`:'',
      config.offsetX||config.offsetY?`<span><strong>Kalibrasi posisi aktif.</strong> Mendatar ${config.offsetX} mm, vertikal ${config.offsetY} mm. Nilai negatif menggeser ke kiri/atas.</span>`:''
    ].filter(Boolean).join('');
  }
  return {count:labels.length,errors};
}

function openProductLabelDialog(){
  const products=selectedProductLabels();if(!products.length)return;
  el('product-label-printer-width').value=String(Number(state.deviceSettings.paperWidth)===58?58:80);
  state.productLabelCopies=new Map(products.map((product)=>[product.id,state.productLabelCopies.get(product.id)??1]));
  el('product-label-summary').textContent=`${products.length.toLocaleString('id-ID')} barang dipilih. Barcode satuan dasar dipakai bila tersedia.`;
  renderProductLabelCopyEditor();
  renderProductLabelSheet(el('product-label-preview'),{preview:true});
  el('product-label-dialog').showModal();
}

function renderProductLabelCopyEditor(){
  const products=selectedProductLabels();
  el('product-label-copy-list').innerHTML=products.map((product)=>`<label class="product-label-copy-row" data-product-id="${escapeHtml(product.id)}"><span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.sku)} · stok outlet ${productLabelStock(product).toLocaleString('id-ID')} pcs</small></span><input class="product-label-item-copies" type="number" min="0" max="9999" step="1" value="${state.productLabelCopies.get(product.id)??1}" aria-label="Jumlah label ${escapeHtml(product.name)}"></label>`).join('');
}

function productLabelStock(product){
  return Number(state.products.find((item)=>item.id===product.id)?.stockBase??product.stockBase??0);
}

function setProductLabelCopies(mode){
  for(const product of selectedProductLabels()){
    const copies=mode==='STOCK'?Math.min(9999,Math.max(0,Math.floor(productLabelStock(product)))):1;
    state.productLabelCopies.set(product.id,copies);
  }
  renderProductLabelCopyEditor();
  renderProductLabelSheet(el('product-label-preview'),{preview:true});
}

async function printProductLabels(event){
  event.preventDefault();
  const button=event.submitter??event.currentTarget.querySelector('[type="submit"]');
  const result=renderProductLabelSheet(el('product-label-print-root'));
  if(!result.count)return toast('Pilih minimal satu barang.');
  if(result.errors.length){el('product-label-print-root').replaceChildren();return toast('Periksa jenis barcode: ada kode yang tidak valid.');}
  const nativeAndroid=/KasirNusaAndroid\//.test(navigator.userAgent);
  const nativeDirectPrint=typeof window.KasirNusaAndroid?.printBase64==='function';
  if(nativeAndroid&&!nativeDirectPrint){
    el('product-label-print-root').replaceChildren();
    return toast('Perbarui aplikasi Kasir Nusa Android untuk mencetak label Bluetooth.');
  }
  if(!nativeAndroid){
    el('product-label-dialog').close();
    window.print();
    return;
  }
  const config=productLabelConfig();
  const labels=selectedProductLabels().flatMap((product)=>Array.from(
    {length:state.productLabelCopies.get(product.id)??1},
    ()=>({
      name:product.name,sku:product.sku,
      barcode:productLabelBarcode(product,config.source),
      priceText:money.format(productPrices(product).retail)
    })
  ));
  button.disabled=true;button.textContent='Mengirim label…';
  try{
    if(!printerSelected())await selectBluetoothPrinter();
    await printEscPosProductLabels(labels,{...config,width:config.size.width,height:config.size.height,paperWidth:config.printerWidth});
    el('product-label-dialog').close();
    toast(`${labels.length.toLocaleString('id-ID')} label berhasil dikirim langsung ke printer Bluetooth.`);
  }catch(error){
    toast(error.message||'Label gagal dikirim ke printer.');
  }finally{
    button.disabled=false;button.textContent='Cetak label';
    el('product-label-print-root').replaceChildren();
    renderPrinterStatus();
  }
}

function applyProductLabelPreset(){
  const preset=el('product-label-preset').value;
  const values={NAME_PRICE:[true,true,true,false],BARCODE_CODE:[false,false,true,false],BARCODE_ONLY:[false,false,false,false]}[preset];
  if(values){
    [el('product-label-show-name').checked,el('product-label-show-price').checked,el('product-label-show-code').checked,el('product-label-show-sku').checked]=values;
  }
  renderProductLabelSheet(el('product-label-preview'),{preview:true});
}

function renderRelations() {
  const selectedId=el('customer-select').value;
  el('customer-select').innerHTML = '<option value="" data-group="retail">Pelanggan umum</option>' + state.customers.map((customer) => `<option value="${customer.id}" data-group="${customer.group_id}">${customer.name}${customer.group_id!=='retail'?` · ${customerGroupName(customer.group_id)}`:''}${customer.account_balance>0?` · piutang ${money.format(customer.account_balance)}`:''}</option>`).join('');
  if(state.customers.some((customer)=>customer.id===selectedId))el('customer-select').value=selectedId;
  else el('customer-select').value='';
  const query=(el('customer-account-search')?.value??'').trim().toLowerCase();
  const customers=state.customers.filter((customer)=>!query||`${customer.name} ${customer.code} ${customer.phone??''}`.toLowerCase().includes(query));
  const totalBalance=state.customers.reduce((sum,customer)=>sum+Number(customer.account_balance??0),0);
  const overdue=state.customers.reduce((sum,customer)=>sum+Number(customer.overdue_balance??0),0);
  el('customer-account-metrics').innerHTML=[['Pelanggan aktif',state.customers.length],['Total piutang',money.format(totalBalance)],['Sudah jatuh tempo',money.format(overdue)],['Fasilitas kredit',state.customers.filter((customer)=>customer.credit_enabled).length]].map(([label,value])=>`<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join('');
  const crm=state.crmDashboard?.metrics;
  el('crm-metrics').innerHTML=crm?[['Pelanggan bertransaksi',crm.active],['Pelanggan tidak aktif',crm.inactive],['Nilai pelanggan',money.format(crm.lifetimeValue)],['Poin beredar',Number(crm.pointsOutstanding).toLocaleString('id-ID')]].map(([label,value])=>`<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join(''):'';
  el('customer-list').innerHTML=customers.length?`<div class="customer-table-wrap"><table class="customer-directory-table"><thead><tr><th>Nama pelanggan</th><th>Tipe</th><th>Level</th><th>Kode</th><th>Telepon</th><th>Poin</th><th>Total transaksi</th><th>Transaksi terakhir</th><th>Piutang</th><th>Jatuh tempo</th><th>Sisa plafon</th><th>Status kredit</th><th>Tindakan</th></tr></thead><tbody>${customers.map((customer)=>{
    const balance=Number(customer.account_balance??0),overdueBalance=Number(customer.overdue_balance??0);
    const tier=state.loyalty.tiers.find((item)=>item.id===customer.tier_id);
    return `<tr data-customer-id="${escapeHtml(customer.id)}"><td><strong>${escapeHtml(customer.name)}</strong></td><td><span class="badge warning">${escapeHtml(customerGroupName(customer.group_id))}</span></td><td>${tier?`<span class="badge info">${escapeHtml(tier.name)}</span>`:'-'}</td><td><code>${escapeHtml(customer.code)}</code></td><td>${escapeHtml(customer.phone??'-')}</td><td class="customer-number">${Number(customer.loyalty_points??0).toLocaleString('id-ID')}</td><td class="customer-money">${money.format(customer.lifetime_spend??0)}</td><td>${customer.last_purchase_at?new Date(customer.last_purchase_at).toLocaleDateString('id-ID'):'-'}</td><td class="customer-money">${money.format(balance)}</td><td class="customer-money ${overdueBalance>0?'negative':''}">${money.format(overdueBalance)}</td><td class="customer-money">${money.format(customer.available_credit??0)}</td><td><span class="status-badge ${customer.credit_enabled?'approved':'inactive'}">${customer.credit_enabled?'Aktif':'Tidak aktif'}</span></td><td><div class="customer-table-actions"><button class="button secondary customer-statement" type="button">Detail</button>${['OWNER','ADMIN'].includes(state.session.user.role)?'<button class="button secondary edit-customer" type="button">Edit</button>':''}</div></td></tr>`;
  }).join('')}</tbody></table></div>`:'<div class="empty-state compact">Pelanggan tidak ditemukan.</div>';
  const canSeeSuppliers = state.session.permissions.includes('purchasing.receive');
  el('supplier-panel').classList.toggle('hidden', !canSeeSuppliers);
  if (canSeeSuppliers) el('supplier-list').innerHTML = state.suppliers.map((supplier) => `<div class="relation-item supplier-account-row" data-supplier-id="${escapeHtml(supplier.id)}"><span><strong>${escapeHtml(supplier.name)}</strong><br><small>${escapeHtml(supplier.code)} · ${escapeHtml(supplier.phone??'tanpa telepon')}</small></span><span><strong>${money.format(supplier.payable_balance??0)}</strong><br><small class="${supplier.overdue_balance>0?'negative':''}">${supplier.overdue_balance>0?`${money.format(supplier.overdue_balance)} jatuh tempo`:`${supplier.open_bill_count??0} faktur terbuka`}</small></span><button class="button secondary supplier-statement" type="button">Lihat hutang</button></div>`).join('');
  const selected = el('customer-select').selectedOptions[0];
  el('customer-group').value = selected?.dataset.group ?? 'retail';
  syncCustomerSearchLabel();
}

function selectedPosCustomer() {
  return state.customers.find((customer) => customer.id === el('customer-select').value) ?? null;
}

function syncCustomerSearchLabel() {
  const customer = selectedPosCustomer();
  if (el('customer-search') && document.activeElement !== el('customer-search')) {
    el('customer-search').value = customer?.name ?? '';
  }
  if (el('pos-member-label')) el('pos-member-label').textContent = customer?.name ?? 'Pelanggan';
  if (el('pos-member-status')) el('pos-member-status').textContent = customer ? 'Pelanggan dipilih' : 'Pelanggan umum';
  if (el('open-pos-customer')) {
    el('open-pos-customer').classList.toggle('member-selected', Boolean(customer));
    el('open-pos-customer').title = customer?.name ?? 'Pelanggan';
    el('open-pos-customer').setAttribute('aria-label', customer ? `Pelanggan: ${customer.name}` : 'Pilih atau tambah pelanggan');
  }
  el('clear-pos-customer')?.classList.toggle('hidden', !customer);
  const notePanel=el('customer-service-note');
  const note=String(customer?.notes??'').trim();
  notePanel.textContent=note;
  notePanel.classList.toggle('hidden',!note);
}

function matchingCustomers(query = '') {
  const normalized = String(query).trim().toLowerCase();
  const digits = normalized.replace(/\D/g, '');
  return state.customers.filter((customer) => {
    if (!normalized) return true;
    const haystack = `${customer.name} ${customer.code ?? ''} ${customer.phone ?? ''}`.toLowerCase();
    const phoneDigits = String(customer.phone ?? '').replace(/\D/g, '');
    return haystack.includes(normalized) || (digits.length >= 3 && phoneDigits.includes(digits));
  }).slice(0, 12);
}

function renderCustomerSearchResults(query = '') {
  const panel = el('customer-search-results');
  const customers = matchingCustomers(query);
  panel.innerHTML = `<button type="button" class="customer-search-option general-customer-option" data-customer-id=""><span><strong>Pelanggan umum</strong><small>Transaksi tanpa data pelanggan</small></span><span class="badge neutral">UMUM</span></button>` + (customers.map((customer) => `<button type="button" class="customer-search-option" data-customer-id="${escapeHtml(customer.id)}"><span><strong>${escapeHtml(customer.name)}</strong><small>${escapeHtml(customer.code ?? '')} · ${escapeHtml(customer.phone ?? 'tanpa telepon')}</small></span>${customer.group_id!=='retail'?`<span class="badge warning">${escapeHtml(customerGroupName(customer.group_id))}</span>`:''}</button>`).join('')
    || '<div class="empty-state compact">Pelanggan tidak ditemukan. Gunakan tombol tambah pelanggan.</div>');
  panel.classList.remove('hidden');
}

async function selectPosCustomer(customerId) {
  state.voucherCode='';el('voucher-code').value='';
  if (!customerId) {
    invalidateSaleAuthorization();
    el('customer-select').value = '';
    el('customer-group').value = 'retail';
    el('customer-search').value = '';
    el('customer-search-results').classList.add('hidden');
    syncCustomerSearchLabel();
    await updateQuote();
    if (el('pos-customer-dialog')?.open) el('pos-customer-dialog').close();
    return;
  }
  const customer = state.customers.find((item) => item.id === customerId);
  if (!customer) return;
  invalidateSaleAuthorization();
  el('customer-select').value = customer.id;
  el('customer-group').value = customer.group_id ?? 'retail';
  el('customer-search').value = customer.name;
  el('customer-search-results').classList.add('hidden');
  syncCustomerSearchLabel();
  await updateQuote();
  if (el('pos-customer-dialog')?.open) el('pos-customer-dialog').close();
}

function defaultPricePolicyRules(){
  const groups=customCustomerGroups();
  const member=groups.find((group)=>group.id==='member'||group.name.toLowerCase().includes('member'));
  const wholesale=groups.find((group)=>group.id==='wholesale'||group.name.toLowerCase().includes('grosir'));
  const rules=[];
  if(member)rules.push({customerGroupId:member.id,minBaseQty:1,discountAmount:500});
  if(wholesale){
    rules.push({customerGroupId:wholesale.id,minBaseQty:1,discountAmount:500});
    rules.push({customerGroupId:wholesale.id,minBaseQty:3,discountAmount:1000});
  }
  if(!rules.length&&groups[0])rules.push({customerGroupId:groups[0].id,minBaseQty:1,discountAmount:500});
  return rules;
}

function renderPricePolicyRules(){
  const options=customCustomerGroups().map((group)=>`<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('');
  el('price-policy-rules').innerHTML=state.pricePolicyRules.map((rule,index)=>`<div class="price-policy-rule" data-index="${index}">
    <label>Tipe pelanggan<select class="policy-rule-group">${options}</select></label>
    <label>Minimal pembelian<input class="policy-rule-qty" type="number" min="1" step="1" value="${Number(rule.minBaseQty)||1}" required></label>
    <label>Kurangi Harga Umum<input class="policy-rule-discount" type="number" min="1" step="any" value="${Number(rule.discountAmount)||500}" required></label>
    <button class="icon-button remove-price-policy-rule" type="button" aria-label="Hapus aturan" ${state.pricePolicyRules.length===1?'disabled':''}>×</button>
  </div>`).join('');
  [...el('price-policy-rules').querySelectorAll('.policy-rule-group')].forEach((select,index)=>{select.value=state.pricePolicyRules[index].customerGroupId;});
}

function readPricePolicyInput(){
  const rules=[...document.querySelectorAll('.price-policy-rule')].map((row)=>({
    customerGroupId:row.querySelector('.policy-rule-group').value,
    minBaseQty:Number(row.querySelector('.policy-rule-qty').value),
    discountAmount:Number(row.querySelector('.policy-rule-discount').value)
  }));
  state.pricePolicyRules=rules;
  return {
    minProfit:Number(el('price-policy-min-profit').value),
    category:el('price-policy-category').value,
    brand:el('price-policy-brand').value,
    rules
  };
}

function invalidatePricePolicyPreview(){
  state.pricePolicyPreview=null;
  el('apply-price-policy').disabled=true;
  el('price-policy-preview').classList.add('hidden');
}

function renderPricePolicyPreview(preview){
  const {summary,rows}=preview;
  el('price-policy-metrics').innerHTML=[
    ['Produk diperiksa',summary.products],['Semua aman',summary.fullySafe],
    ['Sebagian aman',summary.partiallySafe],['Perlu naik harga',summary.recommendations]
  ].map(([label,value])=>`<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join('');
  el('price-policy-results').innerHTML=rows.length?rows.slice(0,100).map((row)=>{
    const safe=row.results.filter((result)=>result.safe);
    const rejected=row.results.filter((result)=>!result.safe);
    const status=row.safeCount===preview.policy.rules.length?'Aman':row.safeCount>0?'Sebagian':'Ditolak';
    return `<article class="price-policy-result"><div><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.sku)} · ${row.costKnown?`Modal tertinggi ${money.format(row.cost)}`:'Modal belum tersedia'} · Umum ${money.format(row.retailPrice)}</small></div><span class="badge ${status==='Aman'?'ok':status==='Sebagian'?'warning':'danger'}">${status}</span><div class="price-policy-result-rules">${safe.map((rule)=>`<span>${escapeHtml(customerGroupName(rule.customerGroupId))} min. ${rule.minBaseQty}: <strong>${money.format(rule.proposedPrice)}</strong></span>`).join('')}${rejected.map((rule)=>`<span class="rejected">${escapeHtml(customerGroupName(rule.customerGroupId))} min. ${rule.minBaseQty}: ${rule.reason==='NO_COST'?'modal belum tersedia':rule.reason==='LOSS'?'rugi':rule.reason==='BEP'?'BEP':'di bawah laba minimum'}</span>`).join('')}</div>${row.recommendedIncrease>0?`<small class="price-recommendation">Saran: naikkan Harga Umum minimal ${money.format(row.recommendedIncrease)} agar tingkat pertama aman.</small>`:''}</article>`;
  }).join(''):'<div class="empty-state compact">Tidak ada produk aktif pada cakupan ini.</div>';
  el('price-policy-preview').classList.remove('hidden');
  el('apply-price-policy').disabled=!rows.length;
}

async function openPricePolicy(){
  el('price-policy-error').textContent='';invalidatePricePolicyPreview();
  const categories=[...new Set(state.managedProducts.map((product)=>product.category).filter(Boolean))].sort();
  const brands=[...new Set(state.managedProducts.map((product)=>product.brand).filter(Boolean))].sort();
  el('price-policy-category').innerHTML='<option value="">Semua kategori</option>'+categories.map((value)=>`<option>${escapeHtml(value)}</option>`).join('');
  el('price-policy-brand').innerHTML='<option value="">Semua merek</option>'+brands.map((value)=>`<option>${escapeHtml(value)}</option>`).join('');
  try{
    const data=await request('/api/price-policy');
    const policy=data.policy;
    state.pricePolicyRules=policy?.rules?.length?policy.rules:defaultPricePolicyRules();
    el('price-policy-min-profit').value=policy?.minProfit??500;
    el('price-policy-category').value=policy?.category??'';
    el('price-policy-brand').value=policy?.brand??'';
    renderPricePolicyRules();el('price-policy-dialog').showModal();
  }catch(error){toast(error.message);}
}

async function previewPricePolicy(){
  el('price-policy-error').textContent='';
  try{
    const preview=await request('/api/price-policy/preview',{method:'POST',body:JSON.stringify(readPricePolicyInput())});
    state.pricePolicyPreview=preview;renderPricePolicyPreview(preview);
  }catch(error){el('price-policy-error').textContent=error.message;invalidatePricePolicyPreview();}
}

async function applyPricePolicy(event){
  event.preventDefault();el('price-policy-error').textContent='';
  const button=el('apply-price-policy');button.disabled=true;button.textContent='Menerapkan...';
  try{
    const result=await request('/api/price-policy/apply',{method:'POST',body:JSON.stringify(readPricePolicyInput())});
    toast(`${result.safeRules} harga aman diterapkan; ${result.skippedRules} aturan BEP/rugi dilewati.`);
    el('price-policy-dialog').close();await refreshCatalog();
  }catch(error){el('price-policy-error').textContent=error.message;}
  finally{button.textContent='Terapkan harga aman';button.disabled=!state.pricePolicyPreview;}
}

function openPosCustomerPicker() {
  const customer = selectedPosCustomer();
  el('customer-search').value = customer?.name ?? '';
  renderCustomerSearchResults('');
  el('pos-customer-dialog').showModal();
  requestAnimationFrame(() => {
    el('customer-search').focus();
    el('customer-search').select();
  });
}

function resetPosCustomer() {
  el('customer-select').value = '';
  el('customer-group').value = 'retail';
  el('customer-search').value = '';
  el('customer-search-results').classList.add('hidden');
  syncCustomerSearchLabel();
  state.voucherCode='';el('voucher-code').value='';
}

async function loadCustomerAging(){
  try{
    state.customerAging=await request('/api/customer-credit/aging');
    const buckets=state.customerAging.buckets??{};
    el('customer-aging-buckets').innerHTML=[['Belum jatuh tempo',buckets.current??0,'safe'],['Terlambat 1–30 hari',buckets.days1To30??0,'notice'],['Terlambat 31–60 hari',buckets.days31To60??0,'warning'],['Lebih dari 60 hari',buckets.daysOver60??0,'danger']].map(([label,value,level])=>`<div class="${level}"><span>${label}</span><strong>${money.format(value)}</strong></div>`).join('');
  }catch(error){el('customer-aging-buckets').innerHTML=`<small class="muted">${escapeHtml(error.message)}</small>`;}
}

async function loadCrmDashboard(){
  try{state.crmDashboard=await request('/api/crm/dashboard');renderRelations();}
  catch(error){el('crm-metrics').innerHTML=`<small class="muted">${escapeHtml(error.message)}</small>`;}
}

function renderProductUnitEditor(){
  el('product-units-editor').innerHTML=state.productUnitsDraft.map((unit,index)=>`<div class="product-unit-row" data-index="${index}"><label>Nama satuan<input class="unit-name" value="${escapeHtml(unit.name)}" placeholder="pcs / lusin / karton" required></label><label>Isi dalam pcs<input class="unit-factor" type="number" min="1" step="any" value="${unit.factor}" required></label><label>Barcode<input class="unit-barcode" value="${escapeHtml(unit.barcode??'')}" placeholder="Scan atau ketik"></label><button class="icon-button remove-product-unit" type="button" aria-label="Hapus satuan" ${state.productUnitsDraft.length===1?'disabled':''}>×</button></div>`).join('');
}

function renderProductPhotoPreview(url=''){
  el('new-image-preview').innerHTML=url
    ?`<img src="${escapeHtml(url)}" alt="Pratinjau foto produk">`
    :'<span>Belum ada foto</span>';
  const image=el('new-image-preview').querySelector('img');
  if(image)image.addEventListener('error',()=>{el('new-image-preview').innerHTML='<span>Foto tidak dapat dibuka</span>';},{once:true});
}

async function productImageDataFromFile(file){
  if(!file?.type?.match(/^image\/(png|jpeg|webp)$/))throw new Error('Pilih foto PNG, JPEG, atau WebP.');
  if(file.size>12_000_000)throw new Error('Foto maksimal 12 MB sebelum diperkecil.');
  const source=URL.createObjectURL(file);
  try{
    const image=await new Promise((resolve,reject)=>{
      const node=new Image();node.onload=()=>resolve(node);node.onerror=()=>reject(new Error('Foto tidak dapat dibuka.'));node.src=source;
    });
    let scale=Math.min(1,900/image.width,900/image.height),result='';
    for(let attempt=0;attempt<4;attempt+=1){
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
      const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
      result=canvas.toDataURL('image/jpeg',.84-attempt*.08);
      if(result.length<=1_150_000)return result;
      scale*=.78;
    }
    throw new Error('Foto masih terlalu besar. Pilih foto lain.');
  }finally{URL.revokeObjectURL(source);}
}

function defaultProductPriceTiers(product=null){
  if(product)return productPrices(product).tiersByGroup;
  return Object.fromEntries(state.customerGroups.filter((group)=>group.active!==false).map((group)=>[group.id,[{minBaseQty:1,unitPriceBase:''}]]));
}

function readProductPriceTierDraft(){
  const draft={};
  document.querySelectorAll('.product-price-tier-card').forEach((card)=>{
    draft[card.dataset.groupId]=[...card.querySelectorAll('.product-price-tier-row')].map((row)=>({
      minBaseQty:Number(row.querySelector('.price-tier-min').value),
      unitPriceBase:row.querySelector('.price-tier-amount').value
    }));
  });
  state.productPriceTiers=draft;
  return draft;
}

function renderProductPriceTierEditor(){
  el('product-price-tiers').innerHTML=state.customerGroups.filter((group)=>group.active!==false).map((group)=>{
    const tiers=(state.productPriceTiers[group.id]??[{minBaseQty:1,unitPriceBase:''}]).sort((a,b)=>Number(a.minBaseQty)-Number(b.minBaseQty));
    const isRetail=group.id==='retail';
    return `<section class="product-price-tier-card" data-group-id="${escapeHtml(group.id)}">
      <header><div><strong>${escapeHtml(isRetail?'Harga Umum':group.name)}</strong><small>${isRetail?'Harga dasar untuk pelanggan umum':`Harga khusus ${escapeHtml(group.name)}; boleh mengikuti Umum`}</small></div><button class="button secondary add-product-price-tier" type="button">+ Tingkat harga</button></header>
      <div class="product-price-tier-list">${tiers.map((tier,index)=>`<div class="product-price-tier-row">
        <label>Minimal pembelian<input class="price-tier-min" type="number" min="${index===0?1:2}" step="1" value="${Number(tier.minBaseQty)||1}" ${index===0?'readonly':''} required></label>
        <label>Harga / pcs<input ${isRetail&&index===0?'id="new-retail-price"':''} class="price-tier-amount" type="number" min="1" step="any" value="${Number(tier.unitPriceBase)>0?Number(tier.unitPriceBase):''}" placeholder="${isRetail?'Masukkan harga':'Gunakan harga Umum'}" ${isRetail||index>0?'required':''}></label>
        ${index===0?'<span class="price-tier-base">Harga mulai 1 pcs</span>':'<button class="icon-button remove-product-price-tier" type="button" aria-label="Hapus tingkat harga">×</button>'}
      </div>`).join('')}</div>
    </section>`;
  }).join('');
}

function openProductEditor(productId=null){
  const product=productId?state.managedProducts.find((item)=>item.id===productId):null;
  el('product-form').reset();el('product-error').textContent='';
  el('edit-product-id').value=product?.id??'';
  el('product-dialog-eyebrow').textContent=product?'EDIT PRODUK':'PRODUK BARU';
  el('product-dialog-title').textContent=product?'Ubah produk':'Tambah produk';
  el('new-sku').value=product?.sku??'';el('new-name').value=product?.name??'';
  el('new-category').value=product?.category??'';el('new-brand').value=product?.brand??'';
  el('new-image-url').value=product?.imageUrl??'';
  state.productImageFile=null;state.productImagePreviewUrl=product?.imageUrl??'';
  renderProductPhotoPreview(state.productImagePreviewUrl);
  el('new-variant-group').value=product?.variantGroup??'';el('new-variant-name').value=product?.variantName??'';
  el('new-min-stock').value=product?.minimumStock??0;el('new-track-expiry').checked=Boolean(product?.trackExpiry);
  state.productPriceTiers=defaultProductPriceTiers(product);renderProductPriceTierEditor();
  state.productUnitsDraft=product?product.units.map((unit)=>({...unit})):[{id:null,name:'pcs',factor:1,barcode:''}];
  renderProductUnitEditor();el('product-dialog').showModal();
}

function productPayload(){
  const prices=Object.entries(readProductPriceTierDraft()).flatMap(([customerGroupId,tiers])=>tiers
    .filter((tier)=>Number(tier.unitPriceBase)>0)
    .map((tier)=>({customerGroupId,minBaseQty:Number(tier.minBaseQty),unitPriceBase:Number(tier.unitPriceBase)})));
  return {
    id:el('edit-product-id').value||null,sku:el('new-sku').value,name:el('new-name').value,category:el('new-category').value,
    brand:el('new-brand').value,imageUrl:el('new-image-url').value,variantGroup:el('new-variant-group').value,variantName:el('new-variant-name').value,
    minimumStock:Number(el('new-min-stock').value),trackExpiry:el('new-track-expiry').checked,
    retailPrice:Number(el('new-retail-price').value),prices,
    units:state.productUnitsDraft
  };
}

async function saveProduct(event) {
  event.preventDefault();el('product-error').textContent='';
  const payload=productPayload(),button=el('save-product-button');button.disabled=true;
  try{
    if(state.productImageFile){
      button.textContent='Mengunggah foto...';
      const media=await request('/api/media/product-image',{method:'POST',body:JSON.stringify({
        dataUrl:await productImageDataFromFile(state.productImageFile)
      })});
      payload.imageUrl=media.imageUrl;
    }
    button.textContent='Menyimpan...';
    const path=payload.id?`/api/products/${payload.id}`:'/api/products';
    const product=await request(path,{method:payload.id?'PUT':'POST',body:JSON.stringify(payload)});
    toast(`${product.name} berhasil ${payload.id?'diperbarui':'ditambahkan'}`);el('product-dialog').close();
    await refreshCatalog();await renderRestock();if(state.session.permissions.includes('inventory.manage'))await loadInventory();
  }catch(error){el('product-error').textContent=error.message;}finally{button.disabled=false;button.textContent='Simpan produk';}
}

async function toggleProductStatus(productId,active){
  const product=state.managedProducts.find((item)=>item.id===productId);if(!product)return;
  if(!active&&!confirm(`Nonaktifkan ${product.name}? Produk tidak akan muncul di kasir, tetapi histori tetap tersimpan.`))return;
  try{
    await request(`/api/products/${productId}/status`,{method:'POST',body:JSON.stringify({active})});
    toast(active?'Produk kembali diaktifkan':'Produk dinonaktifkan');await refreshCatalog();
  }catch(error){toast(error.message);}
}

async function deleteSelectedProducts(){
  const productIds=[...state.selectedProductIds];
  if(!productIds.length)return;
  const names=productIds.map((id)=>state.managedProducts.find((product)=>product.id===id)?.name).filter(Boolean);
  const sample=names.slice(0,3).join(', ');
  const remainder=names.length>3?` dan ${names.length-3} lainnya`:'';
  if(!confirm(`Hapus ${productIds.length} barang terpilih (${sample}${remainder})?\n\nBarang yang belum pernah dipakai akan dihapus permanen. Barang yang sudah memiliki stok atau riwayat transaksi akan diarsipkan agar laporan lama tetap aman.`))return;
  const button=el('delete-selected-products');button.disabled=true;button.textContent='Menghapus…';
  try{
    const result=await request('/api/products/bulk-delete',{method:'POST',body:JSON.stringify({productIds})});
    state.selectedProductIds.clear();
    const deleted=Number(result.deleted??0),archived=Number(result.archived??0),blocked=Number(result.blocked??0);
    toast(`${deleted} barang dihapus${archived?`, ${archived} barang berhistori diarsipkan`:''}${blocked?`, ${blocked} masih dipakai PO aktif`:''}`);
    await refreshCatalog();
    if(state.session.permissions.includes('inventory.manage'))await loadInventory();
  }catch(error){toast(error.message);}
  finally{button.textContent='Hapus barang';button.disabled=state.selectedProductIds.size===0;}
}

function openCustomerEditor(customerId=null,source='relations'){
  const customer=customerId?state.customers.find((item)=>item.id===customerId):null;
  state.customerEditorSource=source;
  el('customer-form').reset();el('customer-form-error').textContent='';el('edit-customer-id').value=customer?.id??'';
  el('customer-dialog-title').textContent=customer?'Ubah pelanggan':source==='pos'?'Tambah pelanggan dari kasir':'Tambah pelanggan';
  el('customer-name').value=customer?.name??'';el('customer-phone').value=customer?.phone??'';
  el('customer-phone').required=source==='pos';
  el('customer-email').value=customer?.email??'';el('customer-address').value=customer?.address??'';
  el('customer-birth-date').value=customer?.birth_date??'';el('customer-whatsapp-consent').checked=Boolean(customer?.whatsapp_consent);
  el('customer-notes').value=customer?.notes??'';el('customer-new-group').value=customer?.group_id??'retail';
  el('customer-credit-enabled').checked=Boolean(customer?.credit_enabled);
  el('customer-credit-limit').value=customer?.credit_limit??0;el('customer-credit-days').value=customer?.credit_days??30;
  el('customer-credit-enabled').disabled=!['OWNER','ADMIN'].includes(state.session.user.role);
  el('customer-credit-fields').classList.toggle('hidden',!el('customer-credit-enabled').checked);
  el('customer-dialog').showModal();
}

async function saveCustomer(event) {
  event.preventDefault();const id=el('edit-customer-id').value,button=event.currentTarget.querySelector('[type="submit"]');button.disabled=true;
  const payload={name:el('customer-name').value,phone:el('customer-phone').value,email:el('customer-email').value,address:el('customer-address').value,notes:el('customer-notes').value,groupId:el('customer-new-group').value,birthDate:el('customer-birth-date').value||null,whatsappConsent:el('customer-whatsapp-consent').checked,creditEnabled:el('customer-credit-enabled').checked,creditLimit:Number(el('customer-credit-limit').value||0),creditDays:Number(el('customer-credit-days').value||0),active:true};
  try{
    const customer=await request(id?`/api/customers/${id}`:'/api/customers',{method:id?'PUT':'POST',body:JSON.stringify(payload)});
    const selectForSale=!id&&state.customerEditorSource==='pos';
    toast(`${customer.name} berhasil disimpan`);el('customer-dialog').close();await refreshCatalog();
    if(selectForSale)await selectPosCustomer(customer.id);
  }catch(error){el('customer-form-error').textContent=error.message;}finally{button.disabled=false;}
}

async function openCustomerStatement(customerId){
  try{
    const [data,pointData]=await Promise.all([
      request(`/api/customers/${customerId}/statement`),
      request(`/api/customers/${customerId}/loyalty`)
    ]);state.activeCustomerStatement=data;
    const customer=data.customer;el('statement-customer-name').textContent=customer.name;
    el('statement-summary').innerHTML=`<div><span>Saldo poin</span><strong>${Number(customer.loyalty_points??0).toLocaleString('id-ID')}</strong></div><div><span>Saldo piutang</span><strong>${money.format(customer.account_balance)}</strong></div><div><span>Sisa plafon</span><strong>${money.format(customer.available_credit)}</strong></div><div class="${customer.overdue_balance>0?'overdue':''}"><span>Jatuh tempo</span><strong>${money.format(customer.overdue_balance)}</strong></div>`;
    const pointLabels={EARN:'Poin dari transaksi',REDEEM:'Poin digunakan',ADJUST:'Penyesuaian / impor',EXPIRE:'Poin kedaluwarsa',REVERSAL:'Pembalikan transaksi'};
    el('statement-points').innerHTML=pointData.entries.length
      ? reportTable(['Waktu','Struk','Keterangan','Akun','Poin','Saldo setelah mutasi'],pointData.entries.map((entry)=>`<tr><td>${new Date(entry.occurred_at).toLocaleString('id-ID')}</td><td>${escapeHtml(entry.receiptNo??'-')}</td><td><strong>${escapeHtml(pointLabels[entry.entry_type]??entry.entry_type)}</strong><br><small>${escapeHtml(entry.note??'')}</small></td><td>${escapeHtml(entry.actor?.display_name??'-')}</td><td class="${entry.points>=0?'positive':'negative'}"><strong>${entry.points>=0?'+':''}${Number(entry.points).toLocaleString('id-ID')}</strong></td><td><strong>${Number(entry.balanceAfter).toLocaleString('id-ID')}</strong></td></tr>`))
      : '<div class="empty-state compact">Belum ada mutasi poin untuk pelanggan ini.</div>';
    el('customer-payment-amount').value=customer.account_balance||'';el('customer-payment-amount').max=customer.account_balance;
    el('customer-payment-form').classList.toggle('hidden',!(customer.account_balance>0));
    el('statement-invoices').innerHTML=reportTable(['Faktur','Tanggal','Jatuh tempo','Kredit','Terbayar','Sisa'],data.invoices.filter((invoice)=>invoice.outstanding>0).map((invoice)=>`<tr class="${invoice.overdue?'overdue-row':''}"><td><strong>${escapeHtml(invoice.receipt_no)}</strong></td><td>${new Date(invoice.occurred_at).toLocaleDateString('id-ID')}</td><td>${invoice.due_on?new Date(`${invoice.due_on}T00:00:00`).toLocaleDateString('id-ID'):'-'}</td><td>${money.format(invoice.creditAmount)}</td><td>${money.format(invoice.paidAmount)}</td><td><strong>${money.format(invoice.outstanding)}</strong></td></tr>`));
    const typeLabels={SALE_CREDIT:'Penjualan kredit',PAYMENT:'Pembayaran',RETURN_CREDIT:'Retur mengurangi piutang',OPENING_BALANCE:'Saldo awal',ADJUSTMENT:'Penyesuaian'};
    el('statement-entries').innerHTML=reportTable(['Waktu','Dokumen','Keterangan','Mutasi','Saldo'],data.entries.map((entry)=>`<tr><td>${new Date(entry.occurred_at).toLocaleString('id-ID')}</td><td>${escapeHtml(entry.document_no??'-')}</td><td>${escapeHtml(typeLabels[entry.entry_type]??entry.entry_type)}</td><td class="${entry.amount>0?'negative':'positive'}">${entry.amount>0?'+':'−'}${money.format(Math.abs(entry.amount))}</td><td><strong>${money.format(entry.balanceAfter)}</strong></td></tr>`));
    el('customer-payment-error').textContent='';el('customer-statement-dialog').showModal();
  }catch(error){toast(error.message);}
}

async function recordCustomerPayment(event){
  event.preventDefault();const customer=state.activeCustomerStatement?.customer;if(!customer)return;
  try{
    const result=await request('/api/customer-payments',{method:'POST',headers:{'idempotency-key':crypto.randomUUID()},body:JSON.stringify({customerId:customer.id,shiftId:state.currentShift?.id,amount:Number(el('customer-payment-amount').value),method:el('customer-payment-method').value,reference:el('customer-payment-reference').value,note:el('customer-payment-note').value})});
    toast(`Pembayaran ${result.receiptNo} berhasil`);el('customer-statement-dialog').close();await refreshCatalog();await loadCustomerAging();await openCustomerStatement(customer.id);
  }catch(error){el('customer-payment-error').textContent=error.message;}
}

async function saveSupplier() {
  try {
    const supplier = await request('/api/suppliers', { method: 'POST', body: JSON.stringify({ name: el('supplier-name').value, phone: el('supplier-phone').value, address: el('supplier-address').value }) });
    toast(`${supplier.name} berhasil disimpan`); el('supplier-name').value = ''; el('supplier-phone').value = ''; el('supplier-address').value = ''; await refreshCatalog(); await renderRestock();
  } catch (error) { toast(error.message); }
}

async function openSupplierStatement(supplierId){
  try{
    const data=await request(`/api/suppliers/${supplierId}/statement`);state.activeSupplierStatement=data;const supplier=data.supplier;
    el('statement-supplier-name').textContent=supplier.name;
    el('supplier-statement-summary').innerHTML=`<div><span>Total hutang</span><strong>${money.format(supplier.payable_balance)}</strong></div><div class="${supplier.overdue_balance>0?'overdue':''}"><span>Jatuh tempo</span><strong>${money.format(supplier.overdue_balance)}</strong></div><div><span>Faktur terbuka</span><strong>${supplier.open_bill_count}</strong></div>`;
    el('supplier-payment-amount').value=supplier.payable_balance||'';el('supplier-payment-amount').max=supplier.payable_balance;
    el('supplier-payment-form').classList.toggle('hidden',!(supplier.payable_balance>0));
    el('supplier-statement-bills').innerHTML=reportTable(['Faktur','Tanggal','Jatuh tempo','Nilai','Retur kredit','Terbayar','Sisa'],data.bills.filter((bill)=>bill.outstanding>0).map((bill)=>`<tr><td><strong>${escapeHtml(bill.document_no)}</strong></td><td>${new Date(bill.occurred_at).toLocaleDateString('id-ID')}</td><td>${bill.due_on?new Date(`${bill.due_on}T00:00:00`).toLocaleDateString('id-ID'):'-'}</td><td>${money.format(bill.originalAmount)}</td><td>${money.format(bill.returnCredit)}</td><td>${money.format(bill.paidAmount)}</td><td><strong>${money.format(bill.outstanding)}</strong></td></tr>`));
    el('supplier-statement-entries').innerHTML=reportTable(['Waktu','Dokumen','Jenis','Mutasi'],data.entries.map((entry)=>`<tr><td>${new Date(entry.occurred_at).toLocaleString('id-ID')}</td><td>${escapeHtml(entry.document_no??'-')}</td><td>${escapeHtml(entry.entry_type)}</td><td class="${entry.amount>0?'negative':'positive'}">${entry.amount>0?'+':'−'}${money.format(Math.abs(entry.amount))}</td></tr>`));
    el('supplier-payment-error').textContent='';el('supplier-statement-dialog').showModal();
  }catch(error){toast(error.message);}
}

async function recordSupplierPayment(event){
  event.preventDefault();const supplier=state.activeSupplierStatement?.supplier;if(!supplier)return;
  try{
    const result=await request('/api/supplier-payments',{method:'POST',headers:{'idempotency-key':crypto.randomUUID()},body:JSON.stringify({supplierId:supplier.id,shiftId:state.currentShift?.id,amount:Number(el('supplier-payment-amount').value),method:el('supplier-payment-method').value,reference:el('supplier-payment-reference').value,note:el('supplier-payment-note').value})});
    toast(`Pembayaran ${result.paymentNo} berhasil`);el('supplier-statement-dialog').close();await refreshCatalog();await openSupplierStatement(supplier.id);
  }catch(error){el('supplier-payment-error').textContent=error.message;}
}

const importAliases = {
  PRODUCTS: { no_barang_sku:'sku',sku:'sku',nama_barang:'name',nama:'name',kategori:'category',merek:'brand',satuan_terkecil:'baseUnit',satuan_dasar:'baseUnit',barcode_satuan_terkecil:'baseBarcode',barcode_satuan_dasar:'baseBarcode',barcode_dasar:'baseBarcode',harga_umum:'retailPrice',harga_ecer:'retailPrice',harga_grosir:'wholesalePrice',min_qty_grosir:'tierQty',harga_per_pcs_grosir:'tierPrice',satuan_besar:'bulkUnit',isi_dalam_pcs:'bulkFactor',isi_satuan_besar:'bulkFactor',barcode_satuan_besar:'bulkBarcode',stok_awal:'openingQty',modal_per_pcs:'openingCost',modal_per_satuan_dasar:'openingCost',modal_awal:'openingCost',nomor_batch:'batchNo',tanggal_exp:'expiresOn',stok_minimum:'minimumStock',pantau_exp:'trackExpiry' },
  PRODUCT_UNITS: { no_barang_sku:'sku',sku:'sku',nama_satuan:'unitName',satuan:'unitName',isi_dalam_satuan_dasar:'factor',isi:'factor',barcode:'barcode' },
  PRODUCT_VARIANTS: { no_barang_sku:'sku',sku:'sku',kelompok_varian:'variantGroup',nama_varian:'variantName' },
  PRODUCT_PRICES: { no_barang_sku:'sku',sku:'sku',tipe_pelanggan:'customerGroup',tipe_harga:'customerGroup',minimal_pembelian:'minQty',min_qty:'minQty',harga_per_satuan_dasar:'unitPrice',harga:'unitPrice' },
  CUSTOMERS: { kode:'code',nama:'name',telepon:'phone',kelompok:'groupId' },
  SUPPLIERS: { kode:'code',nama:'name',telepon:'phone',alamat:'address' }
};

function parseCsv(text) {
  const source = text.replace(/^\uFEFF/,'');
  const firstLine = source.split(/\r?\n/,1)[0] ?? '';
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows = []; let row = [], cell = '', quoted = false;
  for (let index=0; index<source.length; index+=1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index+1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === delimiter && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index+1] === '\n') index += 1;
      row.push(cell.trim()); cell = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else cell += character;
  }
  row.push(cell.trim());
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}

function renderImportLocations() {
  if (!el('import-location')) return;
  el('import-location').innerHTML = state.locations.map((location) => `<option value="${location.id}">${escapeHtml(location.name)} · ${location.kind === 'WAREHOUSE' ? 'Gudang' : 'Toko'}</option>`).join('');
  const store = state.locations.find((location) => location.kind === 'STORE');
  if (store) el('import-location').value = store.id;
  el('import-location-label').classList.toggle('hidden', !['PRODUCTS','KASPIN_FIFO'].includes(el('import-kind').value));
}

function downloadImportTemplate() {
  try{
    const kind=el('import-kind').value,template=workbookTemplates[kind];
    if(!window.XLSX)throw new Error('Komponen Excel belum siap. Muat ulang aplikasi.');
    window.XLSX.writeFile(createTemplateWorkbook(window.XLSX,kind),template.file,{compression:true});
  }catch(error){toast(error.message);}
}

function syncImportKindUi() {
  const kind=el('import-kind').value,template=workbookTemplates[kind];
  const fifo=kind==='KASPIN_FIFO';
  const sales=kind==='KASPIN_SALES';
  renderImportLocations();
  if(template){
    el('download-import-template').textContent=`Unduh template ${template.sheet}`;
    el('export-products-xlsx').textContent=`Export ${template.sheet}`;
  }
  el('download-import-template').classList.toggle('hidden',fifo||sales||state.productImportMode==='UPDATE_ONLY');
  el('export-products-xlsx').classList.toggle('hidden',!['PRODUCTS','PRODUCT_UNITS','PRODUCT_VARIANTS','PRODUCT_PRICES'].includes(kind));
  el('import-capital-file-zone').classList.toggle('hidden',!(fifo||sales));
  el('import-file-title').textContent=fifo?'Pilih Transaksi Pembelian Kaspin':sales?'Pilih Laporan Penjualan Barang bulanan':'Pilih file Excel';
  el('import-secondary-file-title').textContent=sales?'Pilih Laporan Data Penjualan':'Pilih Laporan Modal';
  el('import-location-help').textContent=fifo?'Jumlah stok tidak ditambah; lokasi ini hanya dipakai untuk menyusun sisa lapisan modal FIFO.':'Stok awal hanya untuk produk yang belum pernah bertransaksi.';
  syncImportSourceUi();
  updateProductExportCount();
}

function syncImportSourceUi(){
  const kind=el('import-kind').value;
  const supported=(state.productImportMode==='CREATE_ONLY'&&kind==='PRODUCTS')||
    (state.productImportMode==='UPDATE_ONLY'&&['PRODUCT_UNITS','PRODUCT_VARIANTS','PRODUCT_PRICES'].includes(kind));
  el('import-source-options').classList.toggle('hidden',!supported||['KASPIN_FIFO','KASPIN_SALES'].includes(kind));
  el('kaspin-barcode-option').classList.toggle('hidden',!supported||kind!=='PRODUCTS'||el('import-source').value==='NUSA');
}

function syncProductImportModeUi(){
  const mode=state.productImportMode;
  const createOnly=mode==='CREATE_ONLY',updateOnly=mode==='UPDATE_ONLY';
  document.querySelectorAll('.import-create-only').forEach((node)=>node.classList.toggle('hidden',updateOnly));
  document.querySelectorAll('.import-update-only').forEach((node)=>node.classList.toggle('hidden',!updateOnly));
  el('import-kind-label').classList.toggle('hidden',mode!=='GENERAL');
  el('download-import-template').classList.toggle('hidden',updateOnly||['KASPIN_FIFO','KASPIN_SALES'].includes(el('import-kind').value));
  const kind=el('import-kind').value,template=workbookTemplates[kind];
  el('import-location-label').classList.toggle('hidden',!['PRODUCTS','KASPIN_FIFO'].includes(kind)||updateOnly);
  syncImportSourceUi();
  if(createOnly){
    el('import-page-eyebrow').textContent='PRODUK BARU';
    el('import-page-title').textContent='Import produk baru';
    el('import-page-description').textContent='Tambahkan barang baru dari Excel tanpa mengubah produk yang sudah tersimpan.';
    el('import-control-title').textContent='Upload file produk baru';
    el('import-control-description').textContent='SKU boleh dikosongkan agar dibuat otomatis. SKU yang sudah ada akan ditolak.';
  }else if(updateOnly){
    const extension=kind!=='PRODUCTS';
    el('import-page-eyebrow').textContent=extension?'TIPE PRODUK':'EDIT PRODUK';
    el('import-page-title').textContent=extension?`Export / import ${template?.sheet??'tipe produk'}`:'Edit produk massal';
    el('import-page-description').textContent=extension?'Kelola data tambahan untuk produk yang sudah terdaftar.':'Export produk yang dipilih, edit di Excel, kemudian upload kembali.';
    el('import-control-title').textContent=extension?`Upload ${template?.sheet??'data produk'}`:'Upload hasil edit produk';
    el('import-control-description').textContent='SKU wajib dipertahankan dan hanya produk yang sudah ada yang dapat diperbarui.';
  }else{
    el('import-page-eyebrow').textContent='DATA MASSAL';
    el('import-page-title').textContent='Export dan import Excel';
    el('import-page-description').textContent='Pilih jenis data yang ingin diproses.';
    el('import-control-title').textContent='Upload file Excel';
    el('import-control-description').textContent='Periksa isi file sebelum menyimpannya.';
  }
}

async function openProductImportWorkspace(kind,{mode='CREATE_ONLY'}={}) {
  if(!workbookTemplates[kind])return;
  el('product-data-types-dialog').close();
  state.productImportMode=mode;
  showPage('imports');
  el('import-kind').value=kind;
  syncImportKindUi();
  syncProductImportModeUi();
  resetImportPreview(mode==='UPDATE_ONLY'?`Export ${workbookTemplates[kind].sheet}, edit datanya, lalu upload kembali.`:`Gunakan template ${workbookTemplates[kind].sheet}, lalu pilih file yang sudah diisi.`);
  if(state.session.permissions.includes('catalog.manage'))await loadProductManagement();
  requestAnimationFrame(()=>document.querySelector('#page-imports .page-title')?.scrollIntoView({behavior:'smooth',block:'start'}));
}

function resetImportPreview(message = 'Pilih file untuk melihat data sebelum disimpan.') {
  state.importDraft = null;
  state.importSourceReport = null;
  el('commit-import').disabled = true;
  el('import-validity').className = 'pill';
  el('import-validity').textContent = 'Belum diperiksa';
  el('import-metrics').innerHTML = '';
  el('import-errors').innerHTML = '';
  el('import-preview').innerHTML = `<div class="empty-state compact">${escapeHtml(message)}</div>`;
}

function mapCsvRows(kind, matrix) {
  if (matrix.length < 2) throw new Error('File hanya berisi judul kolom tanpa data');
  const aliases = importAliases[kind];
  const headers = matrix[0].map((header) => String(header).trim().toLowerCase().replaceAll(' ','_'));
  const mappedHeaders = headers.map((header) => aliases[header] ?? null);
  const requiredByKind={
    PRODUCTS:['name','retailPrice'],PRODUCT_UNITS:['sku','unitName','factor'],
    PRODUCT_VARIANTS:['sku','variantGroup','variantName'],PRODUCT_PRICES:['sku','customerGroup','minQty','unitPrice'],
    CUSTOMERS:['code','name'],SUPPLIERS:['code','name']
  };
  const required = requiredByKind[kind]??[];
  const missing = required.filter((field) => !mappedHeaders.includes(field));
  if (missing.length) throw new Error('Susunan kolom tidak cocok. Gunakan file contoh yang disediakan.');
  return matrix.slice(1).map((cells) => Object.fromEntries(mappedHeaders.map((field,index) => [field,cells[index] ?? '']).filter(([field]) => field)));
}

function renderImportSourceReport(report){
  if(!report)return '';
  const typeSummary=Object.entries(report.types??{}).map(([type,count])=>`${type}: ${count}`).join(' · ');
  const notes=[];
  if(report.skipped)notes.push(`${report.skipped} baris dilewati: ${report.issues.slice(0,3).map((issue)=>`baris ${issue.row} (${issue.message})`).join('; ')}`);
  if(report.deferred)notes.push(`${report.deferred} induk varian/multisatuan belum diimpor dari file ini dan menunggu file detail tipe produk Kaspin.`);
  if(report.detailedTypeRows)notes.push(`${report.detailedTypeRows} barang bertipe selain Default dibuat sebagai barang utama dahulu; detail varian/multisatuan memerlukan file tipe produk Kaspin.`);
  if(report.serviceRows)notes.push(`${report.serviceRows} barang bertanda jasa/tanpa batas stok dibawa sebagai produk dengan stok sesuai file.`);
  const subject=report.fileType??'Barang';
  const fifoSummary=report.purchaseLines?` · ${report.receipts} transaksi · ${report.purchaseLines} baris pembelian · ${report.capitalLines} baris modal`:'';
  const salesSummary=report.salesLines?` · ${report.receipts} struk · ${report.salesLines} baris barang`:'';
  return `<div class="import-source-report ${notes.length?'warning':''}"><strong>Export Kasir Pintar ${escapeHtml(subject)} terdeteksi · sheet ${escapeHtml(report.sheetName)}</strong><p>${report.mapped} dari ${report.total} baris siap diperiksa${fifoSummary}${salesSummary}${typeSummary?` · ${escapeHtml(typeSummary)}`:''}</p>${notes.map((note)=>`<p>${escapeHtml(note)}</p>`).join('')}</div>`;
}

function renderImportPreview(preview,sourceReport=null) {
  const summary = preview.summary ?? { total: preview.rows.length, create: 0, update: 0, error: preview.errors.length };
  el('import-metrics').innerHTML = [
    ['Total baris',summary.total],['Data baru',summary.create],['Diperbarui',summary.update],['Kesalahan',summary.error]
  ].map(([label,value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join('');
  el('import-validity').className = `pill ${preview.valid ? 'success' : ''}`;
  el('import-validity').textContent = preview.valid ? 'Siap disimpan' : 'Perlu diperbaiki';
  el('import-errors').innerHTML = `${renderImportSourceReport(sourceReport)}${preview.warnings?.length ? `<div class="import-source-report warning"><strong>${preview.warnings.length} baris dilewati tanpa menggagalkan impor</strong>${preview.warnings.slice(0,12).map((warning)=>`<p>${escapeHtml(warning.message)}</p>`).join('')}</div>`:''}${preview.errors.length ? `<div class="import-error-list"><strong>${preview.errors.length} hal perlu diperbaiki</strong>${preview.errors.slice(0,20).map((error) => `<p>Baris ${error.row || '—'} · ${escapeHtml(error.message)}</p>`).join('')}</div>` : ''}`;
  const keysByKind={
    PRODUCTS:['sku','name','baseUnit','retailPrice','openingQty','minimumStock','trackExpiry'],
    PRODUCT_UNITS:['sku','unitName','factor','unitPriceTotal','barcode'],
    PRODUCT_VARIANTS:['sku','variantGroup','variantName'],
    PRODUCT_PRICES:['sku','customerGroup','minQty','unitPrice'],
    KASPIN_FIFO:['transactionCode','occurredAt','productCode','productName','quantity','unitCost'],
    KASPIN_SALES:['transactionCode','occurredAt','productCode','productName','quantity','lineGross','grandTotal'],
    CUSTOMERS:['code','name','phone','email','groupId','loyaltyPoints'],SUPPLIERS:['code','name','phone','address']
  };
  const keys=keysByKind[preview.kind]??[];
  const labels = { sku:'No. barang / SKU',name:'Nama',baseUnit:'Satuan dasar',retailPrice:'Harga umum',openingQty:'Stok awal',minimumStock:'Stok minimum',trackExpiry:'Pantau EXP',unitName:'Nama satuan',factor:'Isi satuan dasar',unitPriceTotal:'Harga per satuan',barcode:'Barcode',variantGroup:'Kelompok varian',variantName:'Nama varian',customerGroup:'Tipe pelanggan',minQty:'Minimal beli',unitPrice:'Harga / satuan dasar',code:'Kode',phone:'Telepon',email:'Email',groupId:'Tipe pelanggan',loyaltyPoints:'Poin',address:'Alamat',transactionCode:'Transaksi',occurredAt:'Tanggal',productCode:'Kode barang',productName:'Nama barang',quantity:'Jumlah',unitCost:'Modal / pcs',lineGross:'Total barang',grandTotal:'Total struk' };
  el('import-preview').innerHTML = `<table><thead><tr><th>Baris</th>${keys.map((key) => `<th>${labels[key]}</th>`).join('')}</tr></thead><tbody>${preview.rows.slice(0,50).map((row,index) => `<tr><td>${index+2}</td>${keys.map((key) => `<td>${escapeHtml(row[key] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>${preview.rows.length>50?'<p class="muted import-more">Menampilkan 50 baris pertama.</p>':''}`;
  el('commit-import').disabled = !preview.valid;
  el('import-message').textContent = preview.valid ? `${summary.total} baris sudah lolos pemeriksaan dan belum disimpan.` : 'Perbaiki file sesuai pesan, lalu pilih kembali file tersebut.';
}

async function inspectImportFile() {
  const file = el('import-file').files[0];
  if (!file) return resetImportPreview();
  el('import-file-name').textContent = file.name;
  el('import-message').textContent = 'Memeriksa isi file…';
  el('commit-import').disabled = true;
  try {
    const kind = el('import-kind').value;
    const capitalFile=el('import-capital-file').files[0];
    if(kind==='KASPIN_FIFO'&&!capitalFile)throw new Error('Pilih juga file Laporan_Modal.xlsx.');
    if(kind==='KASPIN_SALES'&&!capitalFile)throw new Error('Pilih juga file Laporan Data Penjualan yang memuat ID Struk.');
    const isCsv=file.name.toLowerCase().endsWith('.csv');
    if(!isCsv&&!window.XLSX)throw new Error('Komponen Excel belum siap. Muat ulang aplikasi.');
    const source=el('import-source')?.value??'NUSA';
    const buffer=isCsv?null:await file.arrayBuffer();
    const kaspin=kind==='KASPIN_FIFO'
      ?parseKaspinFifoWorkbooks(window.XLSX,buffer,await capitalFile.arrayBuffer())
      :kind==='KASPIN_SALES'
      ?parseKaspinSalesWorkbooks(window.XLSX,buffer,await capitalFile.arrayBuffer())
      :!isCsv&&source!=='NUSA'
      ?(kind==='PRODUCTS'
        ?parseKaspinProductWorkbook(window.XLSX,buffer,{useCodeAsBarcode:el('kaspin-code-as-barcode').checked})
        :kind==='CUSTOMERS'
          ?parseKaspinCustomerWorkbook(window.XLSX,buffer)
          :parseKaspinProductExtensionWorkbook(window.XLSX,buffer,kind))
      :null;
    if(kind==='KASPIN_FIFO'&&!kaspin)throw new Error('File tidak cocok. Pilih Transaksi_Pembelian dan Laporan_Modal dari Kasir Pintar.');
    if(kind==='KASPIN_SALES'&&!kaspin)throw new Error('File tidak cocok. Pilih Laporan Penjualan Barang bulanan dan Laporan Data Penjualan dari Kasir Pintar.');
    if(source==='KASPIN'&&!kaspin)throw new Error('File ini bukan export Kasir Pintar yang sesuai dengan jenis data yang dipilih.');
    const matrix=kaspin?null:(isCsv?parseCsv(await file.text()):workbookMatrix(window.XLSX,buffer,kind));
    const rows=kaspin?.rows??mapCsvRows(kind,matrix);
    if(!rows.length)throw new Error(kaspin?.report?.issues?.[0]?.message??'Tidak ada baris yang dapat diimpor.');
    state.importSourceReport=kaspin?.report??null;
    const input = { kind, mode:state.productImportMode, source:kaspin?.report?.source??source, locationId: ['PRODUCTS','KASPIN_FIFO'].includes(kind) ? el('import-location').value : null, rows,capitalRows:kaspin?.capitalRows??[] };
    const preview = await request('/api/imports/preview', { method:'POST', body:JSON.stringify(input) });
    state.importDraft = { ...input, rows: preview.rows,capitalRows:preview.capitalRows??[], fileName: `${file.name}${capitalFile?` + ${capitalFile.name}`:''}`, idempotencyKey: crypto.randomUUID(), valid: preview.valid };
    renderImportPreview(preview,state.importSourceReport);
  } catch (error) {
    resetImportPreview(error.message);
    el('import-message').textContent = error.message;
  }
}

async function commitImport() {
  if (!state.importDraft?.valid) return;
  const button = el('commit-import'); button.disabled = true; button.textContent = 'Menyimpan data…';
  try {
    const result = await request('/api/imports/commit', {
      method:'POST', headers:{ 'idempotency-key':state.importDraft.idempotencyKey },
      body:JSON.stringify(state.importDraft)
    });
    const linkedReceipts=Number(result.reconciliation?.linkedReceipts??0);
    toast(linkedReceipts
      ? `Impor selesai dan ${linkedReceipts.toLocaleString('id-ID')} struk lama terhubung ke pelanggan`
      : `Impor selesai: ${result.created} baru, ${result.updated} diperbarui`);
    el('import-file').value = ''; el('import-file-name').textContent = 'Belum ada file dipilih';
    el('import-capital-file').value='';el('import-capital-file-name').textContent='Belum ada file dipilih';
    resetImportPreview(linkedReceipts
      ? `Impor berhasil. ${linkedReceipts.toLocaleString('id-ID')} struk lama sudah masuk ke nilai transaksi pelanggan.`
      : 'Impor berhasil. Anda dapat memilih file berikutnya.');
    try{
      await refreshCatalog();
      if (state.session.permissions.includes('inventory.manage')) await loadInventory();
      await loadImportHistory();
    }catch(refreshError){
      console.error('Impor tersimpan tetapi penyegaran data gagal',refreshError);
      toast('Data sudah tersimpan. Muat ulang halaman untuk memperbarui tampilan.');
    }
  } catch (error) {
    el('import-message').textContent = error.message; button.disabled = false;
  } finally { button.textContent = 'Simpan data yang sudah valid'; }
}

async function loadImportHistory() {
  try {
    const data = await request('/api/imports');
    state.importJobs = data.jobs ?? [];
    const labels = { PRODUCTS:'Produk',PRODUCT_UNITS:'Satuan barang',PRODUCT_VARIANTS:'Varian barang',PRODUCT_PRICES:'Harga pelanggan',KASPIN_FIFO:'Pembelian & modal FIFO',KASPIN_SALES:'Penjualan & detail struk',CUSTOMERS:'Pelanggan',SUPPLIERS:'Supplier' };
    el('import-history-list').innerHTML = state.importJobs.length ? state.importJobs.map((job) => `<div class="import-history-row"><div><strong>${labels[job.import_kind] ?? job.import_kind}</strong><small>${escapeHtml(job.file_name ?? 'Tanpa nama file')} · ${new Intl.DateTimeFormat('id-ID',{dateStyle:'medium',timeStyle:'short'}).format(new Date(job.created_at))}</small></div><div><strong>${job.total_rows} baris</strong><small>${job.created_rows} baru · ${job.updated_rows} diperbarui</small></div><span class="badge ok">Selesai</span></div>`).join('') : '<div class="empty-state compact">Belum ada riwayat impor.</div>';
  } catch (error) { el('import-history-list').innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`; }
}

async function createBackup() {
  const button = el('create-backup');
  button.disabled = true; button.textContent = 'Menyiapkan backup…';
  el('backup-status').innerHTML = '<span class="session-loader"></span><div><strong>Mengumpulkan data usaha…</strong><p class="muted">Jangan tutup halaman sampai file terunduh.</p></div>';
  try {
    const result = await request('/api/backups/export', { method:'POST', body:'{}' });
    const content = JSON.stringify(result.snapshot,null,2);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([content],{type:'application/json'}));
    link.download = result.fileName; link.click(); URL.revokeObjectURL(link.href);
    el('backup-status').innerHTML = `<div class="backup-shield">✓</div><div><strong>Backup berhasil diunduh</strong><p class="muted">${result.totalRows} baris data · ${escapeHtml(result.fileName)}</p></div>`;
    toast('Backup selesai. Simpan file di tempat aman.');
    await loadBackupHistory();
  } catch (error) {
    el('backup-status').innerHTML = `<div class="backup-shield danger">!</div><div><strong>Backup belum berhasil</strong><p class="error">${escapeHtml(error.message)}</p></div>`;
  } finally { button.disabled = false; button.textContent = 'Unduh backup sekarang'; }
}

async function verifyBackupFile() {
  const file = el('verify-backup-file').files[0];
  if (!file) return;
  el('verify-backup-file-name').textContent = file.name;
  el('backup-verification').innerHTML = '<p class="muted">Memeriksa struktur dan checksum…</p>';
  try {
    const snapshot = JSON.parse(await file.text());
    const result = await request('/api/backups/verify',{method:'POST',body:JSON.stringify({snapshot})});
    el('backup-verification').innerHTML = result.valid
      ? `<div class="backup-verify-result valid"><strong>✓ ${escapeHtml(result.message)}</strong><p>${result.totalRows} baris data · dibuat ${new Intl.DateTimeFormat('id-ID',{dateStyle:'medium',timeStyle:'short'}).format(new Date(result.createdAt))}</p></div>`
      : `<div class="backup-verify-result invalid"><strong>! File tidak dapat digunakan</strong><p>${escapeHtml(result.message)}</p></div>`;
  } catch (error) {
    el('backup-verification').innerHTML = `<div class="backup-verify-result invalid"><strong>! File tidak dapat dibaca</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
}

async function loadBackupHistory() {
  try {
    const data = await request('/api/backups');
    state.backupExports = data.exports ?? [];
    el('backup-history-list').innerHTML = state.backupExports.length ? state.backupExports.map((backup) => `<div class="backup-history-row"><div><strong>${escapeHtml(backup.file_name)}</strong><small>${new Intl.DateTimeFormat('id-ID',{dateStyle:'medium',timeStyle:'short'}).format(new Date(backup.created_at))}</small></div><div><strong>${Number(backup.total_rows).toLocaleString('id-ID')} baris</strong><small>Format v${backup.schema_version}</small></div><code>${escapeHtml(backup.checksum_sha256.slice(0,12))}…</code><span class="badge ok">Selesai</span></div>`).join('') : '<div class="empty-state compact">Belum ada backup.</div>';
  } catch (error) { el('backup-history-list').innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`; }
}

function promoPayload() {
  const type=el('promo-type').value,targetType=el('promo-target-type').value;
  const condition={
    minBaseQty:Number(el('promo-min-qty').value||0),minBasketSubtotal:Number(el('promo-min-basket').value||0),
    customerGroupIds:el('promo-customer-group').value==='ANY'?[]:[el('promo-customer-group').value],
    schedule:{daysOfWeek:[...el('promo-days').querySelectorAll('input:checked')].map((input)=>Number(input.value)),timeStart:el('promo-time-start').value||null,timeEnd:el('promo-time-end').value||null,timeZone:state.outlets.find((outlet)=>outlet.id===state.activeOutletId)?.timezone??'Asia/Makassar'}
  };
  if(targetType==='PRODUCT')condition.productIds=[el('promo-target-product').value];
  if(targetType==='CATEGORY')condition.categories=[el('promo-category').value.trim()];
  if(targetType==='BRAND')condition.brands=[el('promo-brand').value.trim()];
  if(type==='BUNDLE_FIXED')condition.bundle=[
    {productId:el('promo-bundle-product-a').value,qty:Number(el('promo-bundle-qty-a').value)},
    {productId:el('promo-bundle-product-b').value,qty:Number(el('promo-bundle-qty-b').value)}
  ];
  const reward={type};
  if(['PERCENT_ITEM','FIXED_ITEM','FIXED_ORDER','SPECIAL_PRICE','PERCENT_ORDER','BUNDLE_FIXED'].includes(type))reward.value=Number(el('promo-value').value);
  if(['PERCENT_ITEM','PERCENT_ORDER'].includes(type))reward.maxDiscount=Number(el('promo-max').value)||Number.MAX_SAFE_INTEGER;
  if(type==='FIXED_ORDER'){
    reward.repeatMode=el('promo-repeat-mode').value;
    reward.repeatCap=el('promo-repeat-cap').value?Number(el('promo-repeat-cap').value):null;
  }
  if(type==='BUY_X_GET_Y'){
    reward.buyQty=Number(el('promo-buy-qty').value);reward.freeQty=Number(el('promo-free-qty').value);
    if(el('promo-reward-product').value)reward.productIds=[el('promo-reward-product').value];
  }
  return {
    code:el('promo-code').value.trim().toUpperCase(),name:el('promo-name').value.trim(),condition,reward,
    startsAt:new Date(el('promo-starts').value).toISOString(),endsAt:new Date(el('promo-ends').value).toISOString(),
    priority:Number(el('promo-priority').value),stackable:el('promo-stackable').checked,
    usageLimitTotal:el('promo-limit-total').value?Number(el('promo-limit-total').value):null,
    usageLimitPerCustomer:el('promo-limit-customer').value?Number(el('promo-limit-customer').value):null
  };
}

function updatePromoSummary() {
  let promo;
  try{promo=promoPayload();}catch{return el('promo-summary').textContent='Lengkapi jadwal dan aturan untuk melihat ringkasan.';}
  const repeatLabel=promo.reward.repeatMode==='MULTIPLE'?`berlaku kelipatan${promo.reward.repeatCap?` maksimal ${promo.reward.repeatCap} kali`:''}`:'berlaku sekali';
  const typeLabels={PERCENT_ITEM:`Diskon ${promo.reward.value}% per barang`,FIXED_ITEM:`Potongan ${money.format(promo.reward.value)} per pcs`,FIXED_ORDER:`Potongan ${money.format(promo.reward.value)} total belanja, ${repeatLabel}`,SPECIAL_PRICE:`Harga khusus ${money.format(promo.reward.value)} per pcs`,PERCENT_ORDER:`Diskon ${promo.reward.value}% total belanja`,BUY_X_GET_Y:`Beli ${promo.reward.buyQty} gratis ${promo.reward.freeQty}`,BUNDLE_FIXED:`Paket seharga ${money.format(promo.reward.value)}`};
  const target=promo.condition.productIds?.length?'produk tertentu':promo.condition.categories?.[0]?`kategori ${promo.condition.categories[0]}`:promo.condition.brands?.[0]?`merek ${promo.condition.brands[0]}`:'semua barang';
  const group=promo.condition.customerGroupIds?.[0]?(promo.condition.customerGroupIds[0]==='wholesale'?'pelanggan grosir/member':'pelanggan eceran'):'semua pelanggan';
  el('promo-summary').textContent=`${typeLabels[promo.reward.type]} untuk ${target}, minimal ${promo.condition.minBaseQty||0} pcs dan ${group}. Prioritas ${promo.priority}${promo.stackable?', boleh digabung':', tidak digabung'}.`;
}

function renderPromotionList() {
  const source=state.promotionVersions.length?state.promotionVersions:state.promotions;
  const filter=el('promo-status-filter')?.value??'ACTIVE',now=Date.now();
  const rows=source.filter((promo)=>filter==='ALL'||(filter==='RETIRED'?promo.status==='RETIRED':promo.status==='PUBLISHED'&&new Date(promo.endsAt).getTime()>=now));
  const typeLabels={PERCENT_ITEM:'Diskon barang',FIXED_ITEM:'Potongan per pcs',FIXED_ORDER:'Potongan total',SPECIAL_PRICE:'Harga khusus',PERCENT_ORDER:'Diskon belanja',BUY_X_GET_Y:'Beli gratis',BUNDLE_FIXED:'Bundling'};
  el('promotion-list').innerHTML=rows.map((promo)=>{
    const active=promo.status==='PUBLISHED'&&new Date(promo.startsAt).getTime()<=now&&new Date(promo.endsAt).getTime()>=now;
    const usage=promo.usageLimitTotal?`${promo.usageCount??0}/${promo.usageLimitTotal} kali`:`${promo.usageCount??0} kali`;
    return `<article class="promo-rule-card" data-promo-id="${escapeHtml(promo.id)}"><div class="promo-rule-head"><div><strong>${escapeHtml(promo.code)} · ${escapeHtml(promo.name)}</strong><small>v${promo.version} · ${escapeHtml(typeLabels[promo.reward?.type]??promo.reward?.type??'Promo')}</small></div><span class="status-badge ${active?'approved':promo.status==='RETIRED'?'inactive':'submitted'}">${active?'AKTIF':promo.status==='RETIRED'?'DIHENTIKAN':'TERJADWAL'}</span></div><div class="promo-rule-meta"><span>${new Date(promo.startsAt).toLocaleString('id-ID')}<br>hingga ${new Date(promo.endsAt).toLocaleString('id-ID')}</span><span>Prioritas ${promo.priority}<br>${promo.stackable?'Boleh digabung':'Tidak digabung'}</span><span>Dipakai ${usage}<br>Diskon ${money.format(promo.discountGiven??0)}</span></div>${promo.status==='PUBLISHED'?'<div class="voucher-actions"><button class="button secondary edit-promotion" type="button">Edit</button><button class="button danger-button delete-promotion" type="button">Hapus</button></div>':''}</article>`;
  }).join('')||'<div class="empty-state compact">Belum ada versi promo pada filter ini.</div>';
  const activeCount=source.filter((promo)=>promo.status==='PUBLISHED'&&new Date(promo.startsAt).getTime()<=now&&new Date(promo.endsAt).getTime()>=now).length;
  el('promo-version').textContent=activeCount?`${activeCount} aturan aktif`:'Belum ada aturan aktif';
}

function localDateTimeValue(date){
  const shifted=new Date(date.getTime()-date.getTimezoneOffset()*60000);return shifted.toISOString().slice(0,16);
}

function renderPromotionEditorOptions(){
  const options=state.products.map((product)=>`<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)} · ${escapeHtml(product.sku)}</option>`).join('');
  ['promo-target-product','promo-bundle-product-a','promo-bundle-product-b','promo-simulation-product'].forEach((id)=>{const selected=el(id)?.value;if(el(id)){el(id).innerHTML=options;if(state.products.some((product)=>product.id===selected))el(id).value=selected;}});
  const rewardSelected=el('promo-reward-product')?.value;
  if(el('promo-reward-product')){el('promo-reward-product').innerHTML='<option value="">Produk yang sama</option>'+options;if(state.products.some((product)=>product.id===rewardSelected))el('promo-reward-product').value=rewardSelected;}
  if(!el('promo-starts').value){const start=new Date(),end=new Date(Date.now()+30*86400000);el('promo-starts').value=localDateTimeValue(start);el('promo-ends').value=localDateTimeValue(end);}
  syncPromotionForm();
}

function syncPromotionForm(){
  const type=el('promo-type').value,target=el('promo-target-type').value;
  el('promo-target-product-wrap').classList.toggle('hidden',target!=='PRODUCT');
  el('promo-target-category-wrap').classList.toggle('hidden',target!=='CATEGORY');
  el('promo-target-brand-wrap').classList.toggle('hidden',target!=='BRAND');
  el('promo-value-wrap').classList.toggle('hidden',type==='BUY_X_GET_Y');
  el('promo-max-wrap').classList.toggle('hidden',!['PERCENT_ITEM','PERCENT_ORDER'].includes(type));
  el('promo-buy-wrap').classList.toggle('hidden',type!=='BUY_X_GET_Y');el('promo-free-wrap').classList.toggle('hidden',type!=='BUY_X_GET_Y');el('promo-reward-product-wrap').classList.toggle('hidden',type!=='BUY_X_GET_Y');
  el('promo-bundle-fields').classList.toggle('hidden',type!=='BUNDLE_FIXED');
  el('promo-repeat-wrap').classList.toggle('hidden',type!=='FIXED_ORDER');
  el('promo-repeat-cap-wrap').classList.toggle('hidden',type!=='FIXED_ORDER'||el('promo-repeat-mode').value!=='MULTIPLE');
  const valueLabels={PERCENT_ITEM:'Diskon persen',FIXED_ITEM:'Potongan / pcs',FIXED_ORDER:'Potongan total belanja',SPECIAL_PRICE:'Harga khusus / pcs',PERCENT_ORDER:'Diskon persen',BUNDLE_FIXED:'Harga paket'};
  el('promo-value-wrap').firstChild.textContent=valueLabels[type]??'Nilai promo';
  updatePromoSummary();
}

async function loadPromotionManagement(){
  try{
    const [data,loyalty]=await Promise.all([request('/api/promotions/manage'),request('/api/loyalty')]);
    state.promotionVersions=data.promotions??[];state.loyalty=loyalty;renderPromotionList();renderLoyalty();
  }
  catch(error){toast(error.message);}
}

function downloadJsonSnapshot(snapshot,fileName) {
  const content=JSON.stringify(snapshot,null,2);
  const link=document.createElement('a');
  link.href=URL.createObjectURL(new Blob([content],{type:'application/json'}));
  link.download=fileName;link.click();URL.revokeObjectURL(link.href);
}

function showDataMaintenanceMode(mode) {
  const selected=mode==='restore'?'restore':'reset';
  document.querySelectorAll('[data-maintenance-mode]').forEach((button)=>{
    const active=button.dataset.maintenanceMode===selected;
    button.classList.toggle('active',active);
    button.setAttribute('aria-selected',String(active));
  });
  el('data-reset-panel').classList.toggle('hidden',selected!=='reset');
  el('data-restore-panel').classList.toggle('hidden',selected!=='restore');
}

function resetDataRestoreSelection(message='Belum ada file JSON dipilih') {
  state.dataRestoreSnapshot=null;
  state.dataRestoreOtpReady=false;
  el('data-restore-file-name').textContent=message;
  el('data-restore-preview').classList.add('hidden');
  el('data-restore-confirmation').classList.add('hidden');
  el('data-restore-otp').value='';
  el('data-restore-phrase').value='';
  el('data-restore-error').textContent='';
  el('data-restore-file-error').textContent='';
  el('request-data-restore-otp').disabled=true;
  el('request-data-restore-otp').textContent='Periksa file & kirim OTP Owner';
}

async function inspectDataRestoreFile(event) {
  const file=event.target.files?.[0];
  resetDataRestoreSelection(file?.name??'Belum ada file JSON dipilih');
  if(!file)return;
  try{
    const snapshot=JSON.parse(await file.text());
    const result=await request('/api/data-restore/preview',{method:'POST',body:JSON.stringify({snapshot})});
    state.dataRestoreSnapshot=snapshot;
    const groups=result.preview?.groups??{};
    const createdAt=new Date(result.createdAt);
    el('data-restore-created-at').textContent=Number.isNaN(createdAt.getTime())
      ?'Tanggal backup tidak tersedia'
      :`Dibuat ${createdAt.toLocaleString('id-ID')}`;
    el('data-restore-total').textContent=`${Number(result.preview?.totalRows??0).toLocaleString('id-ID')} data`;
    ['catalog','transactions','inventory','relations','growth','finance','workforce'].forEach((group)=>{
      el(`data-restore-count-${group}`).textContent=Number(groups[group]??0).toLocaleString('id-ID');
    });
    el('data-restore-preview').classList.remove('hidden');
    el('request-data-restore-otp').disabled=false;
  }catch(error){
    resetDataRestoreSelection(file.name);
    el('data-restore-file-error').textContent=error instanceof SyntaxError
      ?'File bukan backup JSON Kasir Nusa yang valid.'
      :error.message;
  }
}

async function requestDataRestoreOtp() {
  if(!state.dataRestoreSnapshot)return;
  const button=el('request-data-restore-otp');
  button.disabled=true;button.textContent='Mensimulasikan pemulihan…';
  el('data-restore-file-error').textContent='';
  el('data-restore-error').textContent='';
  try{
    const result=await request('/api/data-restore/otp',{method:'POST',body:JSON.stringify({snapshot:state.dataRestoreSnapshot})});
    state.dataRestoreOtpReady=true;
    el('data-restore-email').textContent=`Simulasi berhasil tanpa mengubah data. OTP dikirim ke ${result.emailMasked}.`;
    el('data-restore-confirmation').classList.remove('hidden');
    el('data-restore-otp').focus();
    toast('File siap dipulihkan dan OTP telah dikirim.');
  }catch(error){
    state.dataRestoreOtpReady=false;
    el('data-restore-file-error').textContent=error.message;
  }finally{
    button.disabled=false;button.textContent=state.dataRestoreOtpReady?'Simulasikan ulang & kirim OTP baru':'Periksa file & kirim OTP Owner';
  }
}

async function executeDataRestore(event) {
  event.preventDefault();
  const errorNode=el('data-restore-error');errorNode.textContent='';
  if(!state.dataRestoreSnapshot||!state.dataRestoreOtpReady){
    errorNode.textContent='Pilih dan periksa file backup terlebih dahulu.';return;
  }
  const button=el('execute-data-restore');
  button.disabled=true;button.textContent='Membuat backup lalu memulihkan…';
  try{
    const result=await request('/api/data-restore/execute',{method:'POST',body:JSON.stringify({
      snapshot:state.dataRestoreSnapshot,
      otp:el('data-restore-otp').value,
      confirmation:el('data-restore-phrase').value
    })});
    downloadJsonSnapshot(result.snapshot,result.fileName);
    toast(`Pemulihan selesai. ${Number(result.restoredRows??0).toLocaleString('id-ID')} data dikembalikan.`);
    state.dataRestoreOtpReady=false;
    setTimeout(()=>location.reload(),1200);
  }catch(error){
    errorNode.textContent=error.message;
    button.disabled=false;button.textContent='Backup kondisi saat ini lalu pulihkan';
  }
}

function selectedDataResetScopes() {
  return [...document.querySelectorAll('input[name="data-reset-scope"]:checked')].map((input)=>input.value);
}

function syncDataResetForm(event) {
  const all=el('data-reset-form').querySelector('input[value="ALL"]');
  const others=[...el('data-reset-form').querySelectorAll('input[name="data-reset-scope"]:not([value="ALL"])')];
  if(event?.target===all&&all.checked)others.forEach((input)=>{input.checked=false;});
  if(event?.target!==all&&event?.target?.checked)all.checked=false;
  others.forEach((input)=>{input.disabled=all.checked;});
  const scopes=selectedDataResetScopes(),labels={
    ALL:'semua data operasional',TRANSACTIONS:'transaksi, pembelian, dan stok',
    CATALOG:'produk dan harga',CUSTOMERS:'pelanggan dan loyalty',SUPPLIERS:'supplier',
    PROMOTIONS:'promo dan voucher',FINANCE:'keuangan dan jurnal',WORKFORCE:'aktivitas karyawan'
  };
  const dependencies=[];
  if(scopes.some((scope)=>['CATALOG','CUSTOMERS','SUPPLIERS'].includes(scope)))dependencies.push('transaksi, pembelian, stok, dan jurnal terkait ikut dikosongkan');
  if(scopes.includes('CUSTOMERS'))dependencies.push('loyalty, promo, dan voucher terkait ikut dikosongkan');
  el('data-reset-impact').textContent=scopes.length
    ? `Akan direset: ${scopes.map((scope)=>labels[scope]).join(', ')}.${dependencies.length?` Demi konsistensi, ${dependencies.join('; ')}.`:''}`
    :'Belum ada kelompok data yang dipilih.';
  el('request-data-reset-otp').disabled=!scopes.length;
  if(event){
    state.dataResetScopesSignature='';
    el('data-reset-confirmation').classList.add('hidden');
    el('data-reset-otp').value='';el('data-reset-phrase').value='';el('data-reset-error').textContent='';
  }
}

async function requestDataResetOtp() {
  const scopes=selectedDataResetScopes();
  if(!scopes.length)return;
  const button=el('request-data-reset-otp');button.disabled=true;button.textContent='Mengirim OTP…';
  el('data-reset-error').textContent='';
  try{
    const result=await request('/api/data-reset/otp',{method:'POST',body:JSON.stringify({scopes})});
    state.dataResetScopesSignature=scopes.sort().join('|');
    el('data-reset-email').textContent=`Kode OTP dikirim ke ${result.emailMasked}. Masukkan seluruh angka pada kode terbaru.`;
    el('data-reset-confirmation').classList.remove('hidden');
    el('data-reset-otp').focus();
    toast('OTP reset telah dikirim ke email Owner.');
  }catch(error){
    el('data-reset-confirmation').classList.remove('hidden');
    el('data-reset-error').textContent=error.message;
  }finally{
    button.disabled=false;button.textContent='Kirim ulang OTP ke email Owner';
  }
}

async function executeDataReset(event) {
  event.preventDefault();
  const scopes=selectedDataResetScopes(),signature=[...scopes].sort().join('|');
  const errorNode=el('data-reset-error');errorNode.textContent='';
  if(!state.dataResetScopesSignature||signature!==state.dataResetScopesSignature){
    errorNode.textContent='Pilihan data berubah. Kirim OTP baru untuk pilihan ini.';return;
  }
  const button=el('execute-data-reset');button.disabled=true;button.textContent='Membuat backup dan mereset…';
  try{
    const result=await request('/api/data-reset/execute',{method:'POST',body:JSON.stringify({
      scopes,otp:el('data-reset-otp').value,confirmation:el('data-reset-phrase').value
    })});
    downloadJsonSnapshot(result.snapshot,result.fileName);
    toast('Reset selesai. Backup sebelum reset telah diunduh.');
    state.dataResetScopesSignature='';
    setTimeout(()=>location.reload(),1200);
  }catch(error){
    errorNode.textContent=error.message;button.disabled=false;button.textContent='Backup lalu reset data terpilih';
  }
}

function renderCustomerGroupList() {
  el('customer-group-list').innerHTML=state.customerGroups.map((group)=>`<div class="relation-item"><span><strong>${escapeHtml(group.id==='retail'?'Umum':group.name)}</strong><br><small>${group.id==='retail'?'Harga dasar untuk pelanggan umum':'Tersedia sebagai tipe pelanggan dan harga produk'}</small></span>${group.id==='retail'?'<span class="badge neutral">BAWAAN</span>':'<span class="badge ok">AKTIF</span>'}</div>`).join('');
}

function openCustomerGroupDialog() {
  renderCustomerGroupList();
  el('customer-group-form').reset();
  el('customer-group-error').textContent='';
  el('customer-group-dialog').showModal();
}

async function saveCustomerGroup(event) {
  event.preventDefault();
  const button=event.currentTarget.querySelector('[type="submit"]');button.disabled=true;
  try{
    const group=await request('/api/customer-groups',{method:'POST',body:JSON.stringify({name:el('customer-group-name').value})});
    toast(`Tipe ${group.name} berhasil ditambahkan`);
    await refreshCatalog();
    renderCustomerGroupList();
    el('customer-group-name').value='';
  }catch(error){el('customer-group-error').textContent=error.message;}finally{button.disabled=false;}
}

function renderLoyalty(){
  const settings=state.loyalty.settings??{};
  el('loyalty-earn-amount').value=Number(settings.earn_amount_per_point??10000);
  el('loyalty-inactivity-days').value=Number(settings.inactivity_days??90);
  el('loyalty-summary').textContent=`${state.loyalty.vouchers.filter((item)=>item.active).length} voucher aktif`;
  el('tier-list').innerHTML=state.loyalty.tiers.map((tier)=>`<span class="tier-chip" style="--tier-color:${escapeHtml(tier.color)}"><strong>${escapeHtml(tier.name)}</strong><small>mulai ${money.format(tier.min_lifetime_spend)} · ${Number(tier.points_multiplier)}× poin</small></span>`).join('');
  el('voucher-list').innerHTML=state.loyalty.vouchers.filter((voucher)=>voucher.active).map((voucher)=>`<article class="voucher-card" data-voucher-id="${escapeHtml(voucher.id)}"><div><strong>${escapeHtml(voucher.code)} · ${escapeHtml(voucher.name)}</strong><small>${voucher.discount_type==='PERCENT'?`${Number(voucher.discount_value)}%`:money.format(voucher.discount_value)} · min. ${money.format(voucher.min_purchase)} · ${escapeHtml(voucher.segment)}</small><small>${new Date(voucher.starts_at).toLocaleDateString('id-ID')}–${new Date(voucher.ends_at).toLocaleDateString('id-ID')} · dipakai ${voucher.usage_count}${voucher.usage_limit_total?`/${voucher.usage_limit_total}`:''}</small></div><div class="voucher-actions"><button class="button secondary edit-voucher" type="button">Edit</button><button class="button danger-button delete-voucher" type="button">Hapus</button></div></article>`).join('')||'<div class="empty-state compact">Belum ada voucher berkode aktif.</div>';
  el('receipt-voucher-campaign-list').innerHTML=(state.loyalty.receiptCampaigns??[]).filter((campaign)=>campaign.active).map((campaign)=>`<article class="voucher-card" data-receipt-campaign-id="${escapeHtml(campaign.id)}"><div><strong>${escapeHtml(campaign.name)}</strong><small>Terbit mulai ${money.format(campaign.trigger_min_purchase)} · ${campaign.discount_type==='PERCENT'?`${Number(campaign.discount_value)}%`:money.format(campaign.discount_value)} · berlaku ${Number(campaign.valid_days)} hari</small><small>${Number(campaign.issued_count)} diterbitkan · ${Number(campaign.redeemed_count)} digunakan · ${Number(campaign.expired_count)} kedaluwarsa</small></div><div class="voucher-actions"><button class="button secondary edit-receipt-voucher" type="button">Edit</button><button class="button danger-button delete-receipt-voucher" type="button">Hapus</button></div></article>`).join('')||'<div class="empty-state compact">Belum ada promo voucher otomatis aktif.</div>';
  if(!el('voucher-new-start').value){const start=new Date(),end=new Date(Date.now()+30*86400000);el('voucher-new-start').value=localDateTimeValue(start);el('voucher-new-end').value=localDateTimeValue(end);}
}

function showLoyaltyView(view){
  document.querySelectorAll('[data-loyalty-view]').forEach((button)=>button.classList.toggle('active',button.dataset.loyaltyView===view));
  document.querySelectorAll('.loyalty-detail').forEach((panel)=>panel.classList.toggle('hidden',panel.id!==`loyalty-view-${view}`));
}

function openVoucherForm(voucher=null){
  const form=el('voucher-form');form.reset();form.dataset.voucherId=voucher?.id??'';
  el('voucher-dialog-title').textContent=voucher?'Edit voucher berkode':'Tambah voucher berkode';
  if(voucher){
    el('voucher-new-code').value=voucher.code;el('voucher-new-name').value=voucher.name;
    el('voucher-new-type').value=voucher.discount_type;el('voucher-new-value').value=Number(voucher.discount_value);
    el('voucher-new-max').value=voucher.max_discount??'';el('voucher-new-min').value=Number(voucher.min_purchase);
    el('voucher-new-start').value=localDateTimeValue(new Date(voucher.starts_at));el('voucher-new-end').value=localDateTimeValue(new Date(voucher.ends_at));
    el('voucher-new-segment').value=voucher.segment;el('voucher-new-limit-total').value=voucher.usage_limit_total??'';
    el('voucher-new-limit-customer').value=voucher.usage_limit_per_customer??'';el('voucher-new-once').checked=voucher.one_time;
  }else{
    const start=new Date(),end=new Date(Date.now()+30*86400000);
    el('voucher-new-start').value=localDateTimeValue(start);el('voucher-new-end').value=localDateTimeValue(end);
  }
  el('voucher-form-error').textContent='';el('voucher-form-dialog').showModal();
}

function openReceiptVoucherCampaign(campaign=null){
  const form=el('receipt-voucher-campaign-form');form.reset();form.dataset.campaignId=campaign?.id??'';
  el('receipt-voucher-dialog-title').textContent=campaign?'Edit promo':'Tambah promo baru';
  if(campaign){
    el('receipt-voucher-name').value=campaign.name;el('receipt-voucher-trigger-min').value=Number(campaign.trigger_min_purchase);
    el('receipt-voucher-type').value=campaign.discount_type;el('receipt-voucher-value').value=Number(campaign.discount_value);
    el('receipt-voucher-max').value=campaign.max_discount??'';el('receipt-voucher-redemption-min').value=Number(campaign.redemption_min_purchase);
    el('receipt-voucher-valid-after').value=Number(campaign.valid_after_days);el('receipt-voucher-valid-days').value=Number(campaign.valid_days);
    el('receipt-voucher-customer-mode').value=campaign.customer_mode;el('receipt-voucher-priority').value=Number(campaign.priority);
  }else{
    el('receipt-voucher-trigger-min').value=100000;el('receipt-voucher-redemption-min').value=100000;
    el('receipt-voucher-valid-after').value=1;el('receipt-voucher-valid-days').value=14;el('receipt-voucher-priority').value=0;
  }
  el('receipt-voucher-form-error').textContent='';el('receipt-voucher-campaign-dialog').showModal();
}

async function saveLoyaltySettings(event){
  event.preventDefault();
  try{await request('/api/loyalty/settings',{method:'PUT',body:JSON.stringify({earnAmountPerPoint:Number(el('loyalty-earn-amount').value),inactivityDays:Number(el('loyalty-inactivity-days').value),enabled:true})});toast('Aturan poin disimpan');await loadPromotionManagement();}
  catch(error){toast(error.message);}
}

async function publishVoucher(event){
  event.preventDefault();const form=event.currentTarget;el('voucher-form-error').textContent='';
  const payload={code:el('voucher-new-code').value,name:el('voucher-new-name').value,discountType:el('voucher-new-type').value,
    discountValue:Number(el('voucher-new-value').value),maxDiscount:Number(el('voucher-new-max').value)||null,minPurchase:Number(el('voucher-new-min').value||0),
    startsAt:new Date(el('voucher-new-start').value).toISOString(),endsAt:new Date(el('voucher-new-end').value).toISOString(),
    segment:el('voucher-new-segment').value,usageLimitTotal:Number(el('voucher-new-limit-total').value)||null,
    usageLimitPerCustomer:Number(el('voucher-new-limit-customer').value)||null,oneTime:el('voucher-new-once').checked};
  const voucherId=form.dataset.voucherId;
  try{await request(voucherId?`/api/vouchers/${voucherId}`:'/api/vouchers',{method:voucherId?'PUT':'POST',body:JSON.stringify(payload)});toast(voucherId?'Voucher diperbarui':`Voucher ${payload.code.toUpperCase()} diterbitkan`);form.reset();form.dataset.voucherId='';el('voucher-form-dialog').close();await loadPromotionManagement();}
  catch(error){el('voucher-form-error').textContent=error.message;}
}

async function publishReceiptVoucherCampaign(event){
  event.preventDefault();const form=event.currentTarget;el('receipt-voucher-form-error').textContent='';
  const payload={name:el('receipt-voucher-name').value,triggerMinPurchase:Number(el('receipt-voucher-trigger-min').value),
    discountType:el('receipt-voucher-type').value,discountValue:Number(el('receipt-voucher-value').value),
    maxDiscount:Number(el('receipt-voucher-max').value)||null,redemptionMinPurchase:Number(el('receipt-voucher-redemption-min').value),
    validAfterDays:Number(el('receipt-voucher-valid-after').value),validDays:Number(el('receipt-voucher-valid-days').value),
    customerMode:el('receipt-voucher-customer-mode').value,priority:Number(el('receipt-voucher-priority').value)};
  try{
    const campaignId=form.dataset.campaignId;
    await request(campaignId?`/api/receipt-voucher-campaigns/${campaignId}`:'/api/receipt-voucher-campaigns',{method:campaignId?'PUT':'POST',body:JSON.stringify(payload)});
    toast(campaignId?'Promo voucher struk diperbarui':'Program voucher struk sudah aktif');form.reset();form.dataset.campaignId='';
    el('receipt-voucher-trigger-min').value=100000;el('receipt-voucher-redemption-min').value=100000;
    el('receipt-voucher-valid-after').value=1;el('receipt-voucher-valid-days').value=14;
    el('receipt-voucher-campaign-dialog').close();await loadPromotionManagement();
  }catch(error){el('receipt-voucher-form-error').textContent=error.message;}
}

function editPromotion(versionId){
  const promo=state.promotionVersions.find((item)=>item.id===versionId);if(!promo)return;
  const condition=promo.condition??{},reward=promo.reward??{},schedule=condition.schedule??{};
  el('promotion-form').dataset.editingPromoId=versionId;el('promo-code').value=promo.code;el('promo-name').value=promo.name;
  el('promo-type').value=reward.type;el('promo-target-type').value=condition.productIds?.length?'PRODUCT':condition.categories?.length?'CATEGORY':condition.brands?.length?'BRAND':'ALL';
  el('promo-target-product').value=condition.productIds?.[0]??'';el('promo-category').value=condition.categories?.[0]??'';el('promo-brand').value=condition.brands?.[0]??'';
  el('promo-customer-group').value=condition.customerGroupIds?.[0]??'ANY';el('promo-min-qty').value=Number(condition.minBaseQty??0);
  el('promo-min-basket').value=Number(condition.minBasketSubtotal??0);el('promo-value').value=Number(reward.value??0);
  el('promo-max').value=reward.maxDiscount===Number.MAX_SAFE_INTEGER?'':reward.maxDiscount??'';
  el('promo-buy-qty').value=Number(reward.buyQty??2);el('promo-free-qty').value=Number(reward.freeQty??1);
  el('promo-reward-product').value=reward.productIds?.[0]??'';el('promo-repeat-mode').value=reward.repeatMode??'ONCE';el('promo-repeat-cap').value=reward.repeatCap??'';
  el('promo-bundle-product-a').value=condition.bundle?.[0]?.productId??'';el('promo-bundle-qty-a').value=Number(condition.bundle?.[0]?.qty??1);
  el('promo-bundle-product-b').value=condition.bundle?.[1]?.productId??'';el('promo-bundle-qty-b').value=Number(condition.bundle?.[1]?.qty??1);
  el('promo-starts').value=localDateTimeValue(new Date(promo.startsAt));el('promo-ends').value=localDateTimeValue(new Date(promo.endsAt));
  el('promo-time-start').value=schedule.timeStart??'';el('promo-time-end').value=schedule.timeEnd??'';
  const days=new Set(schedule.daysOfWeek??[0,1,2,3,4,5,6]);el('promo-days').querySelectorAll('input').forEach((input)=>{input.checked=days.has(Number(input.value));});
  el('promo-priority').value=Number(promo.priority??50);el('promo-limit-total').value=promo.usageLimitTotal??'';
  el('promo-limit-customer').value=promo.usageLimitPerCustomer??'';el('promo-stackable').checked=Boolean(promo.stackable);
  el('publish-promo').textContent='Simpan perubahan sebagai versi baru';syncPromotionForm();updatePromoSummary();
  el('promotion-form').scrollIntoView({behavior:'smooth',block:'start'});
}

async function publishPromotion(event) {
  event?.preventDefault();const form=event?.currentTarget;
  const button=el('publish-promo');el('promotion-error').textContent='';button.disabled=true;
  try {
    const promo = await request('/api/promotions/publish', { method: 'POST', body: JSON.stringify(promoPayload()) });
    toast(`${promo.code} versi ${promo.version} diterbitkan`);form.dataset.editingPromoId='';
    el('publish-promo').textContent='Publikasikan aturan baru';await refreshCatalog();await loadPromotionManagement();
  } catch (error) { el('promotion-error').textContent=error.message; }
  finally{button.disabled=false;}
}

async function simulatePromotion() {
  const promo=promoPayload(),type=promo.reward.type;
  const productId=promo.condition.productIds?.[0]??el('promo-simulation-product').value;
  const product=state.products.find((item)=>item.id===productId);if(!product)return toast('Pilih produk untuk simulasi.');
  let lines=[{productId:product.id,unitId:product.units.find((unit)=>unit.factor===1)?.id??product.units[0].id,qty:Number(el('promo-simulation-qty').value)}];
  if(type==='BUNDLE_FIXED')lines=promo.condition.bundle.map((item)=>{const member=state.products.find((product)=>product.id===item.productId);return{productId:item.productId,unitId:member.units.find((unit)=>unit.factor===1)?.id??member.units[0].id,qty:item.qty};});
  if(type==='BUY_X_GET_Y'&&promo.reward.productIds?.[0]!==product.id){const rewardProduct=state.products.find((item)=>item.id===promo.reward.productIds?.[0]);if(rewardProduct)lines.push({productId:rewardProduct.id,unitId:rewardProduct.units.find((unit)=>unit.factor===1)?.id??rewardProduct.units[0].id,qty:promo.reward.freeQty});}
  try {
    const quote=await request('/api/promotions/simulate',{method:'POST',body:JSON.stringify({promo,lines,customerGroupId:el('promo-customer-group').value==='ANY'?'retail':el('promo-customer-group').value})});
    el('promo-result').innerHTML=`<strong>Hasil simulasi ${escapeHtml(promo.code||'PROMO')}</strong><div class="promo-simulation-result"><span>Harga normal<strong>${money.format(quote.subtotal)}</strong></span><span>Potongan<strong>−${money.format(quote.discountTotal)}</strong></span><span>Total akhir<strong>${money.format(quote.grandTotal)}</strong></span></div>${quote.discountTotal?'<small>Aturan berhasil terbaca oleh mesin harga.</small>':'<small>Promo belum terpicu. Periksa sasaran, jumlah, kelompok pelanggan, atau jadwal.</small>'}`;
  } catch(error){el('promotion-error').textContent=error.message;}
}

async function retirePromotion(versionId){
  if(!confirm('Hentikan promo ini? Transaksi berikutnya tidak akan menerima promo tersebut.'))return;
  try{await request(`/api/promotions/${versionId}/retire`,{method:'POST'});toast('Promo berhasil dihentikan');await refreshCatalog();await loadPromotionManagement();}
  catch(error){toast(error.message);}
}

async function deletePromotion(versionId){
  if(!confirm('Hapus promo ini? Promo yang memiliki riwayat transaksi akan diarsipkan agar laporan lama tetap utuh.'))return;
  try{const result=await request(`/api/promotions/${versionId}`,{method:'DELETE'});toast(result.archived?'Promo diarsipkan karena sudah pernah digunakan':'Promo dihapus');await refreshCatalog();await loadPromotionManagement();}
  catch(error){toast(error.message);}
}

async function deleteVoucher(voucherId){
  if(!confirm('Hapus voucher ini? Riwayat penggunaan yang sudah terjadi tetap disimpan.'))return;
  try{const result=await request(`/api/vouchers/${voucherId}`,{method:'DELETE'});toast(result.archived?'Voucher diarsipkan':'Voucher dihapus');await loadPromotionManagement();}
  catch(error){toast(error.message);}
}

async function deleteReceiptVoucherCampaign(campaignId){
  if(!confirm('Hapus promo voucher struk ini? Voucher yang sudah tercetak tetap tersimpan untuk riwayat.'))return;
  try{const result=await request(`/api/receipt-voucher-campaigns/${campaignId}`,{method:'DELETE'});toast(result.archived?'Promo diarsipkan karena sudah menerbitkan voucher':'Promo dihapus');await loadPromotionManagement();}
  catch(error){toast(error.message);}
}

function employeeName(userId){
  return state.workforce.overview?.profiles?.find((item)=>item.user_id===userId)?.display_name??'Karyawan';
}

function outletName(outletId){
  return state.outlets.find((item)=>item.id===outletId)?.name??'Outlet';
}

function localDate(value){
  if(!value)return '-';
  return new Date(`${value}T00:00:00`).toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'});
}

function renderWorkforceOverview(){
  const data=state.workforce.overview;
  if(!data)return;
  const active=data.activeAttendance;
  el('attendance-current').innerHTML=active
    ? `<span class="status-badge submitted">SEDANG BEKERJA</span><h2>${new Date(active.clock_in_at).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}</h2><p class="muted">${localDate(active.work_date)} · ${outletName(active.outlet_id)}</p>`
    : '<span class="status-badge approved">BELUM ABSEN MASUK</span><p class="muted">Absensi dicatat menggunakan outlet dan perangkat aktif.</p>';
  el('attendance-action').textContent=active?'Absen keluar':'Absen masuk';
  el('attendance-action').dataset.action=active?'CLOCK_OUT':'CLOCK_IN';
  const profileOptions=data.profiles.map((item)=>`<option value="${escapeHtml(item.user_id)}">${escapeHtml(item.display_name)} · ${escapeHtml(roleLabels[item.role]??item.role)}</option>`).join('');
  el('schedule-user').innerHTML=profileOptions;
  el('target-user').innerHTML=profileOptions;
  const outletOptions=data.outlets.map((item)=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  el('schedule-outlet').innerHTML=outletOptions;
  el('target-outlet').innerHTML=`<option value="">Semua outlet</option>${outletOptions}`;
  const today=new Date().toISOString().slice(0,10);
  if(!el('schedule-date').value)el('schedule-date').value=today;
  if(!el('target-start').value)el('target-start').value=`${today.slice(0,7)}-01`;
  if(!el('target-end').value)el('target-end').value=new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7)),0)).toISOString().slice(0,10);
  el('workforce-schedule-list').innerHTML=data.schedules.length?data.schedules.map((schedule)=>{
    const attendance=data.attendance.find((item)=>item.schedule_id===schedule.id)
      ??data.attendance.find((item)=>item.user_id===schedule.user_id&&item.work_date===schedule.work_date);
    return `<article class="workforce-row"><div><strong>${escapeHtml(employeeName(schedule.user_id))}</strong><small>${localDate(schedule.work_date)} · ${escapeHtml(String(schedule.starts_at).slice(0,5))}–${escapeHtml(String(schedule.ends_at).slice(0,5))} · ${escapeHtml(outletName(schedule.outlet_id))}</small></div><div>${attendance?`<span class="status-badge ${attendance.clock_out_at?'approved':'submitted'}">${escapeHtml(attendance.status)}</span><small>${new Date(attendance.clock_in_at).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}${attendance.clock_out_at?`–${new Date(attendance.clock_out_at).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}`:''}</small>`:'<span class="status-badge">BELUM HADIR</span>'}</div></article>`;
  }).join(''):'<div class="empty-state compact">Belum ada jadwal bulan ini.</div>';
  el('workforce-performance').innerHTML=data.performance.map((item)=>{
    const salesTarget=Number(item.target?.sales_target??0),transactionTarget=Number(item.target?.transaction_target??0);
    const salesProgress=salesTarget?Math.min(100,Number(item.salesTotal)/salesTarget*100):0;
    return `<article class="surface performance-card"><div><strong>${escapeHtml(item.displayName)}</strong><small>${escapeHtml(roleLabels[item.role]??item.role)}</small></div><h2>${money.format(item.salesTotal)}</h2><div class="target-progress"><span style="width:${salesProgress}%"></span></div><small>Target ${money.format(salesTarget)} · ${item.transactions}/${transactionTarget} transaksi</small><div class="commission-value"><span>Komisi berjalan</span><strong>${money.format(item.commission)}</strong></div></article>`;
  }).join('')||'<div class="empty-state compact">Belum ada data kinerja.</div>';
}

async function loadWorkforceOverview(){
  try{state.workforce.overview=await request('/api/workforce/overview');renderWorkforceOverview();}
  catch(error){toast(error.message);}
}

async function clockAttendance(){
  const button=el('attendance-action');button.disabled=true;
  try{await request('/api/workforce/attendance',{method:'POST',body:JSON.stringify({action:button.dataset.action,note:el('attendance-note').value})});el('attendance-note').value='';toast(button.dataset.action==='CLOCK_IN'?'Absensi masuk tercatat':'Absensi keluar tercatat');await loadWorkforceOverview();}
  catch(error){toast(error.message);}finally{button.disabled=false;}
}

async function saveEmployeeSchedule(event){
  event.preventDefault();
  try{await request('/api/workforce/schedules',{method:'POST',body:JSON.stringify({userId:el('schedule-user').value,outletId:el('schedule-outlet').value,workDate:el('schedule-date').value,startsAt:el('schedule-start').value,endsAt:el('schedule-end').value,note:el('schedule-note').value})});toast('Jadwal karyawan tersimpan');el('schedule-note').value='';await loadWorkforceOverview();}
  catch(error){toast(error.message);}
}

async function saveEmployeeTarget(event){
  event.preventDefault();
  try{await request('/api/workforce/targets',{method:'POST',body:JSON.stringify({userId:el('target-user').value,outletId:el('target-outlet').value||null,periodStart:el('target-start').value,periodEnd:el('target-end').value,salesTarget:Number(el('target-sales').value),transactionTarget:Number(el('target-transactions').value),commissionType:el('target-commission-type').value,commissionValue:Number(el('target-commission-value').value)})});toast('Target dan komisi tersimpan');await loadWorkforceOverview();}
  catch(error){toast(error.message);}
}

function renderApprovals(){
  const data=state.workforce.approvals;if(!data)return;
  const actorName=(id)=>data.actors.find((item)=>item.user_id===id)?.display_name??'Pengguna';
  el('approval-request-list').innerHTML=data.requests.length?data.requests.map((item)=>{
    const actions=data.canManage&&item.status==='PENDING'&&item.requester_id!==state.session.user.id
      ? `<div class="approval-actions"><button class="button primary approval-decision" data-id="${item.id}" data-decision="APPROVE">Setujui tingkat ${Number(item.current_level)+1}</button><button class="button danger approval-decision" data-id="${item.id}" data-decision="REJECT">Tolak</button></div>`:'';
    return `<article class="approval-row"><div><span class="status-badge ${item.status==='APPROVED'?'approved':item.status==='PENDING'?'submitted':'danger'}">${escapeHtml(item.status)}</span><strong>${escapeHtml(item.action_type)} · ${money.format(item.amount)}</strong><small>${escapeHtml(actorName(item.requester_id))} · ${new Date(item.requested_at).toLocaleString('id-ID')}</small><p>${escapeHtml(item.reason)}</p><small>Tingkat ${item.current_level}/${item.required_levels}</small></div>${actions}</article>`;
  }).join(''):'<div class="empty-state compact">Belum ada permintaan persetujuan.</div>';
}

async function loadApprovals(){
  try{state.workforce.approvals=await request('/api/approvals');renderApprovals();}
  catch(error){toast(error.message);}
}

async function submitApprovalRequest(event){
  event.preventDefault();
  try{await request('/api/approvals/requests',{method:'POST',body:JSON.stringify({actionType:el('approval-action').value,amount:Number(el('approval-amount').value),reason:el('approval-reason').value})});el('approval-reason').value='';toast('Permintaan persetujuan diajukan');await loadApprovals();}
  catch(error){toast(error.message);}
}

async function saveApprovalPolicy(event){
  event.preventDefault();
  try{await request('/api/approvals/policies',{method:'POST',body:JSON.stringify({actionType:el('policy-action').value,minimumAmount:Number(el('policy-minimum').value),requiredLevels:Number(el('policy-levels').value)})});toast('Kebijakan persetujuan tersimpan');await loadApprovals();}
  catch(error){toast(error.message);}
}

async function decideApproval(event){
  const button=event.target.closest('.approval-decision');if(!button)return;
  const note=prompt(button.dataset.decision==='APPROVE'?'Catatan persetujuan (opsional)':'Alasan penolakan')??'';
  try{await request(`/api/approvals/${button.dataset.id}/decision`,{method:'POST',body:JSON.stringify({decision:button.dataset.decision,note})});toast('Keputusan persetujuan tersimpan');await loadApprovals();}
  catch(error){toast(error.message);}
}

async function loadWorkforceActivity(){
  try{
    const data=await request('/api/workforce/activity');state.workforce.activity=data.logs;
    el('workforce-activity-list').innerHTML=data.logs.map((item)=>`<article class="workforce-row"><div><strong>${escapeHtml(item.action.replaceAll('_',' '))}</strong><small>${escapeHtml(item.actor?.display_name??'Sistem')} · ${new Date(item.occurred_at).toLocaleString('id-ID')}</small></div><small>${escapeHtml(item.entity_type)}${item.details_json?.deviceId?` · Perangkat ${escapeHtml(String(item.details_json.deviceId).slice(0,8).toUpperCase())}`:''}</small></article>`).join('')||'<div class="empty-state compact">Belum ada aktivitas.</div>';
  }catch(error){toast(error.message);}
}

async function loadWorkforceReconciliations(){
  try{
    const data=await request('/api/workforce/reconciliations');state.workforce.reconciliations=data.shifts;
    el('workforce-reconciliation-list').innerHTML=data.shifts.map((shift)=>`<article class="surface reconciliation-card"><div class="settings-section-head"><div><strong>${escapeHtml(shift.cashierName)}</strong><small>${new Date(shift.closed_at).toLocaleString('id-ID')} · ${escapeHtml(outletName(shift.outlet_id))}</small></div><span class="status-badge ${Math.abs(Number(shift.difference))<0.01?'approved':'danger'}">${money.format(shift.difference)}</span></div><div class="reconciliation-methods">${shift.methods.map((method)=>`<div><span>${escapeHtml(method.payment_method)}</span><small>Sistem ${money.format(method.expected_amount)}</small><strong>${money.format(method.declared_amount)}</strong><em>${Number(method.difference)>=0?'+':''}${money.format(method.difference)}</em></div>`).join('')}</div></article>`).join('')||'<div class="empty-state">Belum ada shift yang direkonsiliasi.</div>';
  }catch(error){toast(error.message);}
}

async function refreshShift() {
  const data = await request('/api/shifts/current');
  state.currentShift = data.shift;
  cacheCurrentShift();
  renderShift(); renderCart();
}

function renderShift() {
  const shift = state.currentShift;
  el('top-shift').textContent = shift ? `SHIFT ${shift.id.slice(0, 8).toUpperCase()} · AKTIF` : 'SHIFT BELUM DIBUKA';
  el('shift-status').textContent = shift ? 'Sedang berjalan' : 'Belum dibuka';
  el('shift-status').className = `pill ${shift ? 'open' : 'closed'}`;
  el('open-shift-form').classList.toggle('hidden', Boolean(shift));
  el('close-shift-form').classList.toggle('hidden', !shift);
  el('cash-movement').disabled = !shift;
  if (!shift) {
    el('shift-detail').innerHTML = '<p class="muted">Buka shift sebelum menerima transaksi.</p>';
    el('shift-payment-reconciliation').innerHTML = '';
    el('cash-history').innerHTML = '';
    return;
  }
  el('shift-detail').innerHTML = `<div class="shift-fact"><span>Dibuka</span><strong>${new Date(shift.opened_at).toLocaleString('id-ID')}</strong></div><div class="shift-fact"><span>Modal awal</span><strong>${money.format(shift.opening_cash)}</strong></div><div class="shift-fact"><span>Kas seharusnya</span><strong>${money.format(shift.expectedNow ?? shift.opening_cash)}</strong></div><div class="shift-fact"><span>Kasir</span><strong>${shift.cashier_name}</strong></div>`;
  el('shift-payment-reconciliation').innerHTML=(shift.paymentTotals??[{method:'CASH',expectedAmount:shift.expectedNow??shift.opening_cash}]).map((item)=>`<label>${escapeHtml(item.method)} fisik/settlement <small>Sistem ${money.format(item.expectedAmount)}</small><input class="shift-declared-payment" data-method="${escapeHtml(item.method)}" type="number" min="0" step="1" value="${Math.round(Number(item.expectedAmount))}" required></label>`).join('');
  el('cash-history').innerHTML = (shift.movements ?? []).map((item) => `<div class="relation-item"><span>${item.note}<br><small>${item.movement_type === 'CASH_IN' ? 'Kas masuk' : 'Kas keluar'}</small></span><strong>${item.movement_type === 'CASH_IN' ? '+' : '−'}${money.format(item.amount)}</strong></div>`).join('');
}

async function openShift() {
  try {
    state.currentShift = await request('/api/shifts/open', { method: 'POST', body: JSON.stringify({ outletId: 'outlet-utama', openingCash: Number(el('opening-cash').value) }) });
    toast('Shift berhasil dibuka'); await refreshShift();
  } catch (error) { toast(error.message); }
}

async function addCashMovement() {
  if (!state.currentShift) return toast('Buka shift terlebih dahulu.');
  try {
    await request('/api/shifts/cash-movement', { method: 'POST', body: JSON.stringify({ shiftId: state.currentShift.id, movementType: el('cash-type').value, amount: Number(el('cash-amount').value), note: el('cash-note').value }) });
    toast('Pergerakan kas dicatat'); el('cash-amount').value = ''; el('cash-note').value = ''; await refreshShift();
  } catch (error) { toast(error.message); }
}

async function closeShift() {
  if (!state.currentShift) return;
  const pending = (await listCommands()).filter((command) => command.actorId === state.session.user.id);
  if (pending.length) return toast(`Sinkronkan ${pending.length} transaksi offline sebelum menutup shift.`);
  try {
    const declarations=[...document.querySelectorAll('.shift-declared-payment')].map((input)=>({method:input.dataset.method,declaredAmount:Number(input.value)}));
    const closed = await request('/api/shifts/close', { method: 'POST', body: JSON.stringify({ shiftId: state.currentShift.id, declarations }) });
    toast(`Shift ditutup. Selisih ${money.format(closed.difference)}`); state.currentShift = null; cacheCurrentShift(); renderShift(); renderCart(); if (state.session.permissions.includes('report.view')) await loadReport();
  } catch (error) { toast(error.message); }
}

function openUnitPicker(productId, { cartIndex = null, scanFallback = false } = {}) {
  const product = state.products.find((item) => item.id === productId);
  const units = sortedProductUnits(product);
  if (!product || !units.length) return toast('Produk atau satuan tidak ditemukan.');
  if (units.length === 1 && cartIndex === null) return addToCart(product.id, units[0].id);
  const line = cartIndex === null ? null : state.cart[cartIndex];
  const qty = Number(line?.qty ?? 1);
  const usedOutsideLine = productBaseQuantity(state.cart, product, cartIndex ?? -1);
  state.unitPicker = { productId, cartIndex, scanFallback };
  el('unit-picker-product').textContent = product.name;
  el('unit-picker-help').textContent = scanFallback
    ? 'Barcode dasar dikenali. Pilih satuan yang sedang dijual.'
    : cartIndex === null
      ? 'Pilih satuan yang ingin dimasukkan ke keranjang.'
      : `Ganti satuan untuk ${qty} barang ini.`;
  el('unit-picker-options').innerHTML = units.map((unit) => {
    const factor = Number(unit.factor ?? 0);
    const available = factor > 0 ? Math.floor(Math.max(0, Number(product.stockBase ?? 0) - usedOutsideLine) / factor) : 0;
    const fits = unitFitsStock({ cart: state.cart, product, unit, qty, excludeIndex: cartIndex ?? -1 });
    const current = line?.unitId === unit.id;
    const barcode = String(unit.barcode ?? '').trim();
    return `<button class="unit-picker-option ${current ? 'current' : ''}" type="button" data-unit-id="${unit.id}" ${fits ? '' : 'disabled'}>
      <span class="unit-picker-copy"><strong>${escapeHtml(unit.name)}</strong><small>${factor === 1 ? 'Satuan dasar' : `Isi ${factor} pcs`}${barcode ? ` · barcode terdaftar` : ' · tanpa barcode'}</small></span>
      <span class="unit-picker-stock"><strong>${available}</strong><small>tersedia${current ? ' · dipakai' : ''}</small></span>
    </button>`;
  }).join('');
  const dialog = el('unit-picker-dialog');
  if (!dialog.open) dialog.showModal();
}

function choosePosProduct(productId) {
  const product = state.products.find((item) => item.id === productId);
  const units = sortedProductUnits(product);
  if (!product || !units.length) return toast('Produk atau satuan tidak ditemukan.');
  if (units.length === 1) return addToCart(product.id, units[0].id);
  openUnitPicker(product.id);
}

async function addScannedProduct(product, scannedUnit) {
  if (shouldChooseUnitAfterScan(product, scannedUnit)) {
    openUnitPicker(product.id, { scanFallback: true });
    return;
  }
  await addToCart(product.id, scannedUnit.id);
}

async function changeCartUnit(index, unitId) {
  const line = state.cart[index];
  const product = state.products.find((item) => item.id === line?.productId);
  const unit = product?.units.find((item) => item.id === unitId);
  if (!line || !product || !unit) return toast('Produk atau satuan tidak ditemukan.');
  if (!unitFitsStock({ cart: state.cart, product, unit, qty: line.qty, excludeIndex: index })) {
    return toast(`${product.name}: stok tidak cukup untuk ${line.qty} ${unit.name}.`);
  }
  invalidateSaleAuthorization();
  const duplicateIndex = state.cart.findIndex((item, candidateIndex) =>
    candidateIndex !== index && item.productId === line.productId && item.unitId === unit.id
  );
  if (duplicateIndex >= 0) {
    state.cart[duplicateIndex].qty += Number(line.qty);
    state.cart.splice(index, 1);
  } else {
    line.unitId = unit.id;
  }
  state.unitPicker = null;
  el('unit-picker-dialog').close();
  await updateQuote();
}

async function addToCart(productId, unitId) {
  invalidateSaleAuthorization();
  const product=state.products.find((item)=>item.id===productId);
  const unit=product?.units.find((item)=>item.id===unitId);
  if(!product||!unit)return toast('Produk atau satuan tidak ditemukan.');
  const existing = state.cart.find((line) => line.productId === productId && line.unitId === unitId);
  const currentBase=state.cart.filter((line)=>line.productId===productId).reduce((sum,line)=>{
    const selectedUnit=product.units.find((item)=>item.id===line.unitId);
    return sum+Number(line.qty)*Number(selectedUnit?.factor??0);
  },0);
  if(currentBase+Number(unit.factor)>Number(product.stockBase??0))return toast(`${product.name}: stok tidak cukup. Tersedia ${product.stockBase} pcs.`);
  if (existing) existing.qty += 1;
  else state.cart.push({ productId, unitId, qty: 1 });
  el('product-search').value = '';
  renderProducts();
  await updateQuote();
}

async function changeQty(index, delta) {
  invalidateSaleAuthorization();
  const line=state.cart[index];
  if(delta>0){
    const product=state.products.find((item)=>item.id===line.productId);
    const unit=product?.units.find((item)=>item.id===line.unitId);
    const currentBase=state.cart.filter((item)=>item.productId===line.productId).reduce((sum,item)=>sum+Number(item.qty)*Number(product?.units.find((candidate)=>candidate.id===item.unitId)?.factor??0),0);
    if(!product||!unit||currentBase+Number(unit.factor)>Number(product.stockBase??0))return toast(`${product?.name??'Produk'}: jumlah melebihi stok tersedia.`);
  }
  state.cart[index].qty += delta;
  if (state.cart[index].qty <= 0) state.cart.splice(index, 1);
  await updateQuote();
}

async function updateQuote() {
  const revision = ++quoteRevision;
  if (quoteVerificationTimer) clearTimeout(quoteVerificationTimer);
  if (!state.cart.length) {
    state.quote = null;
    renderCart();
    return;
  }
  const input = {
    lines: state.cart,
    customerGroupId: el('customer-group').value,
    customerId:el('customer-select').value||null,
    ...(state.voucherCode?{voucherCode:state.voucherCode}:{}),
    at: new Date().toISOString(),
    ...(state.saleAuthorization ? { authorization: state.saleAuthorization } : {})
  };
  try {
    if (!state.saleAuthorization&&!state.voucherCode) {
      state.quote = quoteOffline({ ...input, products: state.products, promotions: state.promotions, at: new Date(input.at) });
      renderCart();
    }
    if (!navigator.onLine || state.saleAuthorization) return;
    quoteVerificationTimer = setTimeout(async () => {
      try {
        const verified = await request('/api/quote', { method: 'POST', body: JSON.stringify(input) });
        if (revision !== quoteRevision) return;
        state.quote = verified;
        renderCart();
      } catch (error) {
        if (revision === quoteRevision && error.status){if(state.voucherCode){state.voucherCode='';el('voucher-code').value='';}toast(`Harga belum terverifikasi: ${error.message}`);renderCart();}
      }
    }, 220);
  } catch (error) {
    toast(error.message);
  }
}

function renderCart() {
  const cartQuantity=state.cart.reduce((sum,line)=>sum+Number(line.qty??0),0);
  el('mobile-cart-count').textContent=cartQuantity;
  el('cart-heading-count').textContent=cartQuantity?`${cartQuantity.toLocaleString('id-ID')} barang · ${state.cart.length.toLocaleString('id-ID')} jenis`:'Belum ada barang';
  el('open-order-adjustment').classList.toggle('hidden',!state.session.permissions.includes('sale.adjust'));
  if (!state.quote) {
    el('cart-lines').innerHTML = '<div class="empty-state">Belum ada barang.<br><small>Scan barcode atau pilih produk.</small></div>';
    el('subtotal').textContent = money.format(0); el('discount').textContent = `−${money.format(0)}`; el('price-adjustment-summary').classList.add('hidden'); el('grand-total').textContent = money.format(0); el('pay-button').disabled = true; el('exact-cash-button').disabled = true; el('hold-cart').disabled = true;
    renderSaleAuthorizationStatus();
    el('voucher-status').textContent='';el('remove-voucher').classList.add('hidden');
    return;
  }
  el('cart-lines').innerHTML = state.quote.lines.map((line, index) => {
    const cartLine=state.cart[index],product=state.products.find((item)=>item.id===cartLine.productId),unit=product?.units.find((item)=>item.id===cartLine.unitId);
    const usedBase=state.cart.filter((item)=>item.productId===cartLine.productId).reduce((sum,item)=>sum+Number(item.qty)*Number(product?.units.find((candidate)=>candidate.id===item.unitId)?.factor??0),0);
    const atLimit=!product||!unit||usedBase+Number(unit.factor)>Number(product.stockBase??0);
    const canAdjust=state.session.permissions.includes('sale.adjust');
    return `<div class="cart-line"><div class="cart-line-main"><div><strong>${line.productName}</strong><br><small class="cart-line-meta">${line.qty} <button class="cart-unit-change" data-index="${index}" type="button" aria-label="Ganti satuan ${escapeHtml(line.productName)}">${escapeHtml(line.unitName)} <span aria-hidden="true">⌄</span></button> · ${money.format(line.gross / line.qty)} · stok ${product?.stockBase??0} pcs</small></div><strong>${money.format(line.total)}</strong></div><div class="cart-controls"><button data-index="${index}" data-delta="-1">−</button><span>${line.qty}</span><button data-index="${index}" data-delta="1" ${atLimit?'disabled title="Stok tidak mencukupi"':''}>+</button>${canAdjust?`<button class="manual-line-adjustment" data-index="${index}" type="button" ${state.saleAuthorization?'disabled':''}>Ubah harga</button>`:''}</div>${line.promotions.map((promo) => { const raised=Number(promo.discount)<0; return `<div class="promo-note ${promo.manual?'manual':''}">${promo.manual?'Harga manual ':''}${escapeHtml(promo.code)} v${promo.version}: ${raised?'+':'−'}${money.format(Math.abs(promo.discount))}${promo.approvedBy?` · ${escapeHtml(promo.approvedBy)}`:''}</div>`; }).join('')}</div>`;
  }).join('');
  document.querySelectorAll('.cart-controls button[data-delta]').forEach((button) => button.addEventListener('click', () => changeQty(Number(button.dataset.index), Number(button.dataset.delta))));
  document.querySelectorAll('.cart-unit-change').forEach((button) => button.addEventListener('click', () => {
    const index = Number(button.dataset.index);
    const line = state.cart[index];
    if (line) openUnitPicker(line.productId, { cartIndex: index });
  }));
  document.querySelectorAll('.manual-line-adjustment').forEach((button) => button.addEventListener('click', () => openSaleAdjustmentDialog(Number(button.dataset.index))));
  const receiptView=customerReceiptView(state.quote),internalAmount=receiptView.internalPriceAdjustment;
  el('subtotal').textContent = money.format(state.quote.subtotal);
  el('discount').textContent = `${Number(receiptView.discountTotal) < 0 ? '+' : '−'}${money.format(Math.abs(receiptView.discountTotal))}`;
  el('price-adjustment-summary').classList.toggle('hidden',!internalAmount);
  el('price-adjustment').textContent=`${Number(internalAmount)<0?'+':'−'}${money.format(Math.abs(internalAmount))}`;
  el('grand-total').textContent = money.format(state.quote.grandTotal); el('pay-button').disabled = !state.currentShift; el('exact-cash-button').disabled = !state.currentShift; el('hold-cart').disabled = false;
  el('voucher-status').textContent=state.quote.voucher?`${state.quote.voucher.code}: hemat ${money.format(state.quote.voucher.discount)}`:(state.voucherCode?'Memverifikasi voucher...':'');
  el('remove-voucher').classList.toggle('hidden',!state.voucherCode);
  renderSaleAuthorizationStatus();
}

function invalidateSaleAuthorization() {
  state.saleAuthorization = null;
  state.adjustmentTargetIndex = null;
}

function renderSaleAuthorizationStatus() {
  const panel = el('sale-authorization-status');
  if (!panel) return;
  panel.classList.toggle('hidden', !state.saleAuthorization);
  el('open-order-adjustment').classList.toggle('hidden',!state.session.permissions.includes('sale.adjust'));
  el('open-order-adjustment').disabled = !state.quote || Boolean(state.saleAuthorization);
  if (!state.saleAuthorization) {
    panel.innerHTML = '';
    return;
  }
  const authorization = state.saleAuthorization;
  const remaining = Math.max(0, Math.ceil((new Date(authorization.expiresAt).getTime() - Date.now()) / 60000));
  const isInternalPrice=authorization.adjustment?.scope==='LINE';
  const direction = Number(authorization.discountAmount) < 0 ? 'kenaikan' : 'penurunan';
  panel.innerHTML = `<div><strong>${isInternalPrice?'Harga internal':'Diskon transaksi'} disetujui</strong><small>${escapeHtml(authorization.approvedBy)} · ${isInternalPrice?direction:'diskon'} ${money.format(Math.abs(authorization.discountAmount))} · berlaku sekitar ${remaining} menit</small></div><button id="remove-sale-authorization" class="link-button" type="button">Batalkan</button>`;
  el('remove-sale-authorization').addEventListener('click', async () => {
    invalidateSaleAuthorization();
    await updateQuote();
    toast('Perubahan harga manual dibatalkan dari transaksi.');
  });
}

function openSaleAdjustmentDialog(lineIndex = null) {
  if (!state.quote || state.saleAuthorization) return;
  if (!state.session.permissions.includes('sale.adjust'))return toast('Akun Anda tidak memiliki hak mengubah harga atau diskon manual.');
  if (!navigator.onLine) return toast('Perubahan harga manual memerlukan koneksi internet.');
  state.adjustmentTargetIndex = lineIndex;
  const isLine = Number.isInteger(lineIndex);
  const line = isLine ? state.quote.lines[lineIndex] : null;
  el('adjustment-eyebrow').textContent=isLine?'PENYESUAIAN HARGA INTERNAL':'DISKON PELANGGAN';
  el('adjustment-title').textContent = isLine ? 'Ubah harga jual barang' : 'Diskon transaksi';
  el('adjustment-help').textContent=isLine
    ? 'Tetapkan harga jual akhir untuk transaksi ini. Rinciannya hanya tersimpan di audit internal dan tidak dicetak pada struk.'
    : 'Diskon ini diberikan kepada pelanggan dan akan ditampilkan sebagai diskon pada struk.';
  el('adjustment-target').innerHTML = isLine
    ? `<strong>${escapeHtml(line.productName)}</strong><small>${line.qty} ${escapeHtml(line.unitName)} · harga aktif ${money.format(line.total / line.qty)} per satuan</small>`
    : `<strong>Seluruh transaksi</strong><small>Total aktif ${money.format(state.quote.grandTotal)}</small>`;
  el('adjustment-mode-field').classList.toggle('hidden',isLine);
  el('adjustment-value-label').textContent=isLine?'Harga jual akhir per satuan':'Nilai diskon';
  el('adjustment-mode').innerHTML = isLine
    ? '<option value="FIXED_PRICE">Harga jual akhir per satuan</option>'
    : '<option value="PERCENT">Diskon persen</option><option value="FIXED_DISCOUNT">Potongan nominal</option>';
  el('adjustment-value').value = '';
  el('adjustment-reason').value = '';
  el('adjustment-error').textContent = '';
  el('sale-adjustment-dialog').showModal();
  el('approve-adjustment').textContent=isLine?'Simpan harga internal':'Terapkan diskon';
  el('adjustment-value').focus();
}

async function approveSaleAdjustment(event) {
  event.preventDefault();
  if (!navigator.onLine) return el('adjustment-error').textContent = 'Perubahan harga manual memerlukan koneksi internet.';
  const button = el('approve-adjustment');
  const line = Number.isInteger(state.adjustmentTargetIndex) ? state.cart[state.adjustmentTargetIndex] : null;
  const adjustment = {
    scope: line ? 'LINE' : 'ORDER',
    mode: el('adjustment-mode').value,
    value: Number(el('adjustment-value').value),
    reason: el('adjustment-reason').value,
    productId: line?.productId,
    unitId: line?.unitId
  };
  button.disabled = true;
  button.textContent = 'Memeriksa harga…';
  el('adjustment-error').textContent = '';
  try {
    const result = await request('/api/sale-authorizations', {
      method: 'POST',
      body: JSON.stringify({
        lines: state.cart,
        customerGroupId: el('customer-group').value,
        adjustment
      })
    });
    state.saleAuthorization = result.authorization;
    state.quote = result.quote;
    el('sale-adjustment-dialog').close();
    renderCart();
    toast(`Harga manual disetujui oleh ${result.authorization.approvedBy}.`);
  } catch (error) {
    el('adjustment-error').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = line ? 'Simpan harga internal' : 'Terapkan diskon';
  }
}

function sortedPurchaseProducts(query = '') {
  const normalized = String(query).trim().toLowerCase();
  return [...state.products]
    .filter((product) => !normalized || `${product.name} ${product.sku ?? ''} ${product.brand ?? ''} ${product.units.map((unit) => unit.barcode ?? '').join(' ')}`.toLowerCase().includes(normalized))
    .sort((a, b) => {
      const aZero = Number(Number(a.stockBase ?? 0) !== 0);
      const bZero = Number(Number(b.stockBase ?? 0) !== 0);
      return aZero - bZero || Number(a.stockBase ?? 0) - Number(b.stockBase ?? 0) || a.name.localeCompare(b.name, 'id');
    })
    .slice(0, 60);
}

function renderPurchaseProductResults(kind, query = '') {
  const container = el(`${kind}-product-results`);
  const products = sortedPurchaseProducts(query);
  container.innerHTML = products.map((product) => {
    const stock = Number(product.stockBase ?? 0);
    const baseUnit = product.units.find((unit) => Number(unit.factor) === 1) ?? product.units[0];
    return `<article class="purchase-product-option ${stock === 0 ? 'zero-stock' : ''}">
      <div><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.sku ?? '')} · ${escapeHtml(product.brand ?? 'tanpa merek')}</small></div>
      <div class="purchase-product-stock"><span>Stok</span><strong>${stock} pcs</strong></div>
      <button class="button secondary choose-purchase-product" type="button" data-kind="${kind}" data-product-id="${escapeHtml(product.id)}" data-unit-id="${escapeHtml(baseUnit?.id ?? '')}">Tambah</button>
    </article>`;
  }).join('') || '<div class="empty-state compact">Barang tidak ditemukan. Periksa nama, SKU, atau barcode.</div>';
  container.querySelectorAll('.choose-purchase-product').forEach((button) => button.addEventListener('click', () => choosePurchaseProduct(button.dataset.kind, button.dataset.productId, button.dataset.unitId)));
}

async function choosePurchaseProduct(kind, productId, unitId = null) {
  const product = state.products.find((item) => item.id === productId);
  if (!product) return;
  const unit = product.units.find((item) => item.id === unitId) ?? product.units.find((item) => Number(item.factor) === 1) ?? product.units[0];
  if (kind === 'po') await appendPoLine(product.id, unit?.id ?? null);
  else await appendRestockLine(product.id, 1, 0, unit?.name ?? 'pcs');
  const input = el(`${kind}-product-search`);
  input.value = '';
  renderPurchaseProductResults(kind);
  input.focus();
}

async function handlePurchaseProductEnter(kind, event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const value = event.currentTarget.value.trim();
  const exact = state.products.flatMap((product) => product.units.map((unit) => ({ product, unit }))).find(({ unit }) => unit.barcode === value);
  if (exact) return choosePurchaseProduct(kind, exact.product.id, exact.unit.id);
  const first = sortedPurchaseProducts(value)[0];
  if (first) return choosePurchaseProduct(kind, first.id);
  toast('Barang tidak ditemukan.');
}

function activatePurchaseScanner(kind) {
  const input = el(`${kind}-product-search`);
  input.value = '';
  input.placeholder = 'Scanner siap · scan barcode sekarang';
  input.focus();
  toast('Scanner siap. Scan barcode lalu barang akan ditambahkan.');
}

function barcodeMatch(value) {
  return state.products.flatMap((product) => product.units.map((unit) => ({ product, unit })))
    .find(({ unit }) => String(unit.barcode ?? '') === String(value ?? '').trim());
}

async function handleCameraBarcode(value) {
  const exact = barcodeMatch(value);
  if (!exact && barcodeCameraTarget === 'pos' && await tryScannedVoucher(value)) return;
  if (!exact) return toast(`Barcode ${value} belum terdaftar pada produk.`);
  if (barcodeCameraTarget === 'pos') {
    await addScannedProduct(exact.product, exact.unit);
    el('product-search').value = '';
    return;
  }
  if (['po', 'restock'].includes(barcodeCameraTarget)) {
    await choosePurchaseProduct(barcodeCameraTarget, exact.product.id, exact.unit.id);
  }
}

function stopBarcodeCamera() {
  if (barcodeCameraTimer) clearTimeout(barcodeCameraTimer);
  barcodeCameraTimer = null;
  try { barcodeCameraControls?.stop(); } catch {}
  barcodeCameraControls = null;
  barcodeCameraStream?.getTracks().forEach((track) => track.stop());
  barcodeCameraStream = null;
  const video = el('barcode-camera-video');
  if (video) video.srcObject = null;
  barcodeCameraTarget = null;
  barcodeCameraCompleting = false;
  if (el('barcode-camera-dialog')?.open) el('barcode-camera-dialog').close();
}

function cameraErrorMessage(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'Izin kamera ditolak. Buka pengaturan aplikasi/situs, izinkan Kamera, lalu coba lagi.';
  if (error?.name === 'NotFoundError') return 'Kamera belakang tidak ditemukan pada perangkat ini.';
  if (error?.name === 'NotReadableError') return 'Kamera sedang dipakai aplikasi lain. Tutup aplikasi kamera lalu coba lagi.';
  if (error?.name === 'OverconstrainedError') return 'Kamera perangkat tidak cocok dengan pengaturan pemindaian.';
  return 'Kamera tidak dapat dibuka. Periksa izin kamera lalu coba kembali.';
}

async function applyVoucherCode(){
  if(!navigator.onLine)return toast('Voucher hanya dapat diverifikasi saat online.');
  if(!state.cart.length)return toast('Keranjang masih kosong.');
  state.voucherCode=el('voucher-code').value.trim().toUpperCase();
  if(!state.voucherCode)return;
  try{
    state.quote=await request('/api/quote',{method:'POST',body:JSON.stringify({lines:state.cart,customerGroupId:el('customer-group').value,customerId:el('customer-select').value||null,voucherCode:state.voucherCode,at:new Date().toISOString(),...(state.saleAuthorization?{authorization:state.saleAuthorization}:{})})});
    renderCart();toast(`Voucher ${state.voucherCode} dipakai`);
  }catch(error){state.voucherCode='';el('voucher-code').value='';renderCart();toast(error.message);}
}

async function tryScannedVoucher(value){
  const code=String(value??'').trim().toUpperCase();
  if(!/^[A-Z0-9]{10}$/.test(code))return false;
  if(!state.cart.length){toast('Tambahkan barang sebelum memindai voucher.');return true;}
  el('voucher-code').value=code;
  await applyVoucherCode();
  return true;
}

async function completeCameraBarcode(value, controls = null) {
  if (!value || barcodeCameraCompleting || !barcodeCameraTarget) return;
  barcodeCameraCompleting = true;
  const targetAtScan = barcodeCameraTarget;
  try { controls?.stop(); } catch {}
  stopBarcodeCamera();
  barcodeCameraTarget = targetAtScan;
  await handleCameraBarcode(value);
  barcodeCameraTarget = null;
}

async function startNativeBarcodeDetection(video) {
  try {
    const preferred = ['ean_13','ean_8','code_128','code_39','upc_a','upc_e','qr_code'];
    const supported = typeof BarcodeDetector.getSupportedFormats === 'function' ? await BarcodeDetector.getSupportedFormats() : preferred;
    const formats = preferred.filter((format) => supported.includes(format));
    const detector = new BarcodeDetector(formats.length ? { formats } : undefined);
    const scan = async () => {
      if (!barcodeCameraStream || barcodeCameraCompleting) return;
      try {
        const results = await detector.detect(video);
        if (results[0]?.rawValue) return completeCameraBarcode(results[0].rawValue);
      } catch {}
      barcodeCameraTimer = setTimeout(scan, 180);
    };
    el('barcode-camera-status').textContent = 'Kamera aktif. Posisikan satu barcode di dalam kotak.';
    scan();
    return true;
  } catch {
    return false;
  }
}

async function handleNativeScannerBarcode(value) {
  const barcode = String(value ?? '').trim();
  if (!barcode) return;
  if (!el('page-pos').classList.contains('active')) return toast('Buka halaman Kasir sebelum memindai barang.');
  const exact = barcodeMatch(barcode);
  if (!exact && await tryScannedVoucher(barcode)) return;
  if (!exact) return toast(`Barcode ${barcode} belum terdaftar pada produk.`);
  await addScannedProduct(exact.product, exact.unit);
  el('product-search').value = '';
}

async function startZxingBarcodeDetection(video) {
  const Reader = window.ZXingBrowser?.BrowserMultiFormatReader;
  if (!Reader) throw new Error('ZXing fallback unavailable');
  const reader = new Reader(undefined, { delayBetweenScanAttempts: 180, delayBetweenScanSuccess: 500 });
  el('barcode-camera-status').textContent = 'Kamera aktif dalam mode kompatibel. Posisikan satu barcode di dalam kotak.';
  barcodeCameraControls = await reader.decodeFromStream(barcodeCameraStream, video, (result, _error, controls) => {
    if (result) completeCameraBarcode(result.getText(), controls);
  });
}

async function openBarcodeCamera(target) {
  if (!window.isSecureContext) return toast('Kamera hanya dapat digunakan melalui koneksi HTTPS yang aman.');
  if (!navigator.mediaDevices?.getUserMedia) return toast('Perangkat ini tidak menyediakan akses kamera.');
  barcodeCameraTarget = target;
  barcodeCameraCompleting = false;
  el('barcode-camera-status').textContent = 'Meminta izin kamera...';
  el('barcode-camera-dialog').showModal();
  try {
    barcodeCameraStream = await navigator.mediaDevices.getUserMedia({ audio:false, video:{ facingMode:{ ideal:'environment' }, width:{ ideal:1280 }, height:{ ideal:720 } } });
    const video = el('barcode-camera-video');
    video.srcObject = barcodeCameraStream;
    await video.play();
    const nativeStarted = 'BarcodeDetector' in window && await startNativeBarcodeDetection(video);
    if (!nativeStarted) await startZxingBarcodeDetection(video);
  } catch (error) {
    const message = cameraErrorMessage(error);
    stopBarcodeCamera();
    toast(message);
  }
}

async function renderRestock() {
  el('restock-body').innerHTML = '';
  el('restock-supplier').innerHTML = state.suppliers.length
    ? state.suppliers.map((supplier) => `<option value="${supplier.id}">${supplier.name}</option>`).join('')
    : '<option value="">Tambahkan supplier terlebih dahulu</option>';
  const receivingLocations = state.locations.filter((location) => ['STORE', 'WAREHOUSE'].includes(location.kind));
  el('restock-location').innerHTML = receivingLocations.length
    ? receivingLocations.map((location) => `<option value="${location.id}">${location.name} · ${location.kind === 'WAREHOUSE' ? 'Gudang' : 'Toko'}</option>`).join('')
    : '<option value="">Lokasi belum tersedia</option>';
  el('po-supplier').innerHTML = el('restock-supplier').innerHTML;
  el('supplier-return-supplier').innerHTML=el('restock-supplier').innerHTML;
  el('po-location').innerHTML = el('restock-location').innerHTML;
  const planningLocation = el('planning-location');
  const currentPlanningLocation = planningLocation.value;
  planningLocation.innerHTML = el('restock-location').innerHTML;
  planningLocation.value = currentPlanningLocation || state.restockPlanning.locationId || receivingLocations[0]?.id || '';
  const currentPlanningSupplier = el('planning-supplier-filter').value;
  el('planning-supplier-filter').innerHTML = '<option value="">Semua supplier</option>' + state.suppliers.map((supplier) => `<option value="${escapeHtml(supplier.id)}">${escapeHtml(supplier.name)}</option>`).join('');
  el('planning-supplier-filter').value = currentPlanningSupplier;
  const orderSupplier = el('planning-order-supplier');
  const currentOrderSupplier = orderSupplier.value;
  orderSupplier.innerHTML = '<option value="">Pilih supplier</option>' + state.suppliers.map((supplier) => `<option value="${escapeHtml(supplier.id)}">${escapeHtml(supplier.name)}</option>`).join('');
  orderSupplier.value = state.suppliers.some((supplier)=>supplier.id===currentOrderSupplier)
    ? currentOrderSupplier
    : state.suppliers.length===1 ? state.suppliers[0].id : '';
  el('restock-policy-supplier').innerHTML = el('restock-supplier').innerHTML;
  renderPurchaseProductResults('restock');
  renderPurchaseProductResults('po');
  el('restock-document').value = '';
  el('restock-history').innerHTML = '<p class="eyebrow">HISTORI MODAL</p><p class="muted">Klik “Riwayat” pada barang untuk melihat modal per supplier dan batch.</p>';
  el('receive-button').disabled = !state.suppliers.length || !receivingLocations.length || !state.products.length;
  syncRestockVisibility();
  setRestockWizardStep('document', { focus: false });
}

const purchaseStatus = {
  DRAFT: ['Draft', 'draft'], SUBMITTED: ['Menunggu persetujuan', 'submitted'], APPROVED: ['Disetujui', 'approved'],
  PARTIALLY_RECEIVED: ['Diterima sebagian', 'partial'], RECEIVED: ['Selesai', 'received'], CANCELLED: ['Dibatalkan', 'cancelled']
};

function showPurchaseView(name) {
  document.querySelectorAll('.purchase-view').forEach((view) => view.classList.toggle('hidden', view.id !== `purchase-view-${name}`));
  document.querySelectorAll('.purchase-tab').forEach((button) => button.classList.toggle('active', button.dataset.purchaseView === name));
  document.querySelectorAll('[data-purchase-view-target]').forEach((button)=>button.classList.toggle('active',button.dataset.purchaseViewTarget===name));
  if (name === 'receipt') setRestockWizardStep('document', { focus: false });
}

const restockWizardSteps = ['document','items','review','history'];
const restockWizardLabels = {
  document: 'Dokumen', items: 'Barang', review: 'Periksa', history: 'Histori'
};

function restockStepIsValid(step, { notify = true } = {}) {
  if (step === 'document') {
    if (!el('restock-supplier').value) { if (notify) toast('Pilih supplier terlebih dahulu.'); return false; }
    if (!el('restock-document').value.trim()) { if (notify) toast('Isi nomor faktur sebelum melanjutkan.'); return false; }
    if (!el('restock-location').value) { if (notify) toast('Pilih lokasi penerimaan.'); return false; }
  }
  if (step === 'items') {
    const rows = [...document.querySelectorAll('.restock-line')];
    if (!rows.length) { if (notify) toast('Tambahkan minimal satu barang sebelum melanjutkan.'); return false; }
    const invalid = rows.some((row) => {
      const qty = Number(row.querySelector('.restock-qty').value);
      const cost = Number(row.querySelector('.restock-cost').value);
      const expiry = row.querySelector('.restock-expiry').value.trim();
      if (!(qty > 0) || !(cost >= 0)) return true;
      if (expiry) try { parseExpiryDate(expiry); } catch { return true; }
      return false;
    });
    if (invalid) { if (notify) toast('Periksa jumlah, modal, dan tanggal EXP setiap barang.'); return false; }
  }
  return true;
}

function renderRestockReview() {
  const supplier = state.suppliers.find((item) => item.id === el('restock-supplier').value);
  const location = state.locations.find((item) => item.id === el('restock-location').value);
  const rows = [...document.querySelectorAll('.restock-line')];
  const heading = `<div class="restock-review-document"><div><span>Supplier</span><strong>${escapeHtml(supplier?.name ?? '-')}</strong></div><div><span>Faktur</span><strong>${escapeHtml(el('restock-document').value.trim() || '-')}</strong></div><div><span>Lokasi</span><strong>${escapeHtml(location?.name ?? '-')}</strong></div></div>`;
  const items = rows.map((row) => {
    const product = state.products.find((item) => item.id === row.dataset.product);
    const qty = Number(row.querySelector('.restock-qty').value);
    const unit = row.querySelector('.restock-unit').selectedOptions[0]?.textContent ?? 'pcs';
    const factor = Number(row.dataset.factor ?? 1);
    const cost = Number(row.querySelector('.restock-cost').value);
    const batch = row.querySelector('.restock-batch').value.trim();
    const expiry = row.querySelector('.restock-expiry').value.trim();
    return `<article class="restock-review-row"><div><strong>${escapeHtml(product?.name ?? row.dataset.product)}</strong><small>${qty.toLocaleString('id-ID')} ${escapeHtml(unit)} · ${Number(qty*factor).toLocaleString('id-ID')} pcs${batch?` · batch ${escapeHtml(batch)}`:''}${expiry?` · EXP ${escapeHtml(expiry)}`:''}</small></div><div><span>${money.format(cost)} / pcs</span><strong>${money.format(qty*factor*cost)}</strong></div></article>`;
  }).join('');
  el('restock-review-list').innerHTML = heading + items;
  updateRestockTotal();
}

function setRestockWizardStep(step, { focus = true, validate = false } = {}) {
  if (!restockWizardSteps.includes(step)) return;
  const currentIndex = restockWizardSteps.indexOf(state.restockWizardStep);
  const targetIndex = restockWizardSteps.indexOf(step);
  if (validate && targetIndex > currentIndex && step !== 'history') {
    const required = restockWizardSteps.slice(0, targetIndex);
    if (required.some((requiredStep) => !restockStepIsValid(requiredStep))) return;
  }
  if (step === 'review') renderRestockReview();
  state.restockWizardStep = step;
  document.querySelectorAll('[data-restock-step]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.restockStep !== step));
  document.querySelectorAll('[data-restock-step-target]').forEach((button) => {
    const index = restockWizardSteps.indexOf(button.dataset.restockStepTarget);
    button.classList.toggle('active', button.dataset.restockStepTarget === step);
    button.classList.toggle('completed', index < targetIndex);
    button.setAttribute('aria-current', button.dataset.restockStepTarget === step ? 'step' : 'false');
  });
  el('restock-wizard-back').disabled = targetIndex === 0;
  const next = el('restock-wizard-next');
  next.classList.toggle('hidden', targetIndex === restockWizardSteps.length - 1);
  next.textContent = targetIndex === 2 ? 'Terima dan tambah stok' : `Lanjut ke ${restockWizardLabels[restockWizardSteps[targetIndex + 1]] ?? ''}`;
  el('restock-wizard-progress').textContent = `Langkah ${targetIndex + 1} dari ${restockWizardSteps.length}`;
  if (focus) {
    const panel = document.querySelector(`[data-restock-step="${step}"]`);
    const steps = document.querySelector('.restock-wizard-steps');
    steps?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelector(`[data-restock-step-target="${step}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    panel?.querySelector('h2')?.setAttribute('tabindex','-1');
    panel?.querySelector('h2')?.focus({ preventScroll: true });
  }
}

function moveRestockWizard(direction) {
  const index = restockWizardSteps.indexOf(state.restockWizardStep);
  if (direction > 0 && state.restockWizardStep === 'review') return receivePurchase();
  const target = restockWizardSteps[index + direction];
  if (target) setRestockWizardStep(target, { validate: direction > 0 });
}

const planningUrgency = {
  OUT_OF_STOCK: ['Stok kosong','out'], CRITICAL: ['Segera pesan','critical'],
  WATCH: ['Pantau','watch'], HEALTHY: ['Aman','healthy']
};

async function loadRestockPlanning() {
  const locationId = el('planning-location').value || state.restockPlanning.locationId || state.locations.find((item)=>['STORE','WAREHOUSE'].includes(item.kind))?.id;
  if (!locationId) return;
  const params = new URLSearchParams({ locationId });
  const supplierId = el('planning-supplier-filter').value;
  if (supplierId) params.set('supplierId', supplierId);
  el('restock-planning-list').innerHTML = '<div class="empty-state compact">Menghitung kebutuhan stok...</div>';
  try {
    state.restockPlanning = await request(`/api/restock-planning?${params}`);
    const availableProducts=new Set(state.restockPlanning.recommendations.map((item)=>item.productId));
    for(const productId of state.restockSelection.keys())if(!availableProducts.has(productId))state.restockSelection.delete(productId);
    el('planning-lookback-days').value = state.restockPlanning.settings.lookbackDays;
    el('planning-approval-threshold').value = state.restockPlanning.settings.approvalThreshold;
    const canConfigureApproval = ['OWNER','ADMIN'].includes(state.session.user.role);
    for (const id of ['planning-lookback-days','planning-approval-threshold','save-planning-settings']) el(id).disabled = !canConfigureApproval;
    el('planning-settings-note').textContent = canConfigureApproval
      ? `PO Staff Pembelian sampai ${money.format(state.restockPlanning.settings.approvalThreshold)} disetujui otomatis.`
      : `Batas approval ${money.format(state.restockPlanning.settings.approvalThreshold)} dikelola Owner/Admin.`;
    renderRestockPlanning();
  } catch (error) {
    el('restock-planning-list').innerHTML = `<div class="empty-state compact"><strong>Rencana restok belum dapat dimuat.</strong><br><small>${escapeHtml(error.message)}</small></div>`;
  }
}

function renderRestockPlanning() {
  const neededOnly = el('planning-needed-only').checked;
  const query = el('planning-product-search').value.trim().toLocaleLowerCase('id-ID');
  const all = state.restockPlanning.recommendations ?? [];
  const list = all
    .filter((item) => !neededOnly || Number(item.suggestedQty) > 0 || item.urgency === 'OUT_OF_STOCK')
    .filter((item) => !query || `${item.productName} ${item.sku}`.toLocaleLowerCase('id-ID').includes(query))
    .sort((a,b) => Number(a.stock) - Number(b.stock) || String(a.productName).localeCompare(String(b.productName),'id'));
  const visible = list.slice(0,state.restockPlanningLimit);
  const productById=new Map(state.products.map((product)=>[product.id,product]));
  const count = (urgency) => all.filter((item) => item.urgency === urgency).length;
  const suggestedValue = all.reduce((sum,item)=>sum+(Number(item.suggestedQty)*Number(item.estimatedCost??0)),0);
  el('restock-planning-metrics').innerHTML = [
    ['Stok kosong',count('OUT_OF_STOCK')],['Perlu segera',count('CRITICAL')],
    ['Unit disarankan',all.reduce((sum,item)=>sum+Number(item.suggestedQty),0).toLocaleString('id-ID')],
    ['Estimasi draft',money.format(suggestedValue)]
  ].map(([label,value])=>`<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join('');
  el('restock-planning-list').innerHTML = visible.map((item)=>{
    const [urgencyLabel,urgencyClass]=planningUrgency[item.urgency]??[item.urgency,'draft'];
    const product=productById.get(item.productId);
    const price=product?retailPriceOf(product):Number(item.retailPrice??0);
    const selectedQty=state.restockSelection.get(item.productId);
    return `<button class="planning-compact-row ${selectedQty?'selected':''}" data-product-id="${escapeHtml(item.productId)}" type="button">
      ${productThumbnail(product ?? {name:item.productName})}
      <span class="planning-compact-product"><strong>${escapeHtml(item.productName)}</strong><small>${escapeHtml(item.sku)}</small></span>
      <span class="planning-compact-fact"><small>Harga jual</small><strong>${money.format(price)}</strong></span>
      <span class="planning-compact-fact"><small>Stok</small><strong>${Number(item.stock).toLocaleString('id-ID')} pcs</strong></span>
      <span class="planning-compact-choice">${selectedQty?`<small>Dipilih</small><strong>${Number(selectedQty).toLocaleString('id-ID')} pcs</strong>`:`<span class="status-badge ${urgencyClass}">${urgencyLabel}</span><strong>Pilih</strong>`}</span>
      <span class="planning-compact-arrow" aria-hidden="true">›</span>
    </button>`;
  }).join('') || '<div class="empty-state compact">Tidak ada barang yang sesuai pencarian atau filter.</div>';
  bindProductImageFallbacks(el('restock-planning-list'));
  if(list.length>visible.length)el('restock-planning-list').insertAdjacentHTML('beforeend',`<div class="planning-load-more"><small>Menampilkan ${visible.length.toLocaleString('id-ID')} dari ${list.length.toLocaleString('id-ID')} barang</small><button class="button secondary" type="button" data-planning-load-more>Tampilkan 100 berikutnya</button></div>`);
  syncPlanningSelection();
}

function planningItem(productId) {
  return state.restockPlanning.recommendations.find((item)=>item.productId===productId);
}

function syncPlanningSelection() {
  el('planning-selected-count').textContent = `${state.restockSelection.size} barang dipilih`;
  el('create-planning-draft').disabled = !state.restockSelection.size || !el('planning-order-supplier').value;
}

function openPlanningItem(productId) {
  const item=planningItem(productId);
  if(!item)return;
  const product=state.products.find((entry)=>entry.id===productId);
  const selectedQty=state.restockSelection.get(productId);
  const suggestedQty=Number(item.suggestedQty)>0?Number(item.suggestedQty):1;
  el('planning-item-product-id').value=productId;
  el('planning-item-name').textContent=item.productName;
  el('planning-item-sku').textContent=item.sku;
  el('planning-item-price').textContent=money.format(product?retailPriceOf(product):Number(item.retailPrice??0));
  el('planning-item-stock').textContent=`${Number(item.stock).toLocaleString('id-ID')} pcs`;
  el('planning-item-qty').value=selectedQty??suggestedQty;
  el('planning-item-suggestion').innerHTML=Number(item.suggestedQty)>0
    ? `<strong>Saran sistem: ${Number(item.suggestedQty).toLocaleString('id-ID')} pcs</strong><small>${item.supplierName?`Supplier yang pernah dipakai: ${escapeHtml(item.supplierName)}`:'Supplier dipilih setelah barang terkumpul.'}</small>`
    : '<strong>Belum perlu restok menurut sistem</strong><small>Anda tetap dapat menentukan jumlah secara manual.</small>';
  el('planning-item-error').textContent='';
  el('remove-planning-item').classList.toggle('hidden',!selectedQty);
  el('save-planning-item').textContent=selectedQty?'Perbarui jumlah':'Pilih barang';
  el('planning-item-compare').classList.toggle('hidden',!item.supplierId);
  el('planning-item-dialog').showModal();
  requestAnimationFrame(()=>{el('planning-item-qty').focus();el('planning-item-qty').select();});
}

function savePlanningItem(event) {
  event.preventDefault();
  const productId=el('planning-item-product-id').value;
  const qty=Number(el('planning-item-qty').value);
  if(!(qty>0)){el('planning-item-error').textContent='Jumlah pesanan harus lebih dari nol.';return;}
  state.restockSelection.set(productId,qty);
  el('planning-item-dialog').close();
  renderRestockPlanning();
}

function removePlanningItem() {
  state.restockSelection.delete(el('planning-item-product-id').value);
  el('planning-item-dialog').close();
  renderRestockPlanning();
}

function openRestockPolicy(productId) {
  const item = state.restockPlanning.recommendations.find((entry)=>entry.productId===productId);
  const product = state.products.find((entry)=>entry.id===productId);
  if (!item || !product) return;
  el('restock-policy-product-id').value=productId;
  el('restock-policy-product').textContent=product.name;
  el('restock-policy-supplier').value=item.supplierId??state.suppliers[0]?.id??'';
  el('restock-policy-minimum').value=item.minimumStock??product.minimumStock??0;
  el('restock-policy-maximum').value=item.maximumStock??0;
  el('restock-policy-safety').value=item.safetyStock??0;
  el('restock-policy-lead').value=item.leadTimeDays??7;
  el('restock-policy-preferred').checked=true;
  el('restock-policy-error').textContent='';
  el('restock-policy-dialog').showModal();
}

async function saveRestockPolicy(event) {
  event.preventDefault();
  const payload={
    locationId:el('planning-location').value,productId:el('restock-policy-product-id').value,
    supplierId:el('restock-policy-supplier').value,minimumStock:Number(el('restock-policy-minimum').value),
    maximumStock:Number(el('restock-policy-maximum').value),safetyStock:Number(el('restock-policy-safety').value),
    leadTimeDays:Number(el('restock-policy-lead').value),preferred:el('restock-policy-preferred').checked
  };
  if(payload.maximumStock>0&&payload.maximumStock<payload.minimumStock){el('restock-policy-error').textContent='Stok maksimum tidak boleh di bawah minimum.';return;}
  try{
    await request('/api/restock-planning/policy',{method:'PUT',body:JSON.stringify(payload)});
    el('restock-policy-dialog').close();toast('Kebijakan restok tersimpan.');await loadRestockPlanning();
  }catch(error){el('restock-policy-error').textContent=error.message;}
}

async function savePlanningSettings(event) {
  event.preventDefault();
  try{
    await request('/api/restock-planning/settings',{method:'PUT',body:JSON.stringify({
      approvalThreshold:Number(el('planning-approval-threshold').value),lookbackDays:Number(el('planning-lookback-days').value)
    })});
    toast('Aturan pembelian tersimpan.');await loadRestockPlanning();
  }catch(error){toast(error.message);}
}

async function createPlanningDraft() {
  const selected=[...state.restockSelection.entries()].map(([productId,orderQty])=>({...planningItem(productId),orderQty}));
  if(selected.some((item)=>!(item.orderQty>0)))return toast('Jumlah pesanan setiap barang harus lebih dari nol.');
  const supplierId=el('planning-order-supplier').value;
  if(!supplierId)return toast('Pilih supplier tujuan pesanan.');
  const maxLead=Math.max(...selected.map((item)=>Number(item.leadTimeDays??0)));
  const expected=new Date();expected.setDate(expected.getDate()+maxLead);
  const button=el('create-planning-draft');button.disabled=true;button.textContent='Membuat pesanan...';
  try{
    const result=await request('/api/restock-planning/draft',{method:'POST',body:JSON.stringify({
      supplierId,locationId:el('planning-location').value,expectedOn:expected.toISOString().slice(0,10),
      items:selected.map((item)=>({productId:item.productId,baseQty:item.orderQty,unitCost:Number(item.estimatedCost??0)}))
    })});
    let status='DRAFT';
    if(result.id){
      const submitted=await request(`/api/purchase-orders/${result.id}/submit`,{method:'POST',body:'{}'});
      status=submitted.status??status;
    }
    toast(`${result.po_no} siap diproses · ${purchaseStatus[status]?.[0]??status}.`);
    state.restockSelection.clear();
    await Promise.all([loadPurchaseOrders(),loadRestockPlanning()]);
    showPurchaseView('documents');
  }catch(error){toast(error.message);}
  finally{button.textContent='Buat pesanan supplier';syncPlanningSelection();}
}

async function loadPurchaseOrders() {
  try {
    const data = await request('/api/purchase-orders');
    state.purchaseOrders = data.orders;
    renderPurchaseOrders();
  } catch (error) {
    el('purchase-order-list').innerHTML = `<div class="empty-state compact"><strong>Dokumen pembelian belum dapat dimuat.</strong><br><small>${error.message}</small></div>`;
  }
}

function renderPurchaseOrders() {
  const filter = el('purchase-status-filter').value;
  const orders = state.purchaseOrders.filter((order) => !filter || order.status === filter);
  const count = (status) => state.purchaseOrders.filter((order) => status.includes(order.status)).length;
  el('purchase-metrics').innerHTML = [
    ['Semua PO', state.purchaseOrders.length], ['Perlu persetujuan', count(['SUBMITTED'])],
    ['Siap diterima', count(['APPROVED','PARTIALLY_RECEIVED'])], ['Selesai', count(['RECEIVED'])]
  ].map(([label,value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join('');
  el('purchase-order-list').innerHTML = orders.map((order) => {
    const [label, statusClass] = purchaseStatus[order.status] ?? [order.status, 'draft'];
    const ordered = order.items.reduce((sum,item)=>sum+item.ordered_qty,0);
    const received = order.items.reduce((sum,item)=>sum+item.received_qty,0);
    const progress = ordered ? Math.round((received/ordered)*100) : 0;
    const canApprove = ['OWNER','ADMIN'].includes(state.session.user.role);
    const actions = [
      order.status !== 'CANCELLED' ? `<button class="button secondary po-print" data-id="${order.id}">Cetak / bagikan</button>` : '',
      order.status === 'DRAFT' ? `<button class="button secondary po-open" data-id="${order.id}">Ubah</button><button class="button primary po-action" data-id="${order.id}" data-action="submit">Siapkan pesanan</button>` : '',
      order.status === 'SUBMITTED' && canApprove ? `<button class="button primary po-action" data-id="${order.id}" data-action="approve">Setujui</button>` : '',
      ['APPROVED','PARTIALLY_RECEIVED'].includes(order.status) ? `<button class="button primary po-receive" data-id="${order.id}">Terima barang</button>` : '',
      !['RECEIVED','CANCELLED','PARTIALLY_RECEIVED'].includes(order.status) && canApprove ? `<button class="button secondary po-action" data-id="${order.id}" data-action="cancel">Batalkan</button>` : ''
    ].join('');
    const overdue=order.overdue?'<span class="status-badge out">TERLAMBAT</span>':'';
    const approval=order.status==='SUBMITTED'?` · di atas batas ${money.format(order.approval_threshold??0)}`:order.status==='APPROVED'&&!order.approval_required?' · disetujui otomatis':'';
    return `<article class="purchase-document"><div class="purchase-document-main"><div><div class="document-number"><strong>${order.po_no}</strong><span class="status-badge ${statusClass}">${label}</span>${overdue}</div><p>${order.supplier_name}</p><small>Dibuat ${new Date(order.created_at).toLocaleDateString('id-ID')}${order.expected_on ? ` · estimasi ${new Date(`${order.expected_on}T00:00:00`).toLocaleDateString('id-ID')}` : ''}${approval}</small></div><div class="document-amount"><strong>${money.format(order.grand_total)}</strong><small>${order.items.length} jenis · sisa ${Number(order.outstanding_qty).toLocaleString('id-ID')} pcs</small></div></div><div class="receipt-progress"><span style="width:${progress}%"></span></div><div class="purchase-document-footer"><small>Diterima ${received} dari ${ordered} pcs · ${progress}%</small><div>${actions}</div></div></article>`;
  }).join('') || '<div class="empty-state compact">Belum ada Purchase Order dengan status ini.</div>';
  document.querySelectorAll('.po-open').forEach((button) => button.addEventListener('click', () => editPurchaseOrder(button.dataset.id)));
  document.querySelectorAll('.po-action').forEach((button) => button.addEventListener('click', () => transitionPurchaseOrder(button.dataset.id, button.dataset.action)));
  document.querySelectorAll('.po-receive').forEach((button) => button.addEventListener('click', () => prepareOrderReceipt(button.dataset.id)));
  document.querySelectorAll('.po-print').forEach((button) => button.addEventListener('click', () => openPurchaseOrderPrint(button.dataset.id)));
}

function purchaseOrderShareText(order) {
  const business=state.business??{};
  const lines=order.items.map((item,index)=>`${index+1}. ${item.product_name} — ${Number(item.ordered_qty).toLocaleString('id-ID')} pcs`).join('\n');
  return `${business.name??'Kasir Nusa'}\nSURAT PESANAN BARANG ${order.po_no}\nSupplier: ${order.supplier_name}\n\n${lines}\n\nEstimasi total: ${money.format(order.grand_total)}\nDokumen ini adalah permintaan barang, BUKAN BUKTI PEMBAYARAN.`;
}

function openPurchaseOrderPrint(orderId) {
  const order=state.purchaseOrders.find((item)=>item.id===orderId);
  if(!order)return;
  state.printingPurchaseOrder=order;
  const business=state.business??{};
  const supplier=state.suppliers.find((item)=>item.id===order.supplier_id);
  const location=state.locations.find((item)=>item.id===order.location_id);
  const rows=order.items.map((item,index)=>`<tr><td>${index+1}</td><td><strong>${escapeHtml(item.product_name)}</strong>${item.sku?`<small>${escapeHtml(item.sku)}</small>`:''}</td><td>${Number(item.ordered_qty).toLocaleString('id-ID')} pcs</td><td>${money.format(item.unit_cost)}</td><td>${money.format(item.line_total)}</td></tr>`).join('');
  el('purchase-order-print-content').innerHTML=`<article class="supplier-order-sheet">
    <header><div><span class="supplier-order-brand">${escapeHtml(business.name??'Kasir Nusa')}</span><small>${escapeHtml(business.address??'')}</small><small>${escapeHtml(business.phone??'')}</small></div><div><p>SURAT PESANAN BARANG</p><strong>${escapeHtml(order.po_no)}</strong></div></header>
    <div class="supplier-order-notice"><strong>BUKAN BUKTI PEMBAYARAN</strong><span>Dokumen ini adalah permintaan pengadaan barang kepada supplier.</span></div>
    <section class="supplier-order-meta"><div><span>Kepada supplier</span><strong>${escapeHtml(order.supplier_name)}</strong><small>${escapeHtml(supplier?.phone??'')}</small><small>${escapeHtml(supplier?.address??'')}</small></div><div><span>Dikirim ke</span><strong>${escapeHtml(location?.name??'-')}</strong><small>Dibuat ${new Date(order.created_at).toLocaleDateString('id-ID')}</small><small>${order.expected_on?`Diharapkan tiba ${new Date(`${order.expected_on}T00:00:00`).toLocaleDateString('id-ID')}`:'Tanggal tiba belum ditentukan'}</small></div></section>
    <table><thead><tr><th>No.</th><th>Barang</th><th>Jumlah</th><th>Estimasi / pcs</th><th>Jumlah</th></tr></thead><tbody>${rows}</tbody></table>
    <section class="supplier-order-total"><span>Estimasi total pesanan</span><strong>${money.format(order.grand_total)}</strong></section>
    ${order.notes?`<section class="supplier-order-notes"><span>Catatan untuk supplier</span><p>${escapeHtml(order.notes)}</p></section>`:''}
    <footer><div><span>Dibuat oleh</span><strong>${escapeHtml(state.session?.user?.displayName??state.session?.user?.name??'-')}</strong></div><div><span>Konfirmasi supplier</span><strong>____________________</strong></div></footer>
  </article>`;
  el('purchase-order-dialog').showModal();
}

async function sharePurchaseOrder() {
  const order=state.printingPurchaseOrder;
  if(!order)return;
  const text=purchaseOrderShareText(order);
  if(navigator.share){
    try{await navigator.share({title:`Pesanan ${order.po_no}`,text});return;}catch(error){if(error.name==='AbortError')return;}
  }
  await navigator.clipboard.writeText(text);
  toast('Ringkasan pesanan disalin. Tempelkan ke chat supplier.');
}

function printPurchaseOrder() {
  document.body.classList.add('printing-purchase-order');
  window.print();
  setTimeout(()=>document.body.classList.remove('printing-purchase-order'),500);
}

function newPurchaseOrder() {
  state.editingOrderId = null;
  state.poLines = [];
  el('po-editor-title').textContent = 'PO baru';
  el('po-editor-status').textContent = 'DRAFT';
  el('po-expected').value = '';
  el('po-notes').value = '';
  el('po-discount').value = 0; el('po-tax').value = 0; el('po-other-cost').value = 0;
  renderPoLines();
  showPurchaseView('order');
}

async function editPurchaseOrder(orderId) {
  const order = state.purchaseOrders.find((item) => item.id === orderId);
  if (!order || order.status !== 'DRAFT') return;
  state.editingOrderId = order.id;
  state.poLines = await Promise.all(order.items.map(async (item) => {
    const snapshot = await purchaseCostSnapshot(item.product_id, item.unit_cost, order.supplier_id);
    return { productId:item.product_id, qty:item.ordered_qty, factor:1, unitId:null, unitCost:item.unit_cost, lineDiscount:item.line_discount, ...snapshot };
  }));
  el('po-editor-title').textContent = order.po_no;
  el('po-supplier').value = order.supplier_id;
  el('po-location').value = order.location_id;
  el('po-expected').value = order.expected_on ?? '';
  el('po-notes').value = order.notes ?? '';
  el('po-discount').value = order.discount_amount; el('po-tax').value = order.tax_amount; el('po-other-cost').value = order.other_cost;
  renderPoLines();
  showPurchaseView('order');
}

async function purchaseCostSnapshot(productId, newCost, supplierId = el('po-supplier').value) {
  try {
    const comparison = await request('/api/cost-comparison', { method:'POST', body:JSON.stringify({ productId, supplierId:supplierId || null, newCost }) });
    return { previousCost:comparison.lastCost, previousSupplier:comparison.lastSupplier, previousDate:comparison.lastDate };
  } catch { return { previousCost:null, previousSupplier:null, previousDate:null }; }
}

async function appendPoLine(productId, preferredUnitId = null) {
  if (state.poLines.some((line) => line.productId === productId)) return toast('Produk sudah ada dalam Purchase Order.');
  const product = state.products.find((item) => item.id === productId);
  if (!product) return;
  const unit = product.units.find((item) => item.id === preferredUnitId) ?? product.units.find((item) => Number(item.factor) === 1) ?? product.units[0];
  const line = {
    productId,
    qty: 1,
    factor: unit?.factor ?? 1,
    unitId: unit?.id ?? null,
    unitCost: 0,
    lineDiscount: 0,
    previousCost: null,
    previousSupplier: 'Memuat histori modal...'
  };
  state.poLines.push(line);
  renderPoLines();
  try {
    const snapshot = await purchaseCostSnapshot(productId, 0);
    const activeLine = state.poLines.find((item) => item === line);
    if (!activeLine) return;
    Object.assign(activeLine, snapshot);
    if (activeLine.unitCost === 0 && snapshot.previousCost !== null) activeLine.unitCost = snapshot.previousCost;
    renderPoLines();
  } catch (error) {
    if (state.poLines.includes(line)) {
      line.previousSupplier = 'Histori belum dapat dimuat';
      renderPoLines();
    }
    toast(error.message);
  }
}

function retailPriceOf(product) {
  return product.priceRules.filter((rule)=>rule.customerGroupId==='retail' && Number(rule.minBaseQty)===1)
    .sort((a,b)=>Number(b.priority)-Number(a.priority))[0]?.unitPriceBase ?? null;
}

function markupPreservingRecommendation(newCost, previousCost, retailPrice) {
  if (!(newCost>=0) || !(previousCost>=0) || !(retailPrice>0)) return null;
  const previousProfit=retailPrice-previousCost;
  return { previousProfit, costChange:newCost-previousCost, recommended:Math.max(1,newCost+previousProfit) };
}

function applySuggestedRetailPrice(productId, recommended) {
  if (!state.session?.permissions?.includes('catalog.manage')) return toast('Hanya Owner/Admin yang dapat mengubah harga produk.');
  if (!state.managedProducts.some((product)=>product.id===productId)) return toast('Data produk belum siap. Buka menu Produk lalu coba lagi.');
  openProductEditor(productId);
  el('new-retail-price').value=recommended;
  toast('Harga saran sudah diisikan. Periksa lalu tekan Simpan produk.');
}

function poIntelligence(line, product) {
  const previous=line.previousCost;
  const change=previous>0?Math.round(((line.unitCost-previous)/previous)*10000)/100:null;
  const retail=retailPriceOf(product);
  const margin=retail>0?Math.round(((retail-line.unitCost)/retail)*10000)/100:null;
  const suggestion=markupPreservingRecommendation(line.unitCost,previous,retail);
  const level=change===null?'new':change<=0?'ok':change<=5?'warning':'danger';
  const applyButton=suggestion&&state.session?.permissions?.includes('catalog.manage')?`<button type="button" class="button secondary po-apply-suggested" data-product="${escapeHtml(product.id)}" data-price="${suggestion.recommended}">Gunakan saran</button>`:'';
  return `<div class="po-intelligence"><div><span>Modal terakhir supplier</span><strong>${previous===null?'Belum ada':money.format(previous)}</strong><small>${line.previousSupplier??'Data pembelian pertama'}</small></div><div><span>Perubahan modal</span>${costBadge({percentage:change,level})}</div><div><span>Harga ecer saat ini</span><strong>${retail===null?'Belum diatur':money.format(retail)}</strong><small>${margin===null?'Margin belum tersedia':`Margin ${margin}%`}</small></div><div><span>Saran harga jual</span><strong>${suggestion===null?'-':money.format(suggestion.recommended)}</strong><small>${suggestion===null?'Perlu histori modal dan harga ecer':`Pertahankan laba ${money.format(suggestion.previousProfit)} / pcs`}</small></div>${applyButton}<button type="button" class="button secondary po-compare-supplier">Bandingkan supplier</button></div>`;
}

function renderPoLines() {
  el('po-empty').classList.toggle('hidden', state.poLines.length>0);
  el('po-lines').innerHTML = state.poLines.map((line,index) => {
    const product = state.products.find((item) => item.id === line.productId);
    if (!product) return '';
    const units = product.units.map((unit) => `<option value="${unit.id}" data-factor="${unit.factor}" ${unit.id===line.unitId?'selected':''}>${unit.name}${unit.factor>1?` (${unit.factor} pcs)`:''}</option>`).join('');
    const lineTotal = Math.max(0,(line.qty*line.factor*line.unitCost)-line.lineDiscount);
    return `<article class="po-line" data-index="${index}"><div class="po-line-title"><div><strong>${product.name}</strong><small>${product.sku}</small></div><button class="icon-button po-remove" type="button">×</button></div><div class="po-line-grid"><label>Jumlah<input class="po-field" data-field="qty" type="number" min="0.000001" step="any" value="${line.qty}"></label><label>Satuan<select class="po-unit">${units}</select></label><label>Perkiraan modal / pcs<input class="po-field" data-field="unitCost" type="number" min="0" step="any" value="${line.unitCost}"></label><label>Diskon baris<input class="po-field" data-field="lineDiscount" type="number" min="0" step="any" value="${line.lineDiscount}"></label><div class="po-line-total"><span>Total baris</span><strong>${money.format(lineTotal)}</strong></div></div>${poIntelligence(line,product)}</article>`;
  }).join('');
  document.querySelectorAll('.po-field').forEach((input) => { input.addEventListener('input', () => { const line=state.poLines[Number(input.closest('.po-line').dataset.index)]; line[input.dataset.field]=Number(input.value); renderPoTotal(); input.closest('.po-line').querySelector('.po-line-total strong').textContent=money.format(Math.max(0,(line.qty*line.factor*line.unitCost)-line.lineDiscount)); }); input.addEventListener('change',renderPoLines); });
  document.querySelectorAll('.po-unit').forEach((select) => select.addEventListener('change', () => { const line=state.poLines[Number(select.closest('.po-line').dataset.index)]; line.unitId=select.value; line.factor=Number(select.selectedOptions[0]?.dataset.factor ?? 1); renderPoLines(); }));
  document.querySelectorAll('.po-remove').forEach((button) => button.addEventListener('click', () => { state.poLines.splice(Number(button.closest('.po-line').dataset.index),1); renderPoLines(); }));
  document.querySelectorAll('.po-compare-supplier').forEach((button) => button.addEventListener('click', () => { const line=state.poLines[Number(button.closest('.po-line').dataset.index)]; showSupplierComparison(line.productId); }));
  document.querySelectorAll('.po-apply-suggested').forEach((button) => button.addEventListener('click', () => applySuggestedRetailPrice(button.dataset.product,Number(button.dataset.price))));
  renderPoTotal();
}

function poAmounts() {
  const subtotal=state.poLines.reduce((sum,line)=>sum+Math.max(0,(line.qty*line.factor*line.unitCost)-line.lineDiscount),0);
  const discount=Number(el('po-discount').value||0), tax=Number(el('po-tax').value||0), other=Number(el('po-other-cost').value||0);
  return { subtotal,discount,tax,other,total:Math.max(0,subtotal-discount+tax+other) };
}

function renderPoTotal() { el('po-total').textContent=money.format(poAmounts().total); }

async function savePurchaseOrder() {
  if (!state.poLines.length) return toast('Tambahkan minimal satu barang ke PO.');
  if (state.poLines.some((line)=>!(line.qty>0)||!(line.unitCost>=0))) return toast('Periksa jumlah dan modal PO.');
  const amounts=poAmounts();
  const payload={ orderId:state.editingOrderId, supplierId:el('po-supplier').value, locationId:el('po-location').value, expectedOn:el('po-expected').value||null, notes:el('po-notes').value, discountAmount:amounts.discount, taxAmount:amounts.tax, otherCost:amounts.other, items:state.poLines.map((line)=>({productId:line.productId,baseQty:line.qty*line.factor,unitCost:line.unitCost,lineDiscount:line.lineDiscount})) };
  const button=el('save-po-draft'); button.disabled=true; button.textContent='Menyimpan...';
  try { const result=await request('/api/purchase-orders',{method:'POST',body:JSON.stringify(payload)}); toast(`${result.po_no} tersimpan sebagai draft`); await loadPurchaseOrders(); showPurchaseView('documents'); }
  catch(error){ toast(error.message); }
  finally{ button.disabled=false; button.textContent='Simpan draft PO'; }
}

async function transitionPurchaseOrder(orderId,action) {
  try { const result=await request(`/api/purchase-orders/${orderId}/${action}`,{method:'POST',body:'{}'}); toast(`${result.po_no}: ${purchaseStatus[result.status]?.[0] ?? result.status}`); await loadPurchaseOrders(); }
  catch(error){ toast(error.message); }
}

async function prepareOrderReceipt(orderId) {
  const order=state.purchaseOrders.find((item)=>item.id===orderId);
  if (!order) return;
  state.activePurchaseOrder=order;
  await renderRestock();
  el('restock-supplier').value=order.supplier_id; el('restock-supplier').disabled=true;
  el('restock-location').value=order.location_id; el('restock-location').disabled=true;
  el('active-po-banner').classList.remove('hidden');
  el('active-po-banner').innerHTML=`<div><span>PENERIMAAN BERDASARKAN PO</span><strong>${order.po_no} · ${order.supplier_name}</strong><small>Isi jumlah yang benar-benar datang. Sisa pesanan tetap terbuka.</small></div><button id="clear-active-po" class="button secondary">Lepas PO</button>`;
  el('clear-active-po').addEventListener('click', clearActivePurchaseOrder);
  for (const item of order.items.filter((line)=>line.remaining_qty>0)) await appendRestockLine(item.product_id,item.remaining_qty,item.unit_cost,'pcs');
  showPurchaseView('receipt');
}

async function clearActivePurchaseOrder() {
  state.activePurchaseOrder=null;
  el('active-po-banner').classList.add('hidden');
  el('restock-supplier').disabled=false; el('restock-location').disabled=false;
  await renderRestock();
}

async function refreshPoSupplierSnapshots() {
  state.poLines = await Promise.all(state.poLines.map(async (line) => ({ ...line, ...(await purchaseCostSnapshot(line.productId,line.unitCost)) })));
  renderPoLines();
}

async function showSupplierComparison(productId) {
  const product=state.products.find((item)=>item.id===productId);
  el('comparison-product-name').textContent=product?.name ?? 'Histori harga';
  el('supplier-comparison-content').innerHTML='<div class="empty-state compact">Memuat perbandingan...</div>';
  el('supplier-comparison-dialog').showModal();
  try {
    const data=await request(`/api/supplier-comparison/${encodeURIComponent(productId)}`);
    const selectedSupplier=el('po-supplier').value;
    const rows=data.suppliers.map((supplier,index)=>`<tr class="${supplier.supplierId===selectedSupplier?'selected-supplier':''}"><td><strong>${supplier.supplier}</strong>${index===0?'<span class="best-supplier">TERENDAH</span>':''}</td><td>${money.format(supplier.lastCost)}</td><td>${supplier.previousCost===null?'-':money.format(supplier.previousCost)}</td><td>${supplier.trendPercentage===null?'-':`${supplier.trendPercentage>0?'▲ ':supplier.trendPercentage<0?'▼ ':''}${supplier.trendPercentage}%`}</td><td>${supplier.percentageFromBest===0?'-':`+${supplier.percentageFromBest}%`}</td><td>${supplier.documentNo??'-'}</td><td>${supplier.batch??'-'}</td><td>${supplier.lastDate?new Date(supplier.lastDate).toLocaleDateString('id-ID'):'-'}</td></tr>`).join('');
    const recommended=null;
    el('supplier-comparison-content').innerHTML=`<div class="comparison-metrics"><div><span>Harga supplier terendah</span><strong>${data.bestCost===null?'-':money.format(data.bestCost)}</strong></div><div><span>Harga ecer sekarang</span><strong>${data.currentRetailPrice===null?'-':money.format(data.currentRetailPrice)}</strong></div><div><span>Saran harga jual</span><strong>${recommended===null?'-':money.format(recommended)}</strong></div></div><div class="table-wrap"><table><thead><tr><th>Supplier</th><th>Modal terbaru</th><th>Modal sebelumnya</th><th>Tren</th><th>Dari termurah</th><th>Dokumen</th><th>Batch</th><th>Tanggal</th></tr></thead><tbody>${rows||'<tr><td colspan="8">Belum ada histori pembelian dari supplier mana pun.</td></tr>'}</tbody></table></div><p class="comparison-note">Tren membandingkan dua penerimaan terakhir tiap supplier. Harga terendah memakai modal terbaru masing-masing supplier.</p>`;
  } catch(error) { el('supplier-comparison-content').innerHTML=`<p class="error">${error.message}</p>`; }
}

async function appendRestockLine(productId, qty = 1, newCost = 0, unit = 'pcs') {
  if (document.querySelector(`.restock-line[data-product="${productId}"]`)) return toast('Produk sudah ada pada daftar restok.');
  const product = state.products.find((item) => item.id === productId);
  if (!product) return;
  const row = document.createElement('article');
  const factor = product.units.find((item) => item.name === unit)?.factor ?? 1;
  row.className = 'restock-line'; row.dataset.product = productId; row.dataset.factor = factor;
  const unitOptions = product.units.map((item) => `<option value="${item.id}" data-factor="${item.factor}" ${item.name === unit ? 'selected' : ''}>${item.name}${item.factor > 1 ? ` (${item.factor} pcs)` : ''}</option>`).join('');
  row.innerHTML = `
    <div class="restock-card-header">
      <div><p class="eyebrow">BARANG RESTOK</p><strong>${product.name}</strong><small>${product.sku ?? ''}</small></div>
      <div class="restock-card-tools"><button type="button" class="button secondary history-button">Lihat riwayat</button><button type="button" class="icon-button remove-restock" aria-label="Hapus barang">×</button></div>
    </div>
    <div class="restock-card-grid">
      <label>Jumlah<input class="restock-qty" type="number" min="0.000001" step="any" value="${qty}"></label>
      <label>Satuan<select class="restock-unit">${unitOptions}</select></label>
      <label>Modal per pcs<input class="restock-cost" type="number" min="0" step="any" value="${newCost}"></label>
      <label>Nomor batch <span class="optional">Opsional</span><input class="restock-batch" placeholder="Contoh: BATCH-001"></label>
      <label>Tanggal kedaluwarsa <span class="optional">Opsional</span><input class="restock-expiry" type="text" inputmode="numeric" maxlength="10" placeholder="DD/MM/YYYY" aria-label="Tanggal kedaluwarsa format DD/MM/YYYY"></label>
      <div class="cost-insight"><span>Modal sebelumnya</span><strong class="last-cost">Memuat...</strong><small class="last-meta">Mengecek histori supplier</small><div class="cost-delta"><span class="badge neutral">CEK</span></div><div class="retail-suggestion hidden"><span>Saran harga ecer</span><strong class="suggested-retail">-</strong><small class="suggested-retail-note"></small><button type="button" class="button secondary apply-suggested-retail">Gunakan saran</button></div></div>
    </div>`;
  row.querySelector('.restock-cost').addEventListener('change', () => updateRestockComparison(row));
  row.querySelector('.restock-cost').addEventListener('input', updateRestockTotal);
  row.querySelector('.restock-qty').addEventListener('input', updateRestockTotal);
  row.querySelector('.restock-unit').addEventListener('change', (event) => {
    row.dataset.factor = event.target.selectedOptions[0]?.dataset.factor ?? 1;
    updateRestockTotal();
  });
  row.querySelector('.restock-expiry').addEventListener('input', formatExpiryInput);
  row.querySelector('.restock-expiry').addEventListener('blur', (event) => {
    if (!event.target.value) return;
    try { parseExpiryDate(event.target.value); event.target.setCustomValidity(''); }
    catch (error) { event.target.setCustomValidity(error.message); toast(error.message); }
  });
  row.querySelector('.history-button').addEventListener('click', () => showCostHistory(productId));
  row.querySelector('.apply-suggested-retail').addEventListener('click', () => applySuggestedRetailPrice(productId,Number(row.querySelector('.apply-suggested-retail').dataset.price)));
  row.querySelector('.remove-restock').addEventListener('click', () => { row.remove(); syncRestockVisibility(); });
  el('restock-body').append(row);
  syncRestockVisibility();
  updateRestockComparison(row);
}

function costMeta(comparison) {
  if (comparison.lastCost === null) return 'Belum ada histori supplier ini';
  return [comparison.lastSupplier, comparison.lastBatch ? `batch ${comparison.lastBatch}` : null, comparison.lastDocument].filter(Boolean).join(' · ');
}

function costBadge(comparison) {
  const label = comparison.percentage === null ? 'BARU' : `${comparison.percentage > 0 ? '▲' : comparison.percentage < 0 ? '▼' : '•'} ${comparison.percentage}%`;
  return `<span class="badge ${comparison.level.toLowerCase()}">${label}</span>`;
}

function formatExpiryInput(event) {
  event.target.value = formatExpiryValue(event.target.value);
  event.target.setCustomValidity('');
}

async function updateRestockComparison(row) {
  try {
    const comparison = await request('/api/cost-comparison', { method: 'POST', body: JSON.stringify({ productId: row.dataset.product, supplierId: el('restock-supplier').value || null, newCost: Number(row.querySelector('.restock-cost').value) }) });
    row.querySelector('.last-cost').textContent = comparison.lastCost === null ? 'Baru' : money.format(comparison.lastCost);
    row.querySelector('.last-meta').textContent = costMeta(comparison);
    row.querySelector('.cost-delta').innerHTML = costBadge(comparison);
    const product=state.products.find((item)=>item.id===row.dataset.product);
    const retail=product?retailPriceOf(product):null;
    const suggestion=markupPreservingRecommendation(Number(row.querySelector('.restock-cost').value),comparison.lastCost,retail);
    const suggestionBox=row.querySelector('.retail-suggestion');
    suggestionBox.classList.toggle('hidden',!suggestion);
    if(suggestion){
      row.querySelector('.suggested-retail').textContent=money.format(suggestion.recommended);
      row.querySelector('.suggested-retail-note').textContent=`Laba lama ${money.format(suggestion.previousProfit)} / pcs tetap dipertahankan`;
      row.querySelector('.apply-suggested-retail').dataset.price=suggestion.recommended;
    }
  } catch (error) { toast(error.message); }
}

function updateRestockTotal() {
  const total = [...document.querySelectorAll('.restock-line')].reduce((sum, row) => {
    const qty = Number(row.querySelector('.restock-qty').value);
    const factor = Number(row.dataset.factor ?? 1);
    const cost = Number(row.querySelector('.restock-cost').value);
    return sum + (qty * factor * cost);
  }, 0);
  el('restock-total').textContent = `Total modal ${money.format(total)}`;
}

function syncRestockVisibility() {
  const hasLines = Boolean(document.querySelector('.restock-line'));
  el('restock-empty').classList.toggle('hidden', hasLines);
  el('restock-table').classList.toggle('hidden', !hasLines);
  updateRestockTotal();
}

async function showCostHistory(productId) {
  const product = state.products.find((item) => item.id === productId);
  const supplierId = el('restock-supplier').value;
  setRestockWizardStep('history');
  el('restock-history').innerHTML = '<p class="eyebrow">HISTORI MODAL</p><p class="muted">Memuat histori...</p>';
  try {
    const data = await request(`/api/cost-history/${encodeURIComponent(productId)}${supplierId ? `?supplierId=${encodeURIComponent(supplierId)}` : ''}`);
    const rows = data.history.map((item) => `<tr><td>${item.occurredAt ? new Date(item.occurredAt).toLocaleDateString('id-ID') : '-'}</td><td>${item.supplier ?? '-'}</td><td>${item.documentNo ?? '-'}</td><td>${item.batch ?? '-'}</td><td>${item.expiresOn ? new Date(`${item.expiresOn}T00:00:00`).toLocaleDateString('id-ID') : '-'}</td><td>${item.baseQty ?? '-'}</td><td>${money.format(item.costPerBase ?? 0)}</td></tr>`).join('');
    el('restock-history').innerHTML = `<p class="eyebrow">HISTORI MODAL · ${product?.name ?? ''}</p><div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Supplier</th><th>Dokumen</th><th>Batch</th><th>Kedaluwarsa</th><th>Qty pcs</th><th>Modal / pcs</th></tr></thead><tbody>${rows || '<tr><td colspan="7">Belum ada histori untuk supplier ini.</td></tr>'}</tbody></table></div>`;
  } catch (error) {
    el('restock-history').innerHTML = `<p class="eyebrow">HISTORI MODAL</p><p class="error">${error.message}</p>`;
  }
}

function productName(productId) {
  return state.products.find((item) => item.id === productId)?.name ?? productId;
}

function locationName(locationId) {
  return state.locations.find((location) => location.id === locationId)?.name ?? locationId;
}

const expiryLabels = {
  EXPIRED: ['Kedaluwarsa', 'danger'], CRITICAL: ['0–30 hari', 'danger'], WARNING: ['31–60 hari', 'warning'],
  NOTICE: ['61–90 hari', 'notice'], NO_EXPIRY: ['Tanpa EXP', 'neutral'], SAFE: ['Aman', 'ok']
};

function displayExpiryDate(value) {
  return value ? new Date(`${value}T00:00:00Z`).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'Belum dicatat';
}

function expiryCountdown(batch) {
  if (batch.status === 'NO_EXPIRY') return 'Lengkapi tanggal kedaluwarsa';
  if (batch.daysToExpiry < 0) return `Lewat ${Math.abs(batch.daysToExpiry)} hari`;
  if (batch.daysToExpiry === 0) return 'Kedaluwarsa hari ini';
  return `Sisa ${batch.daysToExpiry} hari`;
}

function renderExpiryDashboard() {
  const metrics = state.expiryMetrics ?? {};
  el('expiry-metrics').innerHTML = [
    ['EXPIRED', 'Sudah lewat EXP', metrics.expiredBatches, metrics.expiredQty],
    ['CRITICAL', '0–30 hari', metrics.due30Batches, metrics.due30Qty],
    ['WARNING', '31–60 hari', metrics.due60Batches, metrics.due60Qty],
    ['NOTICE', '61–90 hari', metrics.due90Batches, metrics.due90Qty],
    ['NO_EXPIRY', 'Tanpa tanggal EXP', metrics.noExpiryBatches, metrics.noExpiryQty]
  ].map(([filter, label, batches, qty]) => `<button type="button" class="expiry-metric ${expiryLabels[filter][1]}" data-expiry-filter="${filter}"><span>${label}</span><strong>${batches ?? 0} batch</strong><small>${qty ?? 0} pcs</small></button>`).join('');
  if (state.expiryError) {
    el('expiry-batch-list').innerHTML = `<div class="expiry-empty"><strong>Kontrol batch belum aktif</strong><span>${escapeHtml(state.expiryError)}</span></div>`;
    return;
  }
  const search = el('expiry-search').value.trim().toLowerCase();
  const filter = el('expiry-filter').value;
  const rows = state.expiryBatches.filter((batch) => {
    const matchesSearch = !search || `${batch.productName} ${batch.sku} ${batch.batchNo} ${batch.supplierName}`.toLowerCase().includes(search);
    const matchesFilter = filter === 'ALL' || (filter === 'PRIORITY' ? batch.status !== 'SAFE' : batch.status === filter);
    return matchesSearch && matchesFilter;
  });
  el('expiry-batch-list').innerHTML = rows.map((batch, index) => {
    const [label, tone] = expiryLabels[batch.status];
    return `<article class="expiry-batch ${tone}"><div class="expiry-order">${index + 1}</div><div class="expiry-product"><div><span class="badge ${tone}">${label}</span><strong>${escapeHtml(batch.productName)}</strong><small>${escapeHtml(batch.sku)} · Batch ${escapeHtml(batch.batchNo)}</small></div><div class="expiry-date"><span>EXP ${displayExpiryDate(batch.expiresOn)}</span><strong>${expiryCountdown(batch)}</strong></div></div><div class="expiry-details"><div><span>Stok batch</span><strong>${batch.availableQty} pcs</strong></div><div><span>Lokasi</span><strong>${escapeHtml(batch.locationName)}</strong></div><div><span>Supplier</span><strong>${escapeHtml(batch.supplierName)}</strong></div><div><span>Nilai stok</span><strong>${money.format(batch.stockValue)}</strong></div></div></article>`;
  }).join('') || '<div class="expiry-empty"><strong>Tidak ada batch pada filter ini</strong><span>Ubah filter atau kata pencarian untuk melihat batch lainnya.</span></div>';
  document.querySelectorAll('[data-expiry-filter]').forEach((button) => button.addEventListener('click', () => { el('expiry-filter').value = button.dataset.expiryFilter; renderExpiryDashboard(); }));
}

function canViewInventoryCost() {
  return Boolean(state.session?.permissions?.includes('purchasing.view_cost'));
}

function inventoryProductBalance(productId) {
  const balances = state.inventory.filter((item) => item.product_id === productId);
  return {
    balances,
    total: balances.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0),
    value: balances.reduce((sum, item) => sum + (Number(item.quantity ?? 0) * Number(item.avg_cost ?? 0)), 0)
  };
}

function renderStockManagement() {
  const query = el('stock-management-search').value.trim().toLocaleLowerCase('id-ID');
  const filter = el('stock-management-filter').value;
  const canViewCost = canViewInventoryCost();
  const products = state.inventoryProducts.filter((product) => {
    const stock = inventoryProductBalance(product.id);
    const minimum = Number(product.minimumStock ?? 0);
    const matchesSearch = !query || `${product.name} ${product.sku} ${product.category} ${product.brand}`.toLocaleLowerCase('id-ID').includes(query);
    const matchesFilter = filter === 'ALL'
      || (filter === 'LOW' && stock.total > 0 && stock.total <= minimum)
      || (filter === 'EMPTY' && stock.total <= 0)
      || (filter === 'ACTIVE' && product.active !== false)
      || (filter === 'INACTIVE' && product.active === false);
    return matchesSearch && matchesFilter;
  });
  el('inventory-table').innerHTML = products.map((product) => {
    const stock = inventoryProductBalance(product.id);
    const minimum = Number(product.minimumStock ?? 0);
    const locationSummary = stock.balances
      .map((balance) => `${escapeHtml(locationName(balance.location_id))}: ${Number(balance.quantity).toLocaleString('id-ID')}`)
      .join(' · ') || 'Belum ada stok di lokasi';
    const tone = product.active === false ? 'inactive' : stock.total <= 0 ? 'empty' : stock.total <= minimum ? 'low' : 'safe';
    const status = product.active === false ? 'Nonaktif' : stock.total <= 0 ? 'Habis' : stock.total <= minimum ? 'Menipis' : 'Aman';
    return `<button type="button" class="stock-management-row" data-stock-product-id="${product.id}">
      ${productThumbnail(product)}
      <span class="stock-management-identity"><small>${escapeHtml(product.category || 'Tanpa kategori')} · ${escapeHtml(product.brand || 'Tanpa merek')}</small><strong>${escapeHtml(product.name)}</strong><span>SKU ${escapeHtml(product.sku)}</span></span>
      <span class="stock-management-location"><small>Per lokasi</small><strong>${locationSummary}</strong></span>
      <span class="stock-management-fact"><small>Total stok</small><strong>${stock.total.toLocaleString('id-ID')} pcs</strong><span>Minimum ${minimum.toLocaleString('id-ID')}</span></span>
      ${canViewCost ? `<span class="stock-management-fact"><small>Nilai stok</small><strong>${money.format(stock.value)}</strong><span>Detail modal per batch</span></span>` : ''}
      <span class="stock-status ${tone}">${status}</span><b aria-hidden="true">›</b>
    </button>`;
  }).join('') || '<div class="empty-state compact">Tidak ada barang yang sesuai pencarian atau filter.</div>';
  bindProductImageFallbacks(el('inventory-table'));
}

function stockEventLabel(eventType) {
  return ({
    PURCHASE_RECEIPT:'Penerimaan pembelian',
    STOCK_ADJUSTMENT_IN:'Tambah stok manual',
    STOCK_ADJUSTMENT_OUT:'Kurangi stok manual',
    MANUAL_IN:'Tambah stok manual',
    MANUAL_OUT:'Kurangi stok manual',
    SALE:'Penjualan',
    SALE_VOID:'Void penjualan',
    CUSTOMER_RETURN:'Retur pelanggan',
    SUPPLIER_RETURN:'Retur supplier',
    STOCK_COUNT:'Stok opname',
    TRANSFER_IN:'Transfer masuk',
    TRANSFER_OUT:'Transfer keluar',
    OPENING_BALANCE:'Saldo awal'
  })[eventType] ?? String(eventType ?? 'Pergerakan stok').replaceAll('_', ' ');
}

function renderStockProductOverview() {
  const detail = state.stockProductDetail;
  if (!detail) return;
  const total = detail.balances.reduce((sum, balance) => sum + Number(balance.quantity), 0);
  const activeBatches = detail.batches.filter((batch) => Number(batch.availableQty) > 0);
  const stockValue = activeBatches.reduce((sum, batch) => sum + Number(batch.stockValue ?? 0), 0);
  el('stock-product-summary').innerHTML = [
    ['Total stok', `${total.toLocaleString('id-ID')} pcs`],
    ['Lokasi berisi', `${detail.balances.filter((item) => Number(item.quantity) > 0).length} lokasi`],
    ['Batch aktif', `${activeBatches.length} batch`],
    ...(detail.canViewCost ? [['Nilai batch tersisa', money.format(stockValue)]] : [])
  ].map(([label, value]) => `<article><small>${label}</small><strong>${value}</strong></article>`).join('');
  const balances = detail.balances.map((balance) => `<article class="stock-location-row"><span><strong>${escapeHtml(balance.locationName)}</strong><small>${Number(balance.quantity) > 0 ? 'Stok tersedia' : 'Belum ada stok'}</small></span><span><strong>${Number(balance.quantity).toLocaleString('id-ID')} pcs</strong>${detail.canViewCost ? `<small>Modal rata-rata saldo ${money.format(balance.averageCost)}</small>` : ''}</span></article>`).join('');
  const batches = detail.batches.map((batch) => {
    const depleted = Number(batch.availableQty) <= 0;
    return `<article class="stock-batch-row ${depleted ? 'depleted' : ''}">
      <span><strong>Batch ${escapeHtml(batch.batchNo)}</strong><small>${escapeHtml(batch.locationName)} · diterima ${new Date(batch.receivedAt).toLocaleDateString('id-ID')}</small></span>
      <span><small>${batch.expiresOn ? `EXP ${displayExpiryDate(batch.expiresOn)} · FEFO` : 'Tanpa EXP · FIFO'}</small><strong>${Number(batch.availableQty).toLocaleString('id-ID')} / ${Number(batch.receivedQty).toLocaleString('id-ID')} pcs</strong></span>
      <span><small>${escapeHtml(batch.supplierName || '-')}</small>${detail.canViewCost ? `<strong>${money.format(batch.unitCost)} / pcs</strong>` : ''}</span>
    </article>`;
  }).join('');
  el('stock-product-overview').innerHTML = `<section class="stock-detail-section"><header><div><p class="eyebrow">STOK PER LOKASI</p><h3>Saldo yang tersedia</h3></div></header><div class="stock-location-list">${balances || '<div class="empty-state compact">Belum ada saldo stok.</div>'}</div></section>
    <section class="stock-detail-section"><header><div><p class="eyebrow">RIWAYAT LAPISAN STOK</p><h3>Stok lama dan stok baru tidak dicampur</h3><small>Batch bertanggal keluar dengan FEFO; batch tanpa EXP keluar dengan FIFO. Modal transaksi baru mengikuti batch yang benar-benar keluar.</small></div></header><div class="stock-batch-list">${batches || '<div class="empty-state compact">Belum ada penerimaan atau batch stok.</div>'}</div></section>`;
}

function renderStockProductLog() {
  const detail = state.stockProductDetail;
  if (!detail) return;
  const batches = new Map(detail.batches.map((batch) => [batch.id, batch]));
  const rows = detail.ledger.map((entry) => {
    const allocations = detail.allocations.filter((allocation) => allocation.saleId === entry.referenceId);
    const layerText = allocations.map((allocation) => {
      const batch = batches.get(allocation.batchId);
      return `Batch ${escapeHtml(batch?.batchNo ?? '-')} ${Number(allocation.quantity).toLocaleString('id-ID')} pcs × ${money.format(allocation.unitCost)}`;
    }).join(' · ');
    const expanded=state.stockLogEntryId===entry.id;
    const reason=entry.reason||entry.note||'Tidak ada keterangan tambahan.';
    const reference=entry.documentNo||entry.referenceId||'-';
    return `<article class="stock-log-item ${expanded?'expanded':''}">
      <button class="stock-log-row stock-log-button" type="button" data-stock-log-id="${escapeHtml(entry.id)}" aria-expanded="${expanded}">
      <span class="stock-log-delta ${Number(entry.delta) >= 0 ? 'in' : 'out'}">${Number(entry.delta) >= 0 ? '+' : ''}${Number(entry.delta).toLocaleString('id-ID')}</span>
      <span><strong>${escapeHtml(stockEventLabel(entry.eventType))}</strong><small>${new Date(entry.occurredAt).toLocaleString('id-ID')} · ${escapeHtml(entry.locationName)}</small><small>${escapeHtml(entry.actorName||'Sistem')} · ${escapeHtml(reason)}</small>${layerText ? `<small class="stock-layer-cost">${layerText}</small>` : ''}</span>
      <span><small>Saldo setelahnya</small><strong>${Number(entry.balanceAfter).toLocaleString('id-ID')} pcs</strong>${detail.canViewCost && entry.unitCost != null ? `<small>Modal ${money.format(entry.unitCost)} / pcs</small>` : ''}</span>
      <b aria-hidden="true">${expanded?'⌃':'›'}</b>
      </button>
      ${expanded?`<div class="stock-log-detail">
        <div><small>Penyebab</small><strong>${escapeHtml(reason)}</strong></div>
        <div><small>Dilakukan oleh</small><strong>${escapeHtml(entry.actorName||'Sistem')}</strong><span>${escapeHtml(entry.actorRole||'Akun sistem')}</span></div>
        <div><small>Waktu & lokasi</small><strong>${new Date(entry.occurredAt).toLocaleString('id-ID')}</strong><span>${escapeHtml(entry.locationName)}</span></div>
        <div><small>Perubahan stok</small><strong>${Number(entry.delta)>=0?'+':''}${Number(entry.delta).toLocaleString('id-ID')} pcs</strong><span>Saldo menjadi ${Number(entry.balanceAfter).toLocaleString('id-ID')} pcs</span></div>
        <div><small>Referensi dokumen</small><strong>${escapeHtml(reference)}</strong><span>${escapeHtml(stockEventLabel(entry.eventType))}</span></div>
        ${entry.batchNo?`<div><small>Batch</small><strong>${escapeHtml(entry.batchNo)}</strong><span>${entry.expiresOn?`EXP ${escapeHtml(displayExpiryDate(entry.expiresOn))}`:'Tanpa EXP'}</span></div>`:''}
        ${layerText?`<div class="stock-log-detail-wide"><small>Lapisan modal yang dipakai</small><strong>${layerText}</strong></div>`:''}
        ${entry.canOpenReceipt&&entry.saleId?`<div class="stock-log-detail-action"><button class="button primary" type="button" data-open-stock-sale="${escapeHtml(entry.saleId)}">Buka struk${entry.documentNo?` ${escapeHtml(entry.documentNo)}`:''}</button></div>`:''}
      </div>`:''}
    </article>`;
  }).join('');
  el('stock-product-log').innerHTML = `<section class="stock-detail-section"><header><div><p class="eyebrow">LOG BARANG</p><h3>Semua pergerakan stok</h3><small>Penerimaan, penjualan, retur, opname, transfer, dan penyesuaian tampil berurutan.</small></div></header><div class="stock-log-list">${rows || '<div class="empty-state compact">Belum ada pergerakan stok.</div>'}</div></section>`;
}

function syncStockAdjustmentLocationCost() {
  const detail = state.stockProductDetail;
  if (!detail?.canViewCost || state.stockProductView !== 'add') return;
  const balance = detail.balances.find((item) => item.locationId === el('stock-adjustment-location').value);
  if (balance && !el('stock-adjustment-unit-cost').dataset.edited) el('stock-adjustment-unit-cost').value = Number(balance.averageCost ?? 0);
}

function showStockProductView(view = 'overview') {
  if (!state.stockProductDetail) return;
  state.stockProductView = view;
  const adjustment = ['add', 'subtract'].includes(view);
  const incoming = view === 'add';
  el('stock-product-overview').classList.toggle('hidden', view !== 'overview');
  el('stock-product-log').classList.toggle('hidden', view !== 'log');
  el('stock-adjustment-form').classList.toggle('hidden', !adjustment);
  document.querySelectorAll('[data-stock-product-view]').forEach((button) => button.classList.toggle('active', button.dataset.stockProductView === view));
  if (!adjustment) return;
  el('stock-adjustment-direction').value = incoming ? 'IN' : 'OUT';
  el('stock-adjustment-cost-field').classList.toggle('hidden', !incoming || !state.stockProductDetail.canViewCost);
  el('stock-adjustment-batch-field').classList.toggle('hidden', !incoming);
  el('stock-adjustment-expiry-field').classList.toggle('hidden', !incoming);
  el('stock-adjustment-help').textContent = incoming
    ? 'Stok masuk dibuat sebagai batch baru. Isi modal pembelian agar keuntungan penjualan dihitung tepat.'
    : 'Stok akan dikurangi dari batch EXP terdekat (FEFO), lalu dari stok terlama tanpa EXP (FIFO).';
  el('submit-stock-adjustment').textContent = incoming ? 'Tambah stok' : 'Kurangi stok';
  el('stock-adjustment-error').textContent = '';
  el('stock-adjustment-quantity').focus();
  syncStockAdjustmentLocationCost();
}

async function openStockProduct(productId) {
  state.stockProductId = productId;
  state.stockProductDetail = null;
  state.stockLogEntryId = null;
  const product = state.inventoryProducts.find((item) => item.id === productId);
  el('stock-product-title').textContent = product?.name ?? 'Detail stok';
  el('stock-product-subtitle').textContent = product ? `${product.sku} · ${product.category || 'Tanpa kategori'}` : 'Memuat barang...';
  el('stock-product-summary').innerHTML = '<div class="empty-state compact">Memuat ringkasan stok...</div>';
  el('stock-product-overview').innerHTML = '<div class="empty-state compact">Memuat batch dan lokasi...</div>';
  el('stock-product-log').innerHTML = '';
  el('stock-adjustment-form').reset();
  el('stock-adjustment-unit-cost').dataset.edited = '';
  el('edit-stock-product').classList.toggle('hidden', !state.session.permissions.includes('catalog.manage'));
  if (!el('stock-product-dialog').open) el('stock-product-dialog').showModal();
  try {
    const detail = await request(`/api/inventory-products/${productId}`);
    detail.product = {
      ...detail.product,
      minimumStock: Number(detail.product.minimum_stock ?? 0),
      trackExpiry: Boolean(detail.product.track_expiry),
      imageUrl: detail.product.image_url ?? ''
    };
    state.stockProductDetail = detail;
    el('stock-product-title').textContent = detail.product.name;
    el('stock-product-subtitle').textContent = `${detail.product.sku} · ${detail.product.category || 'Tanpa kategori'} · ${detail.product.active === false ? 'Nonaktif' : 'Aktif'}`;
    const locationIds = new Set(detail.balances.map((balance) => balance.locationId));
    const locations = [...state.locations.filter((location) => locationIds.has(location.id)), ...state.locations.filter((location) => !locationIds.has(location.id))];
    el('stock-adjustment-location').innerHTML = locations.map((location) => `<option value="${location.id}">${escapeHtml(location.name)}</option>`).join('');
    renderStockProductOverview();
    renderStockProductLog();
    showStockProductView('overview');
  } catch (error) {
    el('stock-product-summary').innerHTML = '';
    el('stock-product-overview').innerHTML = `<div class="empty-state compact"><strong>Detail stok gagal dimuat</strong><small>${escapeHtml(error.message)}</small></div>`;
  }
}

async function openStockSaleReceipt(saleId) {
  try {
    const data=await request(`/api/inventory-sales/${saleId}/receipt`);
    el('stock-product-dialog').close();
    if(state.session.permissions.includes('report.view')){
      showPage('reports-sales');
      state.posSales=[data.sale,...state.posSales.filter((sale)=>sale.id!==data.sale.id)];
      state.selectedPosSaleId=data.sale.id;
      renderPosSales();
      openHistoryReceiptPage(data.sale);
    }else{
      renderReceipt(data.sale,data.sale.payments??[],{allowAutoPrint:false,closeLabel:'Tutup'});
    }
  } catch (error) {
    toast(error.message);
  }
}

async function submitStockAdjustment(event) {
  event.preventDefault();
  if (!state.stockProductId || !state.stockProductDetail) return;
  const button = el('submit-stock-adjustment');
  const direction = el('stock-adjustment-direction').value;
  el('stock-adjustment-error').textContent = '';
  button.disabled = true;
  button.textContent = 'Menyimpan...';
  try {
    const payload = {
      direction,
      locationId: el('stock-adjustment-location').value,
      quantity: Number(el('stock-adjustment-quantity').value),
      reason: el('stock-adjustment-reason').value.trim(),
      ...(direction === 'IN' ? {
        unitCost: Number(el('stock-adjustment-unit-cost').value || 0),
        batchNo: el('stock-adjustment-batch').value.trim() || null,
        expiresOn: el('stock-adjustment-expiry').value || null
      } : {})
    };
    await request(`/api/inventory-products/${state.stockProductId}/adjustments`, {
      method:'POST',
      headers:{'idempotency-key':crypto.randomUUID()},
      body:JSON.stringify(payload)
    });
    toast(direction === 'IN' ? 'Stok berhasil ditambahkan' : 'Stok berhasil dikurangi');
    await Promise.all([loadInventory(), refreshCatalog()]);
    await openStockProduct(state.stockProductId);
  } catch (error) {
    el('stock-adjustment-error').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = direction === 'IN' ? 'Tambah stok' : 'Kurangi stok';
  }
}

async function loadInventory() {
  const [data, expiry] = await Promise.all([
    request('/api/inventory'),
    request('/api/expiry-dashboard').catch((error) => ({ batches: [], metrics: null, error: error.message }))
  ]);
  state.inventory = data.balances;
  state.ledger = data.ledger;
  state.inventoryProducts = (data.products ?? state.products).map((product) => ({
    ...product,
    minimumStock: Number(product.minimum_stock ?? product.minimumStock ?? 0),
    trackExpiry: Boolean(product.track_expiry ?? product.trackExpiry),
    imageUrl: product.image_url ?? product.imageUrl ?? '',
    active: product.active !== false
  }));
  state.expiryBatches = expiry.batches ?? [];
  state.expiryMetrics = expiry.metrics ?? null;
  state.expiryError = expiry.error ?? null;
  const storeLocation = state.locations.find((location) => location.kind === 'STORE');
  renderStockManagement();
  el('count-fields').innerHTML = state.inventoryProducts.map((product) => {
    const balance = state.inventory.find((item) => item.location_id === storeLocation?.id && item.product_id === product.id);
    return `<label class="count-field"><span>${escapeHtml(product.name)}</span><input data-count-product="${product.id}" type="number" min="0" value="${balance?.quantity ?? 0}"></label>`;
  }).join('');
  el('ledger-table').innerHTML = `<table><thead><tr><th>Waktu</th><th>Lokasi</th><th>Produk</th><th>Jenis</th><th>Perubahan</th><th>Saldo</th></tr></thead><tbody>${state.ledger.map((item) => `<tr><td>${new Date(item.occurred_at).toLocaleString('id-ID')}</td><td>${locationName(item.location_id)}</td><td>${productName(item.product_id)}</td><td>${item.event_type.replaceAll('_', ' ')}</td><td>${item.delta > 0 ? '+' : ''}${item.delta}</td><td>${item.balance_after}</td></tr>`).join('') || '<tr><td colspan="6">Belum ada pergerakan stok.</td></tr>'}</tbody></table>`;
  renderExpiryDashboard();
}

async function postStockCount() {
  const items = [...document.querySelectorAll('[data-count-product]')].map((input) => ({ productId: input.dataset.countProduct, countedQty: Number(input.value) }));
  const storeLocation = state.locations.find((location) => location.kind === 'STORE');
  if (!storeLocation) return toast('Lokasi toko belum dikonfigurasi.');
  try {
    const result = await request('/api/stock-counts', { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ locationId: storeLocation.id, items }) });
    toast(`Opname ${result.countNo} berhasil diposting`);
    await loadInventory(); await refreshCatalog();
  } catch (error) { toast(error.message); }
}

function showRestockReceiveError(message = '') {
  const errorBox = el('restock-receive-error');
  errorBox.textContent = message;
  errorBox.classList.toggle('hidden', !message);
  if (message) toast(message);
}

async function receivePurchase() {
  if (state.restockReceiving) return;
  showRestockReceiveError();
  const selectedSupplier = state.suppliers.find((supplier) => supplier.id === el('restock-supplier').value);
  let lines;
  try {
    lines = [...document.querySelectorAll('.restock-line')].map((row) => {
      const productId = row.dataset.product;
      const qty = Number(row.querySelector('.restock-qty').value);
      const expiry = row.querySelector('.restock-expiry').value.trim();
      return {
        productId,
        baseQty: qty * Number(row.dataset.factor ?? 1),
        unitCost: Number(row.querySelector('.restock-cost').value),
        batchNo: row.querySelector('.restock-batch').value.trim() || null,
        expiresOn: expiry ? parseExpiryDate(expiry) : null
      };
    });
  } catch (error) {
    return showRestockReceiveError(error.message);
  }
  if (!selectedSupplier) return showRestockReceiveError('Pilih atau tambahkan supplier terlebih dahulu.');
  if (!el('restock-location').value) return showRestockReceiveError('Pilih lokasi penerimaan.');
  if (!el('restock-document').value.trim()) return showRestockReceiveError('Nomor dokumen pembelian wajib diisi.');
  if (!lines.length) return showRestockReceiveError('Tambahkan minimal satu barang restok.');
  if (lines.some((line) => !(line.baseQty > 0) || !(line.unitCost >= 0))) return showRestockReceiveError('Periksa jumlah dan modal setiap barang.');
  const payload = {
    documentNo: el('restock-document').value.trim(),
    supplierId: selectedSupplier.id,
    supplierName: selectedSupplier.name,
    locationId: el('restock-location').value,
    items: lines
  };
  const button = el('receive-button');
  const wizardButton = el('restock-wizard-next');
  state.restockReceiving = true;
  button.disabled = true;
  button.textContent = 'Menyimpan restok...';
  wizardButton.disabled = true;
  wizardButton.textContent = 'Menyimpan restok...';
  try {
    const endpoint = state.activePurchaseOrder ? `/api/purchase-orders/${state.activePurchaseOrder.id}/receipts` : '/api/purchase-receipts';
    const receipt = await request(endpoint, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(payload) });
    toast(`Penerimaan ${receipt.document_no ?? receipt.documentNo} berhasil · stok sudah bertambah`);
    if (state.session.permissions.includes('inventory.manage')) await loadInventory();
    await refreshCatalog();
    if (state.activePurchaseOrder) {
      state.activePurchaseOrder = null;
      el('active-po-banner').classList.add('hidden');
      el('restock-supplier').disabled = false; el('restock-location').disabled = false;
      await loadPurchaseOrders();
      showPurchaseView('documents');
    }
    await renderRestock();
  } catch (error) {
    showRestockReceiveError(error.message);
  } finally {
    state.restockReceiving = false;
    button.disabled = false;
    button.textContent = 'Terima dan tambah stok';
    wizardButton.disabled = false;
    if (state.restockWizardStep === 'review') wizardButton.textContent = 'Terima dan tambah stok';
  }
}

function renderSupplierReturnReceipt(){
  const receipt=state.supplierReturnReceipt;if(!receipt)return;
  const statusLabel=receipt.status==='RETURNABLE'?'BELUM DIRETUR':receipt.status==='PARTIALLY_RETURNED'?'RETUR SEBAGIAN':'TIDAK ADA STOK TERSEDIA';
  el('supplier-return-summary').innerHTML=`<div><p class="eyebrow">PENERIMAAN DITEMUKAN</p><h2>${escapeHtml(receipt.documentNo)}</h2><small>${escapeHtml(receipt.supplierName)} · ${escapeHtml(receipt.locationName)} · ${new Date(receipt.occurredAt).toLocaleString('id-ID')}</small></div><div><span class="status-badge ${receipt.status==='NOT_RETURNABLE'?'inactive':'approved'}">${statusLabel}</span><strong>${money.format(receipt.returnableCredit)}</strong><small>Maksimum nilai yang masih dapat diretur</small></div>`;
  el('supplier-return-item-list').innerHTML=receipt.lines.map((line)=>`<article class="supplier-return-line ${line.maxReturnQty<=0?'completed':''}" data-receipt-item-id="${escapeHtml(line.receiptItemId)}"><label class="return-line-select"><input class="supplier-return-select" type="checkbox" ${line.maxReturnQty<=0?'disabled':''}><span><strong>${escapeHtml(line.productName)}</strong><small>${escapeHtml(line.sku)} · batch ${escapeHtml(line.batchNo??'-')} · EXP ${formatExpiryValue(line.expiresOn)}</small></span></label><div class="supplier-return-line-data"><span>Diterima<strong>${line.receivedQty.toLocaleString('id-ID')} pcs</strong></span><span>Sudah retur<strong>${line.returnedQty.toLocaleString('id-ID')} pcs</strong></span><span>Stok batch tersedia<strong>${line.batchAvailable.toLocaleString('id-ID')} pcs</strong></span><span>Modal asli<strong>${money.format(line.unitCost)}</strong></span><label>Jumlah retur<input class="supplier-return-qty" type="number" min="0.000001" max="${line.maxReturnQty}" step="any" value="${line.maxReturnQty||0}" ${line.maxReturnQty<=0?'disabled':''}></label><span class="supplier-return-line-credit">Nilai kredit<strong>${money.format(line.maxReturnQty*line.unitCost)}</strong></span></div></article>`).join('')||'<div class="empty-state compact">Faktur tidak memiliki barang.</div>';
  el('supplier-return-workspace').classList.remove('hidden');updateSupplierReturnTotal();
}

function updateSupplierReturnTotal(){
  const receipt=state.supplierReturnReceipt;if(!receipt)return;
  let total=0,selected=0;
  el('supplier-return-item-list').querySelectorAll('.supplier-return-line').forEach((row)=>{
    const line=receipt.lines.find((item)=>item.receiptItemId===row.dataset.receiptItemId),checked=row.querySelector('.supplier-return-select').checked;
    const qty=Math.max(0,Math.min(Number(row.querySelector('.supplier-return-qty').value||0),line.maxReturnQty));
    row.querySelector('.supplier-return-line-credit strong').textContent=money.format(qty*line.unitCost);
    if(checked){total+=qty*line.unitCost;selected++;}
  });
  el('supplier-return-total').textContent=money.format(total);
  el('post-supplier-return').disabled=!selected||!(total>=0);
}

async function findSupplierReturnReceipt(){
  const documentNo=el('supplier-return-document').value.trim();if(!documentNo)return toast('Masukkan nomor faktur penerimaan.');
  const supplierId=el('supplier-return-supplier').value;if(!supplierId)return toast('Pilih supplier.');
  el('supplier-return-search-status').textContent='Mencari penerimaan dan stok batch...';el('supplier-return-workspace').classList.add('hidden');
  try{const data=await request(`/api/purchase-returns/lookup?documentNo=${encodeURIComponent(documentNo)}&supplierId=${encodeURIComponent(supplierId)}`);state.supplierReturnReceipt=data.receipt;el('supplier-return-search-status').textContent=`Faktur ${data.receipt.documentNo} ditemukan.`;renderSupplierReturnReceipt();}
  catch(error){state.supplierReturnReceipt=null;el('supplier-return-search-status').textContent=error.message;}
}

async function loadRecentSupplierReturns(){
  try{
    const data=await request('/api/purchase-returns/recent');state.recentSupplierReturns=data.returns??[];
    const settlement={CREDIT_NOTE:'Nota kredit',REFUND:'Uang kembali',REPLACEMENT:'Penggantian barang'};
    el('supplier-return-history-list').innerHTML=state.recentSupplierReturns.map((item)=>`<div class="supplier-return-history-row"><div><strong>${escapeHtml(item.returnNo)}</strong><small>Faktur ${escapeHtml(item.documentNo)} · ${new Date(item.occurredAt).toLocaleString('id-ID')}</small></div><div><strong>${escapeHtml(item.supplierName)}</strong><small>${escapeHtml(item.reason)} · ${item.totalQty.toLocaleString('id-ID')} pcs</small></div><div><strong>${money.format(item.totalCredit)}</strong><small>${settlement[item.settlementType]??item.settlementType}${item.supplierReference?` · ${escapeHtml(item.supplierReference)}`:''}</small></div></div>`).join('')||'<div class="empty-state compact">Belum ada retur supplier.</div>';
  }catch(error){el('supplier-return-history-list').innerHTML=`<p class="error">${escapeHtml(error.message)}</p>`;}
}

async function postSupplierReturn(event){
  event.preventDefault();const receipt=state.supplierReturnReceipt;if(!receipt)return;
  const items=[...el('supplier-return-item-list').querySelectorAll('.supplier-return-line')].filter((row)=>row.querySelector('.supplier-return-select').checked).map((row)=>({receiptItemId:row.dataset.receiptItemId,baseQty:Number(row.querySelector('.supplier-return-qty').value)}));
  if(!items.length)return el('supplier-return-error').textContent='Pilih minimal satu barang.';
  if(items.some((item)=>!(item.baseQty>0)))return el('supplier-return-error').textContent='Jumlah retur harus lebih dari nol.';
  const button=el('post-supplier-return');button.disabled=true;button.textContent='Memposting retur...';el('supplier-return-error').textContent='';
  try{
    const result=await request('/api/purchase-returns',{method:'POST',headers:{'idempotency-key':crypto.randomUUID()},body:JSON.stringify({receiptId:receipt.id,reason:el('supplier-return-reason').value.trim(),settlementType:el('supplier-return-settlement').value,supplierReference:el('supplier-return-reference').value.trim(),items})});
    toast(`Retur ${result.returnNo} berhasil · kredit ${money.format(result.totalCredit)}`);state.supplierReturnReceipt=null;el('supplier-return-workspace').classList.add('hidden');el('supplier-return-form').reset();await Promise.all([loadRecentSupplierReturns(),refreshCatalog()]);if(state.session.permissions.includes('inventory.manage'))await loadInventory();
  }catch(error){el('supplier-return-error').textContent=error.message;}
  finally{button.disabled=false;button.textContent='Posting retur supplier';}
}

function renderOutletOptions(containerId, selectedIds = [], role = 'CASHIER') {
  const selected = new Set(role === 'OWNER' ? state.outlets.map((outlet) => outlet.id) : selectedIds);
  const disabled = role === 'OWNER' ? 'disabled' : '';
  el(containerId).innerHTML = state.outlets.map((outlet) => `<label class="outlet-option"><input type="checkbox" value="${escapeHtml(outlet.id)}" ${selected.has(outlet.id) ? 'checked' : ''} ${disabled}><span>${escapeHtml(outlet.name)}</span></label>`).join('') || '<p class="muted">Belum ada outlet aktif.</p>';
}

function selectedOutletIds(containerId, role) {
  if (role === 'OWNER') return state.outlets.map((outlet) => outlet.id);
  return [...el(containerId).querySelectorAll('input:checked')].map((input) => input.value);
}

function renderPermissionOptions(containerId,selected,role){
  const container=el(containerId);
  if(role==='OWNER'){
    container.innerHTML='<div class="permission-owner-note"><strong>Owner memiliki seluruh akses</strong><small>Hak keuangan, pengguna, keamanan, dan seluruh fitur operasional selalu aktif.</small></div>';
    return;
  }
  const active=new Set(selected??permissionDefaults[role]??[]);
  container.innerHTML=permissionOptions.map(([permission,label,description])=>`<label class="permission-option"><input type="checkbox" value="${permission}" ${active.has(permission)?'checked':''}><span><strong>${label}</strong><small>${description}</small></span></label>`).join('');
}

function selectedPermissions(containerId,role){
  if(role==='OWNER')return null;
  return [...el(containerId).querySelectorAll('input:checked')].map((input)=>input.value);
}

function renderUserMetrics() {
  const staff = state.users.filter((user) => user.role !== 'OWNER');
  const active = staff.filter((user) => user.active);
  const metrics = [
    ['Staff aktif', active.length],
    ['Kasir', active.filter((user) => user.role === 'CASHIER').length],
    ['Pembelian & gudang', active.filter((user) => ['PURCHASING', 'WAREHOUSE'].includes(user.role)).length],
    ['Admin & manajer', active.filter((user) => ['ADMIN', 'MANAGER'].includes(user.role)).length]
  ];
  el('user-metrics').innerHTML = metrics.map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join('');
}

function renderUsers() {
  const query = el('user-search').value.trim().toLowerCase();
  const status = el('user-status-filter').value;
  const outletsById = new Map(state.outlets.map((outlet) => [outlet.id, outlet.name]));
  const users = state.users.filter((user) => user.role !== 'OWNER').filter((user) => {
    const matchesQuery = !query || `${user.displayName} ${user.email ?? ''} ${roleLabels[user.role] ?? user.role}`.toLowerCase().includes(query);
    const matchesStatus = status === 'ALL' || (status === 'ACTIVE' ? user.active : !user.active);
    return matchesQuery && matchesStatus;
  });
  el('user-list').innerHTML = users.map((user) => {
    const outletNames = user.outletIds.map((id) => outletsById.get(id)).filter(Boolean);
    const accessCount=`${user.permissions?.length??0} akses`;
    return `<div class="user-row" data-user-id="${escapeHtml(user.id)}"><div class="user-person"><strong>${escapeHtml(user.displayName)}</strong><small>${escapeHtml(user.email ?? 'Email tidak tersedia')}</small></div><span class="role-badge ${user.active ? '' : 'inactive'}">${user.active ? escapeHtml(roleLabels[user.role] ?? user.role) : 'NONAKTIF'}</span><div class="user-outlet-list">${escapeHtml(outletNames.join(', ') || 'Belum ditempatkan')}<small>${accessCount}</small></div><button class="button secondary edit-user" type="button">Atur akses</button></div>`;
  }).join('') || '<div class="empty-state compact">Belum ada staff yang sesuai filter.</div>';
}

async function loadUsers() {
  el('user-list').innerHTML = '<div class="empty-state compact">Memuat staff...</div>';
  try {
    const data = await request('/api/users');
    state.users = data.users ?? [];
    state.outlets = data.outlets ?? state.outlets;
    renderOutletOptions('new-user-outlets', [], el('new-user-role').value);
    renderPermissionOptions('new-user-permissions',permissionDefaults[el('new-user-role').value],el('new-user-role').value);
    renderUserMetrics();
    renderUsers();
  } catch (error) {
    el('user-list').innerHTML = `<div class="empty-state compact"><strong>Data pengguna belum dapat dimuat</strong><small>${escapeHtml(error.message)}</small></div>`;
    toast(error.message);
  }
}

function openCreateUserDialog() {
  el('create-user-form').reset();
  el('new-user-role').value = 'CASHIER';
  el('create-user-error').textContent = '';
  renderOutletOptions('new-user-outlets', state.outlets[0] ? [state.outlets[0].id] : [], 'CASHIER');
  renderPermissionOptions('new-user-permissions', permissionDefaults.CASHIER, 'CASHIER');
  el('create-user-dialog').showModal();
  requestAnimationFrame(() => el('new-user-name').focus());
}

async function createUser(event) {
  event.preventDefault();
  const role = el('new-user-role').value;
  const outletIds = selectedOutletIds('new-user-outlets', role);
  if (role !== 'OWNER' && !outletIds.length) { el('create-user-error').textContent = 'Pilih minimal satu outlet untuk pengguna ini.'; return; }
  const button = el('create-user');
  el('create-user-error').textContent = '';
  button.disabled = true; button.textContent = 'Membuat akun...';
  try {
    await request('/api/users', { method: 'POST', body: JSON.stringify({
      displayName: el('new-user-name').value.trim(), email: el('new-user-email').value.trim(),
      password: el('new-user-password').value, role, outletIds,
      permissions:selectedPermissions('new-user-permissions',role)
    }) });
    el('create-user-form').reset();
    el('new-user-role').value = 'CASHIER';
    el('create-user-dialog').close();
    toast('Akun staff berhasil dibuat');
    await loadUsers();
  } catch (error) { el('create-user-error').textContent = error.message; }
  finally { button.disabled = false; button.textContent = 'Buat akun staff'; }
}

function openUserEditor(userId) {
  const user = state.users.find((item) => item.id === userId);
  if (!user) return;
  el('edit-user-id').value = user.id;
  el('edit-user-title').textContent = user.displayName;
  el('edit-user-email').textContent = user.email ?? 'Email tidak tersedia';
  el('edit-user-name').value = user.displayName;
  el('edit-user-role').value = user.role;
  el('edit-user-active').checked = user.active;
  el('edit-user-active').disabled = user.id === state.session.user.id;
  el('edit-user-error').textContent = '';
  renderOutletOptions('edit-user-outlets', user.outletIds, user.role);
  renderPermissionOptions('edit-user-permissions',user.permissions,user.role);
  setStaffDetailView('access');
  el('staff-activity-list').innerHTML='<div class="empty-state compact">Pilih Log aktivitas untuk memuat data.</div>';
  el('edit-user-dialog').showModal();
}

const staffActivityLabels={
  ACCOUNT_LOGIN:'Masuk ke Nusa POS',SHIFT_OPENED:'Membuka shift kasir',
  SHIFT_CLOSED:'Menutup shift kasir',SHIFT_CASH_ADDED:'Menambah kas shift',
  SHIFT_CASH_REMOVED:'Mengurangi kas shift',SALE_COMPLETED:'Menyelesaikan penjualan',
  SALE_VOIDED:'Membatalkan transaksi',SALE_RETURNED:'Memproses retur penjualan',
  STOCK_ADJUSTED:'Menyesuaikan stok',STOCK_TRANSFER_CREATED:'Membuat transfer stok',
  STOCK_TRANSFER_RECEIVED:'Menerima transfer stok',PRODUCT_SAVED:'Menyimpan produk',
  PRODUCT_STATUS_CHANGED:'Mengubah status produk',PURCHASE_ORDER_CREATED:'Membuat pesanan pembelian',
  PURCHASE_RECEIVED:'Menerima barang',SUPPLIER_PAYMENT_RECORDED:'Mencatat pembayaran supplier',
  CUSTOMER_SAVED:'Menyimpan pelanggan',PROMOTION_PUBLISHED:'Menerbitkan promo',
  PROFILE_ACCESS_MANAGED:'Mengubah akses staf',BACKUP_EXPORTED:'Mengunduh backup data',
  KASPIN_SALES_IMPORTED:'Mengimpor transaksi Kaspin',KASPIN_CUSTOMERS_IMPORTED:'Mengimpor pelanggan Kaspin'
};

function readableActivityAction(action=''){
  return staffActivityLabels[action]??String(action).replaceAll('_',' ').toLowerCase().replace(/^./,(letter)=>letter.toUpperCase());
}

function staffActivitySummary(details={}){
  const parts=[];
  const receipt=details.receiptNo??details.receipt_no??details.documentNo??details.document_no;
  const reason=details.reason??details.note;
  const amount=details.amount??details.grandTotal??details.grand_total;
  if(receipt)parts.push(`Dokumen ${receipt}`);
  if(amount!=null&&Number.isFinite(Number(amount)))parts.push(money.format(Number(amount)));
  if(reason)parts.push(String(reason));
  return parts.join(' · ')||'Tindakan tercatat oleh sistem';
}

function setStaffDetailView(view){
  const activity=view==='activity';
  el('staff-access-panel').classList.toggle('hidden',activity);
  el('staff-activity-panel').classList.toggle('hidden',!activity);
  document.querySelectorAll('[data-staff-detail-view]').forEach((button)=>button.classList.toggle('active',button.dataset.staffDetailView===view));
  if(activity)loadStaffActivity();
}

async function loadStaffActivity(){
  const userId=el('edit-user-id').value;
  if(!userId)return;
  el('staff-activity-list').innerHTML='<div class="empty-state compact">Memuat log aktivitas...</div>';
  try{
    const data=await request(`/api/users/${encodeURIComponent(userId)}/activity`);
    el('staff-activity-list').innerHTML=(data.logs??[]).map((item)=>`<article class="staff-activity-row"><span class="staff-activity-dot"></span><div><strong>${escapeHtml(readableActivityAction(item.action))}</strong><small>${new Date(item.occurredAt).toLocaleString('id-ID')} · ${escapeHtml(item.entityType??'aktivitas')}</small><p>${escapeHtml(staffActivitySummary(item.details))}</p></div></article>`).join('')||'<div class="empty-state compact"><strong>Belum ada aktivitas</strong><small>Aktivitas baru akan muncul setelah akun ini digunakan.</small></div>';
  }catch(error){
    el('staff-activity-list').innerHTML=`<div class="empty-state compact"><strong>Log belum dapat dimuat</strong><small>${escapeHtml(error.message)}</small></div>`;
  }
}

async function saveUser(event) {
  event.preventDefault();
  const role = el('edit-user-role').value;
  const outletIds = selectedOutletIds('edit-user-outlets', role);
  if (role !== 'OWNER' && !outletIds.length) { el('edit-user-error').textContent = 'Pilih minimal satu outlet untuk pengguna ini.'; return; }
  const button = el('save-user');
  button.disabled = true; button.textContent = 'Menyimpan...'; el('edit-user-error').textContent = '';
  try {
    await request(`/api/users/${encodeURIComponent(el('edit-user-id').value)}`, { method: 'PATCH', body: JSON.stringify({
      displayName: el('edit-user-name').value.trim(), role, active: el('edit-user-active').checked, outletIds,
      permissions:selectedPermissions('edit-user-permissions',role)
    }) });
    el('edit-user-dialog').close();
    toast('Hak akses pengguna berhasil diperbarui');
    await loadUsers();
  } catch (error) { el('edit-user-error').textContent = error.message; }
  finally { button.disabled = false; button.textContent = 'Simpan perubahan'; }
}

function renderOutletSwitcher() {
  const select = el('current-outlet-select');
  if (!select) return;
  select.innerHTML = state.outlets.map((outlet) => `<option value="${escapeHtml(outlet.id)}">${escapeHtml(outlet.name)}</option>`).join('');
  if (state.outlets.some((outlet) => outlet.id === state.activeOutletId)) select.value = state.activeOutletId;
  select.disabled = state.outlets.length < 2;
}

async function switchActiveOutlet(event) {
  const nextOutletId = event.target.value;
  if (!nextOutletId || nextOutletId === state.activeOutletId) return;
  if (state.cart.length) {
    event.target.value = state.activeOutletId;
    return toast('Kosongkan atau tahan keranjang sebelum berpindah outlet.');
  }
  if (state.currentShift) {
    event.target.value = state.activeOutletId;
    return toast('Tutup shift aktif sebelum berpindah outlet.');
  }
  const previous = state.activeOutletId;
  state.activeOutletId = nextOutletId;
  event.target.disabled = true;
  try {
    await refreshCatalog();
    await loadHeldSales();
    renderLastSync();
    toast(`Outlet aktif: ${state.outlets.find((outlet) => outlet.id === state.activeOutletId)?.name ?? 'Outlet'}`);
  } catch (error) {
    state.activeOutletId = previous;
    renderOutletSwitcher();
    toast(error.message);
  } finally {
    event.target.disabled = state.outlets.length < 2;
  }
}

function settingOutletLabel(outletId) {
  return state.settings.outlets.find((outlet) => outlet.id === outletId)?.name ?? 'Tanpa outlet';
}

function printerContext() {
  return {
    business: state.business,
    outlet: state.outlets.find((item) => item.id === state.activeOutletId) ?? {},
    customer: state.lastReceipt?.customer,
    customerGroups: state.customerGroups,
    cashier: state.session?.user?.displayName ?? state.session?.user?.name ?? 'Kasir Nusa'
  };
}

function renderPrinterStatus(message = '') {
  if (!el('printer-status')) return;
  const supported = supportsBluetoothClassicPrinting();
  const connected = printerConnected();
  const selected = printerSelected();
  const dot = el('printer-status-dot');
  dot.className = `printer-status-dot ${connected ? 'ready' : supported ? 'warning' : 'error'}`;
  el('printer-status').textContent = message || (connected
    ? 'Printer Bluetooth terhubung'
    : selected
      ? 'Printer sudah diizinkan, belum tersambung'
      : supported
        ? 'Belum ada printer yang dipilih'
        : 'Web Serial tidak tersedia');
  el('printer-status-help').textContent = supported
    ? 'Bluetooth Classic SPP · ESC/POS · tanpa aplikasi tambahan.'
    : 'Gunakan Chrome Android versi 138 atau lebih baru.';
  el('connect-printer').disabled = !supported;
  el('connect-printer').textContent = selected ? 'Sambungkan ulang' : 'Hubungkan printer';
  el('test-printer').disabled = !supported || !selected;
  el('disconnect-printer').classList.toggle('hidden', !connected);
}

async function connectReceiptPrinter() {
  const button = el('connect-printer');
  button.disabled = true;
  try {
    await selectBluetoothPrinter();
    renderPrinterStatus('Printer Bluetooth siap digunakan');
    toast('Printer terhubung. Jalankan tes cetak.');
  } catch (error) {
    renderPrinterStatus(error.name === 'NotFoundError' ? 'Pemilihan printer dibatalkan' : 'Printer gagal dihubungkan');
    if (error.name !== 'NotFoundError') toast(error.message);
  } finally {
    button.disabled = !supportsBluetoothClassicPrinting();
  }
}

async function testReceiptPrinter() {
  const button = el('test-printer');
  button.disabled = true;
  button.textContent = 'Mencetak...';
  try {
    await printEscPosTest(state.deviceSettings, printerContext());
    renderPrinterStatus('Tes cetak berhasil dikirim');
    toast('Tes cetak berhasil dikirim ke printer.');
  } catch (error) {
    renderPrinterStatus('Tes cetak gagal');
    toast(error.message);
  } finally {
    button.textContent = 'Tes cetak';
    button.disabled = !printerSelected();
  }
}

async function disconnectReceiptPrinter() {
  try {
    await disconnectBluetoothPrinter();
    renderPrinterStatus('Printer diputuskan');
  } catch (error) {
    toast(error.message);
  }
}

async function printReceiptDirect(receipt, payments, { automatic = false } = {}) {
  if (!receipt) return toast('Belum ada struk untuk dicetak.');
  if (!supportsBluetoothClassicPrinting()) {
    if (!automatic) window.print();
    else toast('Cetak langsung memerlukan Chrome Android versi 138 atau lebih baru.');
    return;
  }
  try {
    if (!printerSelected()) {
      if (automatic) return toast('Hubungkan printer Bluetooth sebelum mengaktifkan cetak langsung.');
      await selectBluetoothPrinter();
    }
    el('receipt-dialog').classList.add('receipt-printing');
    await printEscPosReceipt(receipt, payments ?? receipt.payments ?? [], state.deviceSettings, printerContext());
    renderPrinterStatus('Struk berhasil dikirim');
    toast('Struk berhasil dikirim ke printer.');
  } catch (error) {
    renderPrinterStatus('Cetak struk gagal');
    toast(`${error.message} Struk tetap tersimpan dan dapat dicetak ulang.`);
  } finally {
    el('receipt-dialog').classList.remove('receipt-printing');
  }
}

function currentReceiptLayout() {
  return {...defaultReceiptLayout,...(state.business?.receiptLayout??{})};
}

const receiptToggleFields={
  showLogo:'receipt-show-logo',showBusinessName:'receipt-show-business',
  showOutletName:'receipt-show-outlet',showAddress:'receipt-show-address',
  showPhone:'receipt-show-phone',showDate:'receipt-show-date',
  showReceiptNumber:'receipt-show-number',showCashier:'receipt-show-cashier',
  showCustomer:'receipt-show-customer',showPriceType:'receipt-show-price-type',
  showPaymentDetail:'receipt-show-payment',showTransactionNote:'receipt-show-note',
  showLoyaltyPoints:'receipt-show-points'
};

function receiptLayoutFromControls() {
  return {
    headerAlignment:el('setting-receipt-header-align').value,
    footerAlignment:el('setting-receipt-footer-align').value,
    titleSize:el('setting-receipt-title-size').value,
    density:el('setting-receipt-density').value,
    separator:el('setting-receipt-separator').value,
    logoSize:Number(el('setting-receipt-logo-size').value),
    customHeader:el('setting-receipt-custom-header').value.trim(),
    customFooter:el('setting-receipt-custom-footer').value.trim(),
    contactLabel:el('setting-receipt-contact-label').value.trim()||'Tel.',
    ...Object.fromEntries(Object.entries(receiptToggleFields).map(([key,id])=>[key,el(id).checked]))
  };
}

function populateReceiptLayoutControls(layout=currentReceiptLayout()) {
  el('setting-receipt-logo-url').value=state.business?.logoUrl??'';
  el('setting-receipt-custom-header').value=layout.customHeader??'';
  el('setting-receipt-custom-footer').value=layout.customFooter??'';
  el('setting-receipt-contact-label').value=layout.contactLabel??'Tel.';
  el('setting-receipt-logo-size').value=String(layout.logoSize??64);
  el('setting-receipt-logo-size-value').textContent=String(layout.logoSize??64);
  el('setting-receipt-header-align').value=layout.headerAlignment??'center';
  el('setting-receipt-footer-align').value=layout.footerAlignment??'center';
  el('setting-receipt-title-size').value=layout.titleSize??'large';
  el('setting-receipt-density').value=layout.density??'normal';
  el('setting-receipt-separator').value=layout.separator??'dashed';
  for(const [key,id] of Object.entries(receiptToggleFields))el(id).checked=layout[key]!==false;
  renderReceiptDesignPreview();
}

function renderReceiptDesignPreview() {
  if(!el('receipt-design-preview'))return;
  const previewBusiness={...state.business,logoUrl:el('setting-receipt-logo-url').value.trim(),receiptLayout:receiptLayoutFromControls()};
  const outlet=state.outlets.find((item)=>item.id===state.activeOutletId)??{name:'Toko Utama'};
  const receipt={
    receiptNo:'UTM-000128',occurredAt:new Date().toISOString(),cashier:'Ayu',
    customer:{name:'Budi',group_id:'member'},customerGroupId:'member',
    business:previewBusiness,outlet,outletName:outlet.name,pointsEarned:2,pointsBalance:48,
    notes:'Titip diambil sore',
    quote:{lines:[
      {productName:'Lip Tint Rose',qty:1,unitName:'pcs',gross:25000,customerUnitPrice:25000,total:25000},
      {productName:'Facial Wash',qty:2,unitName:'pcs',gross:36000,customerUnitPrice:18000,total:36000}
    ],subtotal:61000,discountTotal:5000,grandTotal:56000}
  };
  el('receipt-design-preview').innerHTML=buildReceiptMarkup(receipt,[{method:'CASH',amount:56000,tendered:60000}],{business:previewBusiness,outlet,preview:true});
  el('receipt-preview-paper').textContent=`${state.deviceSettings.paperWidth??80} mm`;
  bindReceiptImageFallbacks(el('receipt-design-preview'));
}

async function receiptLogoFromFile(file) {
  if(!file?.type?.match(/^image\/(png|jpeg|webp)$/))throw new Error('Pilih gambar PNG, JPEG, atau WebP.');
  if(file.size>5_000_000)throw new Error('Berkas logo maksimal 5 MB sebelum diperkecil.');
  const source=await new Promise((resolve,reject)=>{
    const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Logo gagal dibaca.'));reader.readAsDataURL(file);
  });
  const image=await new Promise((resolve,reject)=>{
    const node=new Image();node.onload=()=>resolve(node);node.onerror=()=>reject(new Error('Format logo tidak dapat dibuka.'));node.src=source;
  });
  const scale=Math.min(1,320/image.width,160/image.height);
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
  const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
  let result=canvas.toDataURL('image/png');
  if(result.length>280000)result=canvas.toDataURL('image/jpeg',.82);
  if(result.length>300000)throw new Error('Logo masih terlalu besar. Gunakan gambar yang lebih sederhana.');
  return result;
}

function renderSettings() {
  const business = state.business ?? {};
  el('setting-business-name').value = business.name ?? '';
  el('setting-business-legal').value = business.legalName ?? '';
  el('setting-business-phone').value = business.phone ?? '';
  el('setting-business-email').value = business.email ?? '';
  el('setting-business-tax').value = business.taxId ?? '';
  el('setting-business-address').value = business.address ?? '';
  el('setting-business-footer').value = business.receiptFooter ?? '';
  populateReceiptLayoutControls();
  const outletOptions = state.settings.outlets.filter((outlet) => outlet.active).map((outlet) => `<option value="${escapeHtml(outlet.id)}">${escapeHtml(outlet.name)}</option>`).join('');
  el('setting-location-outlet').innerHTML = outletOptions;
  el('setting-device-outlet').innerHTML = outletOptions;
  el('settings-outlet-list').innerHTML = state.settings.outlets.map((outlet) => `
    <button class="settings-row edit-setting-outlet" type="button" data-outlet-id="${escapeHtml(outlet.id)}">
      <span><strong>${escapeHtml(outlet.name)}</strong><small>${escapeHtml(outlet.code)} · struk ${escapeHtml(outlet.receipt_prefix)}-000001</small></span>
      <span class="status-badge ${outlet.active ? 'approved' : 'inactive'}">${outlet.active ? 'AKTIF' : 'NONAKTIF'}</span>
    </button>`).join('') || '<div class="empty-state compact">Belum ada outlet.</div>';
  const kindLabels = { STORE: 'Toko', WAREHOUSE: 'Gudang', TRANSIT: 'Transit' };
  el('settings-location-list').innerHTML = state.settings.locations.map((location) => `
    <button class="settings-row edit-setting-location" type="button" data-location-id="${escapeHtml(location.id)}">
      <span><strong>${escapeHtml(location.name)}</strong><small>${escapeHtml(settingOutletLabel(location.outlet_id))} · ${escapeHtml(kindLabels[location.kind] ?? location.kind)} · ${escapeHtml(location.code)}</small></span>
      <span class="status-badge ${location.active ? 'approved' : 'inactive'}">${location.active ? 'AKTIF' : 'NONAKTIF'}</span>
    </button>`).join('') || '<div class="empty-state compact">Belum ada lokasi stok.</div>';
  const registered = state.settings.devices.find((device) => device.id === posDevice.id);
  state.deviceSettings = { ...state.deviceSettings, ...(registered ?? {}) };
  el('setting-device-id').textContent = `ID ${posDevice.id.slice(0, 8).toUpperCase()}`;
  el('setting-device-name').value = registered?.name || posDevice.name;
  el('setting-device-outlet').value = registered?.outletId ?? state.activeOutletId;
  el('setting-device-paper').value = String(state.deviceSettings.paperWidth ?? 80);
  el('setting-receipt-paper').value = String(state.deviceSettings.paperWidth ?? 80);
  el('setting-device-copies').value = String(state.deviceSettings.receiptCopies ?? 1);
  el('setting-device-auto-print').checked = Boolean(state.deviceSettings.autoPrint);
  renderPrinterStatus();
  renderReceiptDesignPreview();
}

async function loadSettings() {
  try {
    const data = await request('/api/settings');
    state.business = data.business ?? state.business;
    state.settings = { outlets: data.outlets ?? [], locations: data.locations ?? [], devices: data.devices ?? [] };
    renderSettings();
  } catch (error) {
    if (el('settings-outlet-list')) el('settings-outlet-list').innerHTML = `<div class="empty-state compact"><strong>Pengaturan belum dapat dimuat</strong><small>${escapeHtml(error.message)}</small></div>`;
  }
}

function renderSystemHealth() {
  const health = state.systemHealth;
  if (!health) return;
  const status = String(health.status ?? 'WARNING').toUpperCase();
  const statusCopy = {
    HEALTHY: ['Sistem sehat', 'Semua pemeriksaan utama aman.'],
    WARNING: ['Perlu perhatian', 'Ada pekerjaan operasional yang perlu ditinjau.'],
    CRITICAL: ['Ditemukan ketidaksesuaian', 'Jangan abaikan temuan sebelum melanjutkan tutup buku.']
  };
  const [title, description] = statusCopy[status] ?? statusCopy.WARNING;
  const checkedDate = new Date(health.checkedAt);
  const checkedAt = Number.isFinite(checkedDate.getTime())
    ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(checkedDate)
    : 'baru saja';
  el('system-health-summary').className = `health-summary ${status.toLowerCase()}`;
  el('system-health-summary').innerHTML = `
    <div><span class="health-indicator"></span><strong>${title}</strong><small>${description}</small></div>
    <span>Terakhir diperiksa<br><strong>${escapeHtml(checkedAt)}</strong></span>`;
  const explanations = {
    NEGATIVE_STOCK: 'Saldo lokasi di bawah nol.',
    STOCK_LEDGER_MISMATCH: 'Saldo saat ini berbeda dari jurnal stok terakhir.',
    NEGATIVE_BATCH: 'Jumlah tersedia pada batch di bawah nol.',
    PAYMENT_MISMATCH: 'Pembayaran langsung + piutang berbeda dari total struk.',
    CUSTOMER_BALANCE_MISMATCH: 'Saldo rekening pelanggan berbeda dari faktur terbuka.',
    SUPPLIER_BALANCE_MISMATCH: 'Saldo hutang supplier berbeda dari faktur terbuka.',
    OLD_OPEN_SHIFT: 'Shift belum ditutup lebih dari 24 jam.',
    SYNC_REVIEW: 'Transaksi offline menunggu keputusan Owner/Admin.',
    SYNC_FAILED: 'Ada antrean offline yang gagal diproses.',
    EXPIRED_APPROVAL: 'Izin diskon lama sudah kedaluwarsa.'
  };
  el('system-health-checks').innerHTML = (health.checks ?? []).map((check) => {
    const count = Number(check.count ?? 0);
    const severity = count > 0 ? String(check.severity ?? 'WARNING').toLowerCase() : 'clear';
    return `<article class="health-check ${severity}">
      <div><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(explanations[check.code] ?? '')}</small></div>
      <span>${count > 0 ? `${count} temuan` : 'Aman'}</span>
    </article>`;
  }).join('') || '<div class="empty-state compact">Tidak ada hasil pemeriksaan.</div>';
}

async function loadSystemHealth() {
  const button = el('refresh-system-health');
  if (button) button.disabled = true;
  try {
    state.systemHealth = await request('/api/system/health');
    renderSystemHealth();
  } catch (error) {
    el('system-health-summary').className = 'health-summary warning';
    el('system-health-summary').innerHTML = `<div><span class="health-indicator"></span><strong>Pemeriksaan belum selesai</strong><small>${escapeHtml(error.message)}</small></div>`;
    el('system-health-checks').innerHTML = '<div class="empty-state compact">Tekan “Periksa sekarang” setelah koneksi kembali stabil.</div>';
  } finally {
    if (button) button.disabled = false;
  }
}

async function loadSettingsWorkspace() {
  await Promise.all([loadSettings(), loadSystemHealth()]);
}

function isInstalledPwa() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function updateInstallAppControl() {
  const button = el('install-app');
  const status = el('install-app-status');
  if (!button || !status) return;
  if (isInstalledPwa()) {
    button.disabled = true;
    button.textContent = 'Sudah terpasang';
    status.textContent = 'Kasir Nusa sedang berjalan sebagai aplikasi di perangkat ini.';
    return;
  }
  button.textContent = 'Pasang aplikasi';
  button.disabled = !deferredInstallPrompt;
  status.textContent = deferredInstallPrompt
    ? 'Siap dipasang tanpa mengunduh dari Play Store atau Microsoft Store.'
    : 'Jika tombol belum aktif, buka menu browser lalu pilih “Instal aplikasi”.';
}

async function installPwa() {
  if (!deferredInstallPrompt) return;
  const prompt = deferredInstallPrompt;
  deferredInstallPrompt = null;
  await prompt.prompt();
  await prompt.userChoice.catch(() => null);
  updateInstallAppControl();
}

function newOutletEditor() {
  el('outlet-settings-form').reset();
  el('setting-outlet-id').value = '';
  el('setting-outlet-mode').textContent = 'OUTLET BARU';
  el('setting-outlet-title').textContent = 'Tambahkan outlet';
  el('setting-outlet-timezone').value = 'Asia/Makassar';
  el('setting-outlet-active').checked = true;
  el('outlet-settings-error').textContent = '';
}

function editOutletSetting(outletId) {
  const outlet = state.settings.outlets.find((item) => item.id === outletId);
  if (!outlet) return;
  el('setting-outlet-id').value = outlet.id;
  el('setting-outlet-mode').textContent = 'UBAH OUTLET';
  el('setting-outlet-title').textContent = outlet.name;
  el('setting-outlet-code').value = outlet.code;
  el('setting-outlet-prefix').value = outlet.receipt_prefix;
  el('setting-outlet-name').value = outlet.name;
  el('setting-outlet-phone').value = outlet.phone ?? '';
  el('setting-outlet-timezone').value = outlet.timezone;
  el('setting-outlet-address').value = outlet.address ?? '';
  el('setting-outlet-footer').value = outlet.receipt_footer ?? '';
  el('setting-outlet-active').checked = outlet.active;
  el('outlet-settings-error').textContent = '';
}

function newLocationEditor() {
  el('location-settings-form').reset();
  el('setting-location-id').value = '';
  el('setting-location-mode').textContent = 'LOKASI BARU';
  el('setting-location-title').textContent = 'Tambahkan lokasi stok';
  el('setting-location-outlet').value = state.activeOutletId;
  el('setting-location-active').checked = true;
  el('location-settings-error').textContent = '';
}

function editLocationSetting(locationId) {
  const location = state.settings.locations.find((item) => item.id === locationId);
  if (!location) return;
  el('setting-location-id').value = location.id;
  el('setting-location-mode').textContent = 'UBAH LOKASI';
  el('setting-location-title').textContent = location.name;
  el('setting-location-outlet').value = location.outlet_id;
  el('setting-location-kind').value = location.kind;
  el('setting-location-code').value = location.code;
  el('setting-location-name').value = location.name;
  el('setting-location-active').checked = location.active;
  el('location-settings-error').textContent = '';
}

async function saveBusinessSettings(event) {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const data = await request('/api/settings/business', { method: 'PUT', body: JSON.stringify({
      name: el('setting-business-name').value.trim(), legalName: el('setting-business-legal').value.trim(),
      phone: el('setting-business-phone').value.trim(), email: el('setting-business-email').value.trim(),
      taxId: el('setting-business-tax').value.trim(), address: el('setting-business-address').value.trim(),
      receiptFooter: el('setting-business-footer').value.trim(),logoUrl:state.business.logoUrl??''
    }) });
    state.business = data.business;
    saveBootstrapCache({ ...JSON.parse(localStorage.getItem('pos_bootstrap_cache') ?? '{}'), business: state.business, session: state.session });
    toast('Identitas usaha berhasil disimpan');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}

async function saveReceiptSettings(event) {
  event.preventDefault();
  const button=event.submitter;button.disabled=true;el('receipt-settings-error').textContent='';
  try{
    const data=await request('/api/settings/receipt',{method:'PUT',body:JSON.stringify({
      logoUrl:el('setting-receipt-logo-url').value.trim(),layout:receiptLayoutFromControls()
    })});
    const deviceData=await request('/api/settings/device',{method:'PUT',body:JSON.stringify({
      id:posDevice.id,outletId:el('setting-device-outlet').value,name:el('setting-device-name').value.trim(),
      platform:posDevice.platform,paperWidth:Number(el('setting-receipt-paper').value),
      receiptCopies:Number(el('setting-device-copies').value),autoPrint:el('setting-device-auto-print').checked
    })});
    state.business=data.business;
    state.deviceSettings=deviceData.device;
    el('setting-device-paper').value=String(deviceData.device.paperWidth);
    saveBootstrapCache({...JSON.parse(localStorage.getItem('pos_bootstrap_cache')??'{}'),business:state.business,deviceSettings:state.deviceSettings,session:state.session});
    populateReceiptLayoutControls();
    toast(`Desain disimpan; printer perangkat ini memakai kertas ${deviceData.device.paperWidth} mm`);
  }catch(error){el('receipt-settings-error').textContent=error.message;}finally{button.disabled=false;}
}

async function saveOutletSettings(event) {
  event.preventDefault();
  const id = el('setting-outlet-id').value;
  const button = event.submitter;
  el('outlet-settings-error').textContent = ''; button.disabled = true;
  try {
    await request(id ? `/api/settings/outlets/${id}` : '/api/settings/outlets', { method: id ? 'PUT' : 'POST', body: JSON.stringify({
      code: el('setting-outlet-code').value, receiptPrefix: el('setting-outlet-prefix').value,
      name: el('setting-outlet-name').value, phone: el('setting-outlet-phone').value,
      timezone: el('setting-outlet-timezone').value, address: el('setting-outlet-address').value,
      receiptFooter: el('setting-outlet-footer').value, active: el('setting-outlet-active').checked
    }) });
    state.activeOutletId = null;
    await refreshCatalog(); await loadSettings(); newOutletEditor();
    toast(id ? 'Outlet berhasil diperbarui' : 'Outlet baru berhasil dibuat');
  } catch (error) { el('outlet-settings-error').textContent = error.message; }
  finally { button.disabled = false; }
}

async function saveLocationSettings(event) {
  event.preventDefault();
  const id = el('setting-location-id').value;
  const button = event.submitter;
  el('location-settings-error').textContent = ''; button.disabled = true;
  try {
    await request(id ? `/api/settings/locations/${id}` : '/api/settings/locations', { method: id ? 'PUT' : 'POST', body: JSON.stringify({
      outletId: el('setting-location-outlet').value, kind: el('setting-location-kind').value,
      code: el('setting-location-code').value, name: el('setting-location-name').value,
      active: el('setting-location-active').checked
    }) });
    await refreshCatalog(); await loadSettings(); newLocationEditor();
    toast(id ? 'Lokasi stok berhasil diperbarui' : 'Lokasi stok berhasil dibuat');
  } catch (error) { el('location-settings-error').textContent = error.message; }
  finally { button.disabled = false; }
}

async function saveDeviceSettings(event) {
  event.preventDefault();
  const button = event.submitter;
  el('device-settings-error').textContent = ''; button.disabled = true;
  try {
    const data = await request('/api/settings/device', { method: 'PUT', body: JSON.stringify({
      id: posDevice.id, outletId: el('setting-device-outlet').value, name: el('setting-device-name').value.trim(),
      platform: posDevice.platform, paperWidth: Number(el('setting-device-paper').value),
      receiptCopies: Number(el('setting-device-copies').value), autoPrint: el('setting-device-auto-print').checked
    }) });
    state.deviceSettings = data.device;
    posDevice.name = data.device.name;
    localStorage.setItem('pos_device_name', data.device.name);
    await loadSettings();
    toast('Pengaturan perangkat ini berhasil disimpan');
  } catch (error) { el('device-settings-error').textContent = error.message; }
  finally { button.disabled = false; }
}

function storeDateToday() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Makassar', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function initializeOwnerFinanceFilters() {
  const today = storeDateToday();
  if (!el('owner-finance-to').value) el('owner-finance-to').value = today;
  if (!el('owner-finance-from').value) el('owner-finance-from').value = today;
  if (!el('expense-date').value) el('expense-date').value = today;
  const selected = el('owner-finance-outlet').value;
  const options = '<option value="">Semua outlet</option>' + state.outlets.map((outlet) => `<option value="${escapeHtml(outlet.id)}">${escapeHtml(outlet.name)}</option>`).join('');
  el('owner-finance-outlet').innerHTML = options;
  if (state.outlets.some((outlet) => outlet.id === selected)) el('owner-finance-outlet').value = selected;
  el('expense-outlet').innerHTML = state.outlets.map((outlet) => `<option value="${escapeHtml(outlet.id)}">${escapeHtml(outlet.name)}</option>`).join('');
}

function agingCards(targetId, buckets = {}) {
  el(targetId).innerHTML = [
    ['Belum jatuh tempo', buckets.current ?? 0, 'safe'],
    ['1–30 hari', buckets.days1To30 ?? 0, 'notice'],
    ['31–60 hari', buckets.days31To60 ?? 0, 'warning'],
    ['Lebih 60 hari', buckets.daysOver60 ?? 0, 'danger'],
  ].map(([label, value, level]) => `<div class="${level}"><span>${label}</span><strong>${money.format(value)}</strong></div>`).join('');
}

function renderOwnerProductHealth() {
  const data = state.ownerFinance;
  if (!data) return;
  const query = el('owner-product-search').value.trim().toLowerCase();
  const status = el('owner-product-status').value;
  const products = data.products.filter((product) => {
    const matchesQuery = !query || `${product.productName} ${product.sku} ${product.category} ${product.brand ?? ''}`.toLowerCase().includes(query);
    const matchesStatus = !status
      || (status === 'DEAD' && product.deadStock)
      || (status === 'SLOW' && product.slowMoving)
      || (status === 'FAST' && product.fastMoving)
      || (status === 'LOW_MARGIN' && product.lowMargin);
    return matchesQuery && matchesStatus;
  });
  el('owner-product-health').innerHTML = reportTable(
    ['Produk', 'Stok', 'Penjualan', 'Omzet', 'Margin', 'Terakhir terjual', 'Status'],
    products.map((product) => {
      const badges = [
        product.deadStock ? '<span class="status-badge danger">Dead stock</span>' : '',
        product.slowMoving && !product.deadStock ? '<span class="status-badge warning">Lambat</span>' : '',
        product.fastMoving ? '<span class="status-badge approved">Cepat</span>' : '',
        product.lowMargin ? '<span class="status-badge submitted">Margin rendah</span>' : '',
      ].filter(Boolean).join(' ') || '<span class="status-badge draft">Normal</span>';
      return `<tr><td><strong>${escapeHtml(product.productName)}</strong><br><small>${escapeHtml(product.sku)} · ${escapeHtml(product.category)}</small></td><td>${Number(product.stockQty).toLocaleString('id-ID')}<br><small>${money.format(product.stockValue)}</small></td><td>${Number(product.netQty).toLocaleString('id-ID')}</td><td>${money.format(product.netRevenue)}</td><td class="${Number(product.marginPercent)<15?'negative':'positive'}">${Number(product.marginPercent).toLocaleString('id-ID',{maximumFractionDigits:2})}%</td><td>${product.lastSaleOn?new Date(`${product.lastSaleOn}T00:00:00`).toLocaleDateString('id-ID'):'Belum pernah'}</td><td>${badges}</td></tr>`;
    }),
  );
}

function renderOwnerFinance() {
  const data = state.ownerFinance;
  if (!data) return;
  const metrics = data.metrics;
  el('owner-profit-metrics').innerHTML = [
    ['Penjualan bersih', metrics.netSales],
    ['HPP', metrics.costOfGoods],
    ['Laba kotor', metrics.grossProfit],
    ['Biaya operasional', metrics.operatingExpenses],
    ['Laba operasional', metrics.operatingProfit],
    ['Margin operasional', `${Number(metrics.operatingMarginPercent).toLocaleString('id-ID',{maximumFractionDigits:2})}%`, true],
  ].map(([label, value, text]) => `<div class="metric"><span>${label}</span><strong class="${label==='Laba operasional'&&Number(metrics.operatingProfit)<0?'negative':''}">${text?value:money.format(value)}</strong></div>`).join('');
  el('owner-profit-daily').innerHTML = reportTable(
    ['Tanggal','Penjualan bersih','Laba kotor','Biaya','Laba operasional'],
    [...data.daily].reverse().map((item) => `<tr><td>${new Date(`${item.date}T00:00:00`).toLocaleDateString('id-ID')}</td><td>${money.format(item.netSales)}</td><td>${money.format(item.grossProfit)}</td><td>${money.format(item.expenses)}</td><td class="${Number(item.operatingProfit)>=0?'positive':'negative'}"><strong>${money.format(item.operatingProfit)}</strong></td></tr>`),
  );
  el('expense-category').innerHTML = data.categories.map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`).join('');
  el('expense-breakdown').innerHTML = data.expenseBreakdown.filter((item) => Number(item.amount)>0).map((item) => `<div><span>${escapeHtml(item.categoryName)}</span><strong>${money.format(item.amount)}</strong></div>`).join('') || '<small class="muted">Belum ada biaya pada periode ini.</small>';
  el('owner-expense-list').innerHTML = reportTable(
    ['Tanggal','Dokumen','Outlet','Kategori','Keterangan','Metode','Nominal',''],
    data.expenses.map((expense) => `<tr class="${expense.status==='VOIDED'?'voided-row':''}"><td>${new Date(`${expense.occurredOn}T00:00:00`).toLocaleDateString('id-ID')}</td><td><strong>${escapeHtml(expense.expenseNo)}</strong><br><small>${escapeHtml(expense.status)}</small></td><td>${escapeHtml(expense.outletName)}</td><td>${escapeHtml(expense.categoryName)}</td><td>${escapeHtml(expense.note)}${expense.vendorName?`<br><small>${escapeHtml(expense.vendorName)}</small>`:''}</td><td>${escapeHtml(expense.paymentMethod)}${expense.reference?`<br><small>${escapeHtml(expense.reference)}</small>`:''}</td><td><strong>${money.format(expense.amount)}</strong></td><td>${expense.status==='POSTED'?`<button class="link-button void-expense" data-id="${escapeHtml(expense.id)}" type="button">Batalkan</button>`:''}</td></tr>`),
  );
  const cash = data.cashFlow;
  el('owner-cashflow-metrics').innerHTML = [
    ['Kas masuk', cash.totalInflow],['Kas keluar', cash.totalOutflow],['Arus kas bersih', cash.netCashFlow],
  ].map(([label,value]) => `<div class="metric"><span>${label}</span><strong class="${label==='Arus kas bersih'&&Number(value)<0?'negative':''}">${money.format(value)}</strong></div>`).join('');
  el('owner-cashflow-methods').innerHTML = cash.methods.map((item) => `<div class="cashflow-method"><strong>${escapeHtml(item.method)}</strong><span>Masuk ${money.format(item.inflow)}</span><span>Keluar ${money.format(item.outflow)}</span><b class="${Number(item.net)>=0?'positive':'negative'}">${money.format(item.net)}</b></div>`).join('') || '<div class="empty-state compact">Belum ada arus kas.</div>';
  const dueReceivable = Number(data.aging.receivables.dueNext30 ?? 0);
  const duePayable = Number(data.aging.payables.dueNext30 ?? 0);
  el('owner-cashflow-projection').innerHTML = `<div class="projection-value"><span>Piutang jatuh tempo</span><strong>${money.format(dueReceivable)}</strong></div><div class="projection-value"><span>Hutang jatuh tempo</span><strong>${money.format(duePayable)}</strong></div><div class="projection-value total"><span>Proyeksi bersih</span><strong class="${dueReceivable-duePayable>=0?'positive':'negative'}">${money.format(dueReceivable-duePayable)}</strong></div>`;
  agingCards('owner-receivable-aging', data.aging.receivables);
  agingCards('owner-payable-aging', data.aging.payables);
  el('owner-customer-actions').innerHTML = reportTable(['Pelanggan','Struk','Jatuh tempo','Sisa','Terlambat'],data.customerActions.map((item)=>`<tr><td>${escapeHtml(item.customerName)}</td><td>${escapeHtml(item.receiptNo)}</td><td>${item.dueOn?new Date(`${item.dueOn}T00:00:00`).toLocaleDateString('id-ID'):'-'}</td><td><strong>${money.format(item.outstanding)}</strong></td><td>${Number(item.daysOverdue)} hari</td></tr>`));
  el('owner-supplier-actions').innerHTML = reportTable(['Supplier','Faktur','Jatuh tempo','Sisa','Terlambat'],data.supplierActions.map((item)=>`<tr><td>${escapeHtml(item.supplierName)}</td><td>${escapeHtml(item.documentNo)}</td><td>${item.dueOn?new Date(`${item.dueOn}T00:00:00`).toLocaleDateString('id-ID'):'-'}</td><td><strong>${money.format(item.outstanding)}</strong></td><td>${Number(item.daysOverdue)} hari</td></tr>`));
  renderOwnerProductHealth();
  el('accountant-export-summary').textContent = `Periode ${data.period.from}–${data.period.to} · ${data.expenses.length} dokumen biaya · ${data.products.length} produk dianalisis.`;
  el('owner-finance-status').textContent = `Periode ${data.period.from}–${data.period.to} · Dibuat ${new Date(data.generatedAt).toLocaleString('id-ID')}`;
}

async function loadOwnerFinance() {
  initializeOwnerFinanceFilters();
  const from=el('owner-finance-from').value,to=el('owner-finance-to').value;
  if(!from||!to||from>to)return toast('Periode laporan keuangan tidak valid.');
  const params=new URLSearchParams({from,to});
  if(el('owner-finance-outlet').value)params.set('outletId',el('owner-finance-outlet').value);
  el('owner-finance-status').textContent='Menghitung laba, kas, aging, dan kesehatan produk...';
  try{
    state.ownerFinance=await request(`/api/owner-finance?${params}`);
    renderOwnerFinance();
  }catch(error){
    el('owner-finance-status').textContent=`Laporan keuangan belum dapat dimuat: ${error.message}`;
    toast(error.message);
  }
}

async function saveOutletExpense(event) {
  event.preventDefault();
  try{
    await request('/api/outlet-expenses',{method:'POST',headers:{'idempotency-key':crypto.randomUUID()},body:JSON.stringify({
      occurredOn:el('expense-date').value,outletId:el('expense-outlet').value,
      categoryId:el('expense-category').value,amount:Number(el('expense-amount').value),
      paymentMethod:el('expense-method').value,reference:el('expense-reference').value,
      vendorName:el('expense-vendor').value,note:el('expense-note').value,
      shiftId:el('expense-method').value==='CASH'&&state.currentShift?.outlet_id===el('expense-outlet').value?state.currentShift.id:null,
    })});
    el('outlet-expense-form').reset();el('expense-date').value=storeDateToday();
    toast('Biaya outlet berhasil dicatat');await loadOwnerFinance();
  }catch(error){toast(error.message);}
}

async function saveExpenseCategory(event) {
  event.preventDefault();
  try{
    await request('/api/expense-categories',{method:'POST',body:JSON.stringify({
      name:el('expense-category-name').value,cashFlowGroup:el('expense-category-group').value,
    })});
    el('expense-category-name').value='';toast('Kategori biaya tersimpan');await loadOwnerFinance();
  }catch(error){toast(error.message);}
}

async function voidExpense(event) {
  const button=event.target.closest('.void-expense');if(!button)return;
  const reason=prompt('Alasan pembatalan biaya (minimal 5 karakter):');if(!reason)return;
  try{await request(`/api/outlet-expenses/${button.dataset.id}/void`,{method:'POST',body:JSON.stringify({reason})});toast('Biaya berhasil dibatalkan');await loadOwnerFinance();}
  catch(error){toast(error.message);}
}

function exportAccountantCsv() {
  const data=state.ownerFinance;if(!data)return toast('Muat laporan keuangan terlebih dahulu.');
  const rows=[
    ['BAGIAN','TANGGAL/DOKUMEN','KETERANGAN','DEBIT/MASUK','KREDIT/KELUAR','SALDO/NILAI'],
    ['LABA RUGI',data.period.from+' s.d. '+data.period.to,'Penjualan bersih',data.metrics.netSales,'',data.metrics.netSales],
    ['LABA RUGI','','HPP','',data.metrics.costOfGoods,data.metrics.grossProfit],
    ['LABA RUGI','','Biaya operasional','',data.metrics.operatingExpenses,data.metrics.operatingProfit],
  ];
  for(const item of data.expenses)rows.push(['BIAYA',item.expenseNo,`${item.categoryName} · ${item.outletName} · ${item.note}`,'',item.status==='POSTED'?item.amount:0,item.paymentMethod]);
  for(const item of data.cashFlow.methods)rows.push(['ARUS KAS',item.method,'Rekap metode',item.inflow,item.outflow,item.net]);
  for(const item of data.customerActions)rows.push(['PIUTANG',item.receiptNo,item.customerName,item.outstanding,'',item.dueOn??'']);
  for(const item of data.supplierActions)rows.push(['HUTANG',item.documentNo,item.supplierName,'',item.outstanding,item.dueOn??'']);
  for(const item of data.products.filter((product)=>product.deadStock||product.lowMargin||product.slowMoving))rows.push(['PERSEDIAAN',item.sku,`${item.productName} · ${item.deadStock?'DEAD STOCK':item.lowMargin?'MARGIN RENDAH':'LAMBAT'}`,'','',item.stockValue]);
  const blob=new Blob([`\uFEFF${rows.map((row)=>row.map(csvCell).join(',')).join('\r\n')}`],{type:'text/csv;charset=utf-8'});
  const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`paket-akuntan-${data.period.from}-${data.period.to}.csv`;link.click();URL.revokeObjectURL(link.href);
}

function shiftReportDate(value, days) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function applyReportPreset() {
  const today = storeDateToday();
  const preset = el('report-preset').value;
  if (preset === 'CUSTOM') return;
  el('report-to').value = today;
  if (preset === 'TODAY') el('report-from').value = today;
  if (preset === 'WEEK') {
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    el('report-from').value = shiftReportDate(today, weekday === 0 ? -6 : 1-weekday);
  }
  if (preset === '7D') el('report-from').value = shiftReportDate(today, -6);
  if (preset === '30D') el('report-from').value = shiftReportDate(today, -29);
  if (preset === 'MONTH') el('report-from').value = `${today.slice(0, 8)}01`;
  updateReportFilterSummary();
}

function updateReportFilterSummary(){
  const preset=el('report-preset'),outlet=el('report-outlet');
  const period=state.reportView==='sales'&&state.salesPeriodLevel!=='RANGE'
    ? salesPeriodTitle(state.salesPeriodLevel,state.salesPeriodValue)
    : preset.options[preset.selectedIndex]?.textContent??'Periode';
  const outletName=outlet.value?(outlet.options[outlet.selectedIndex]?.textContent??'Outlet'):'Semua outlet';
  el('report-filter-summary').textContent=`${period} · ${outletName}`;
}

function salesPeriodTitle(level,value){
  const today=storeDateToday();
  if(level==='ALL')return 'Selama ini';
  if(level==='YEAR')return `Tahun ${value??today.slice(0,4)}`;
  if(level==='MONTH'){
    const month=value??today.slice(0,7);
    return new Date(`${month}-01T00:00:00`).toLocaleDateString('id-ID',{month:'long',year:'numeric'});
  }
  if(level==='DAY'){
    const date=value??today;
    return date===today?'Hari ini':new Date(`${date}T00:00:00`).toLocaleDateString('id-ID',{day:'numeric',month:'long',year:'numeric'});
  }
  return 'Periode pilihan';
}

function salesMonthEnd(month){
  const [year,number]=month.split('-').map(Number);
  return new Date(Date.UTC(year,number,0)).toISOString().slice(0,10);
}

function readSalesReportFilter(){
  state.salesReportFilter={
    staffId:el('sales-filter-staff').value,
    paymentState:el('sales-filter-payment-state').value,
    sort:el('sales-filter-sort').value,
    paymentMethods:[...document.querySelectorAll('[data-sales-payment-method]:checked')].map((input)=>input.dataset.salesPaymentMethod),
    includeCreditProfit:el('sales-include-credit-profit').checked,
    includeCreditRevenue:el('sales-include-credit-revenue').checked
  };
  const staff=el('sales-filter-staff').selectedOptions[0]?.textContent??'Semua staff';
  const payment={ALL:'Cash dan piutang',PAID:'Tunai / dibayar',CREDIT:'Piutang'}[state.salesReportFilter.paymentState];
  el('sales-filter-summary').textContent=`${staff} · ${payment} · ${state.salesReportFilter.sort==='ASC'?'Terlama':'Terbaru'}`;
  const checked=state.salesReportFilter.paymentMethods.length;
  el('sales-report-filters').querySelector('.sales-filter-group summary small').textContent=checked===6?'Semua aktif':`${checked} dari 6 aktif`;
}

function salesPaymentClassification(sale){
  const methods=(sale.payments??[]).map((payment)=>['CASH','TUNAI'].includes(String(payment.method).toUpperCase())?'CASH':String(payment.method).toUpperCase());
  return methods.length>1?'MULTIPAYMENT':methods[0]??'';
}

function saleReportAmounts(sale){
  const credit=(sale.payments??[]).filter((payment)=>String(payment.method).toUpperCase()==='CREDIT').reduce((sum,payment)=>sum+Number(payment.amount??0),0);
  const settled=Math.max(0,Number(sale.quote?.grandTotal??0)-credit)+Number(sale.paidCreditAmount??0);
  const ratio=Number(sale.quote?.grandTotal)>0?Math.min(1,Math.max(0,settled/Number(sale.quote.grandTotal))):1;
  const revenue=state.salesReportFilter.includeCreditRevenue?Number(sale.netTotal??0):Number(sale.netTotal??0)*ratio;
  const profit=state.salesReportFilter.includeCreditProfit?Number(sale.grossProfit??0):Number(sale.grossProfit??0)*ratio;
  return{revenue,profit};
}

function filteredPosSales(){
  const filter=state.salesReportFilter;
  return state.posSales.filter((sale)=>{
    const hasCredit=(sale.payments??[]).some((payment)=>String(payment.method).toUpperCase()==='CREDIT');
    if(filter.staffId&&sale.cashierId!==filter.staffId)return false;
    if(filter.paymentState==='PAID'&&hasCredit)return false;
    if(filter.paymentState==='CREDIT'&&!hasCredit)return false;
    return filter.paymentMethods.includes(salesPaymentClassification(sale));
  }).sort((a,b)=>(filter.sort==='ASC'?1:-1)*(new Date(a.occurredAt)-new Date(b.occurredAt)));
}

function renderSalesStaffOptions(staff=[]){
  const selected=state.salesReportFilter.staffId;
  el('sales-filter-staff').innerHTML='<option value="">Semua staff</option>'+staff.map((item)=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  if(staff.some((item)=>item.id===selected))el('sales-filter-staff').value=selected;
  else state.salesReportFilter.staffId='';
  readSalesReportFilter();
}

async function loadFilteredSalesReport(){
  readSalesReportFilter();
  const filter=state.salesReportFilter;
  const params=new URLSearchParams({
    from:el('report-from').value,to:el('report-to').value,paymentState:filter.paymentState,
    paymentMethods:filter.paymentMethods.join(','),includeCreditProfit:String(filter.includeCreditProfit),
    includeCreditRevenue:String(filter.includeCreditRevenue)
  });
  if(filter.staffId)params.set('staffId',filter.staffId);
  if(el('report-outlet').value)params.set('outletId',el('report-outlet').value);
  const data=await request(`/api/reports/sales-filtered?${params}`);
  state.report={...(state.report??{}),period:data.period,metrics:{...(state.report?.metrics??{}),...data.metrics},daily:data.daily??[]};
  renderSalesStaffOptions(data.staff??[]);
  renderSalesMetricCards(state.report.metrics);
  el('report-status').textContent=`${salesPeriodTitle(state.salesPeriodLevel,state.salesPeriodValue)} · ${Number(data.metrics.transactionCount).toLocaleString('id-ID')} transaksi sesuai filter${data.truncated?' · hanya 10.000 transaksi terbaru':''}`;
  return data;
}

function salesAnalysisRange(){
  const today=storeDateToday(),preset=state.salesAnalysis.preset;
  if(preset==='YESTERDAY'){const yesterday=shiftReportDate(today,-1);return{from:yesterday,to:yesterday};}
  if(preset==='7D')return{from:shiftReportDate(today,-6),to:today};
  if(preset==='MONTH')return{from:`${today.slice(0,7)}-01`,to:today};
  if(preset==='YEAR')return{from:`${today.slice(0,4)}-01-01`,to:today};
  if(preset==='ALL')return{from:'2000-01-01',to:today};
  if(preset==='CUSTOM')return{from:el('sales-analysis-from').value,to:el('sales-analysis-to').value};
  return{from:today,to:today};
}

function renderSalesAnalysis(){
  const view=state.salesAnalysis.view,data=state.salesAnalysis.data??{},query=el('sales-analysis-search').value.trim().toLowerCase(),sort=state.salesAnalysis.sort;
  const flow=view==='stock-flow';
  el('sales-analysis-periods').classList.toggle('hidden',flow);
  el('stock-flow-date-filter').classList.toggle('hidden',!flow);
  el('sales-analysis-dashboard').classList.toggle('hidden',flow);
  el('sales-category-chart').classList.toggle('hidden',view!=='sales-categories');
  const dashboard=flow
    ? (data.rows??[]).reduce((sum,row)=>{sum.qtySold+=Number(row.stockOut);sum.netRevenue+=Number(row.stockIn);sum.grossProfit+=Number(row.netFlow);return sum;},{qtySold:0,netRevenue:0,grossProfit:0})
    : data.dashboard??{qtySold:0,netRevenue:0,grossProfit:0};
  el('sales-analysis-dashboard').innerHTML=`<article class="primary"><span>Qty terjual</span><strong>${Number(dashboard.qtySold).toLocaleString('id-ID')} pcs</strong></article><article><span>Pendapatan</span><strong>${money.format(dashboard.netRevenue)}</strong></article><article><span>Keuntungan</span><strong>${money.format(dashboard.grossProfit)}</strong></article>`;
  let rows=view==='sales-categories'?data.categories??[]:view==='sales-addons'?data.addons??[]:view==='stock-flow'?data.rows??[]:data.products??[];
  rows=rows.filter((row)=>!query||`${row.productName??''} ${row.sku??''} ${row.category??''}`.toLowerCase().includes(query));
  const qty=(row)=>Number(flow?row.stockOut:row.qtySold??row.addonTransactions??0);
  rows.sort((a,b)=>{
    if(sort==='DATE_ASC')return new Date(a.occurredAt)-new Date(b.occurredAt);
    if(sort==='DATE_DESC')return new Date(b.occurredAt)-new Date(a.occurredAt);
    if(sort==='QTY_ASC')return qty(a)-qty(b);
    if(sort==='NAME')return String(a.productName??a.category).localeCompare(String(b.productName??b.category),'id');
    if(sort==='PROFIT')return Number(b.grossProfit??b.netFlow)-Number(a.grossProfit??a.netFlow);
    if(sort==='REVENUE')return Number(b.netRevenue??b.stockIn)-Number(a.netRevenue??a.stockIn);
    return qty(b)-qty(a);
  });
  if(view==='sales-categories'){
    const maximum=Math.max(1,...rows.map((row)=>Number(row.netRevenue)));
    el('sales-category-chart-bars').innerHTML=rows.map((row)=>`<div class="sales-category-bar"><span><strong>${escapeHtml(row.category)}</strong><small>${money.format(row.netRevenue)} · untung ${money.format(row.grossProfit)}</small></span><i><b style="width:${Math.max(2,Number(row.netRevenue)/maximum*100)}%"></b></i></div>`).join('')||'<div class="empty-state compact">Belum ada data kategori.</div>';
  }
  const content=rows.map((row)=>{
    if(view==='sales-categories')return`<article class="sales-analysis-row category"><span class="sales-analysis-avatar">${escapeHtml(String(row.category).slice(0,1).toUpperCase())}</span><div><strong>${escapeHtml(row.category)}</strong><small>${Number(row.productCount)} barang · Pendapatan ${money.format(row.netRevenue)} · Keuntungan ${money.format(row.grossProfit)}</small></div><aside><small>Terjual</small><strong>${Number(row.qtySold).toLocaleString('id-ID')} pcs</strong></aside></article>`;
    if(flow)return`<article class="stock-flow-row"><div><strong>${escapeHtml(row.productName)}</strong><small>${new Date(row.occurredAt).toLocaleString('id-ID')}</small></div><span>${escapeHtml(row.sku)}</span><b>${Number(row.stockIn).toLocaleString('id-ID')}</b><b>${Number(row.stockOut).toLocaleString('id-ID')}</b></article>`;
    const right=view==='sales-addons'?`${Number(row.addonTransactions).toLocaleString('id-ID')} transaksi`:`${Number(row.qtySold).toLocaleString('id-ID')} pcs`;
    return`<article class="sales-analysis-row">${productThumbnail({...row,name:row.productName})}<div><strong>${escapeHtml(row.productName)}</strong><small>${escapeHtml(row.sku)} · ${escapeHtml(row.category)}</small><small>Keuntungan ${money.format(row.grossProfit)} · Pendapatan ${money.format(row.netRevenue)}</small></div><aside><small>${view==='sales-addons'?'Terjual sebagai add-on':'Total terjual'}</small><strong>${right}</strong></aside></article>`;
  }).join('');
  el('sales-analysis-list').innerHTML=flow&&content?`<div class="stock-flow-head"><span>Nama barang</span><span>Kode barang</span><span>Masuk</span><span>Keluar</span></div>${content}`:content||'<div class="empty-state compact">Belum ada data yang sesuai.</div>';
  bindProductImageFallbacks(el('sales-analysis-list'));
}

async function loadSalesAnalysis(){
  readSalesReportFilter();
  const range=salesAnalysisRange();
  if(!range.from||!range.to||range.from>range.to)return toast('Periode analisis tidak valid.');
  el('report-status').classList.add('loading');el('report-status').textContent='Memuat analisis...';
  try{
    const filter=state.salesReportFilter,params=new URLSearchParams({from:range.from,to:range.to,paymentState:filter.paymentState,paymentMethods:filter.paymentMethods.join(','),includeCreditProfit:String(filter.includeCreditProfit),includeCreditRevenue:String(filter.includeCreditRevenue)});
    if(filter.staffId)params.set('staffId',filter.staffId);
    if(el('report-outlet').value)params.set('outletId',el('report-outlet').value);
    const endpoint=state.salesAnalysis.view==='stock-flow'?'stock-flow':'sales-items';
    const data=await request(`/api/reports/${endpoint}?${params}`);
    state.salesAnalysis.data=data;
    if(data.staff)renderSalesStaffOptions(data.staff);
    renderSalesAnalysis();
    el('report-status').textContent=`Periode ${new Date(`${range.from}T00:00:00`).toLocaleDateString('id-ID')}–${new Date(`${range.to}T00:00:00`).toLocaleDateString('id-ID')}${data.truncated?' · maksimal 10.000 transaksi':''}`;
  }catch(error){el('report-status').textContent=`Analisis belum dapat dimuat: ${error.message}`;toast(error.message);}
  finally{el('report-status').classList.remove('loading');}
}

function renderSalesMetricCards(metrics){
  state.salesMetrics=metrics;
  const options=[
    ['transactions','Jumlah transaksi'],
    ['revenue','Pendapatan'],
    ['profit','Keuntungan'],
    ['returns','Retur pelanggan']
  ];
  el('report-cards').innerHTML=options.map(([key,label])=>`<button class="metric sales-metric-button ${state.salesMetricKey===key?'active':''}" type="button" data-sales-metric="${key}" aria-pressed="${state.salesMetricKey===key}">${label}</button>`).join('');
  renderSelectedSalesMetric();
}

function renderSelectedSalesMetric(){
  const metrics=state.salesMetrics??{};
  const values={
    transactions:['Jumlah transaksi',Number(metrics.transactionCount??0).toLocaleString('id-ID'),'transaksi selesai pada periode ini'],
    revenue:['Pendapatan',money.format(metrics.netSales??0),'penjualan bersih setelah retur'],
    profit:['Keuntungan',money.format(metrics.grossProfit??0),'laba kotor setelah harga pokok dan retur'],
    returns:['Retur pelanggan',money.format(metrics.returnTotal??0),'nilai barang yang dikembalikan pelanggan']
  };
  const [label,value,caption]=values[state.salesMetricKey]??values.transactions;
  el('report-cards').querySelectorAll('[data-sales-metric]').forEach((button)=>{
    const active=button.dataset.salesMetric===state.salesMetricKey;
    button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
  });
  el('sales-metric-value').innerHTML=`<small>${label}</small><strong>${value}</strong><span>${caption}</span>`;
}

function salesPeriodRow({label,caption,transactions,netSales,grossProfit,level,value}){
  return `<div class="sales-period-row"><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(caption)}</small></span><span><small>Transaksi</small><strong>${Number(transactions??0).toLocaleString('id-ID')}</strong></span><span><small>Pendapatan</small><strong>${money.format(netSales??0)}</strong></span><span><small>Keuntungan</small><strong>${money.format(grossProfit??0)}</strong></span><button class="button secondary" type="button" data-sales-drill-level="${level}" data-sales-drill-value="${value}">Detail</button></div>`;
}

function salesPeriodHeading(eyebrow,title,description){
  const back=state.salesPeriodTrail.length?'<button class="button secondary" type="button" data-sales-period-back>← Kembali</button>':'';
  return `<div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h2>${escapeHtml(title)}</h2><p class="muted">${escapeHtml(description)}</p></div>${back}`;
}

function renderSalesPeriodBreakdown(){
  const level=state.salesPeriodLevel,report=state.report;
  const breakdown=el('sales-period-breakdown'),workspace=el('report-sales-workspace');
  const showTransactions=['DAY','RANGE'].includes(level);
  workspace.classList.toggle('hidden',!showTransactions);
  const showDayContext=level==='DAY'&&state.salesPeriodTrail.length>0;
  breakdown.classList.toggle('hidden',showTransactions&&!showDayContext);
  if(showDayContext){
    el('sales-period-heading').innerHTML=salesPeriodHeading('RIWAYAT TRANSAKSI HARIAN',salesPeriodTitle(level,state.salesPeriodValue),'Seluruh struk pada tanggal ini ditampilkan di bawah.');
    el('sales-period-list').innerHTML='';
  }
  if(showTransactions||!report)return;
  if(level==='MONTH'){
    const rows=[...(report.daily??[])].filter((item)=>Number(item.transactionCount)||Number(item.returns)).reverse();
    el('sales-period-heading').innerHTML=salesPeriodHeading('TRANSAKSI PER HARI',salesPeriodTitle(level,state.salesPeriodValue),'Tekan Detail untuk membuka seluruh struk pada tanggal tersebut.');
    el('sales-period-list').innerHTML=rows.map((item)=>salesPeriodRow({label:new Date(`${item.date}T00:00:00`).toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'long'}),caption:`Retur ${money.format(item.returns)}`,transactions:item.transactionCount,netSales:item.netSales,grossProfit:item.grossProfit,level:'DAY',value:item.date})).join('')||'<div class="empty-state compact">Belum ada transaksi pada bulan ini.</div>';
    return;
  }
  if(level==='YEAR'){
    const months=new Map();
    for(const item of report.daily??[]){
      const key=item.date.slice(0,7),current=months.get(key)??{transactions:0,netSales:0,grossProfit:0,returns:0};
      current.transactions+=Number(item.transactionCount);current.netSales+=Number(item.netSales);current.grossProfit+=Number(item.grossProfit);current.returns+=Number(item.returns);months.set(key,current);
    }
    const rows=[...months.entries()].filter(([,item])=>item.transactions||item.returns).reverse();
    el('sales-period-heading').innerHTML=salesPeriodHeading('PENJUALAN PER BULAN',salesPeriodTitle(level,state.salesPeriodValue),'Tekan Detail untuk melihat transaksi per tanggal dalam bulan tersebut.');
    el('sales-period-list').innerHTML=rows.map(([month,item])=>salesPeriodRow({label:new Date(`${month}-01T00:00:00`).toLocaleDateString('id-ID',{month:'long',year:'numeric'}),caption:`Retur ${money.format(item.returns)}`,transactions:item.transactions,netSales:item.netSales,grossProfit:item.grossProfit,level:'MONTH',value:month})).join('')||'<div class="empty-state compact">Belum ada transaksi pada tahun ini.</div>';
  }
}

async function loadSalesAllTime(){
  el('report-status').classList.add('loading');el('report-status').textContent='Menghitung laporan seluruh tahun...';
  el('report-sales-workspace').classList.add('hidden');el('sales-period-breakdown').classList.remove('hidden');
  try{
    const params=new URLSearchParams();if(el('report-outlet').value)params.set('outletId',el('report-outlet').value);
    const bounds=await request(`/api/reports/sales-years${params.size?`?${params}`:''}`);
    el('report-from').value=`${bounds.fromYear}-01-01`;el('report-to').value=storeDateToday();
    await loadFilteredSalesReport();
    const years=new Map();
    for(const item of state.report.daily??[]){
      const year=item.date.slice(0,4),current=years.get(year)??{netSales:0,grossProfit:0,returnTotal:0,transactionCount:0};
      current.netSales+=Number(item.netSales);current.grossProfit+=Number(item.grossProfit);current.returnTotal+=Number(item.returns);current.transactionCount+=Number(item.transactionCount);years.set(year,current);
    }
    state.salesYears=[...years.entries()].sort(([a],[b])=>b.localeCompare(a)).map(([year,metrics])=>({year,metrics}));
    el('sales-period-heading').innerHTML=salesPeriodHeading('PENJUALAN PER TAHUN','Seluruh riwayat usaha','Tekan Detail untuk membuka laporan bulanan pada tahun tersebut.');
    el('sales-period-list').innerHTML=state.salesYears.filter((item)=>Number(item.metrics.transactionCount)||Number(item.metrics.returnTotal)).map((item)=>salesPeriodRow({label:`Tahun ${item.year}`,caption:`Retur ${money.format(item.metrics.returnTotal)}`,transactions:item.metrics.transactionCount,netSales:item.metrics.netSales,grossProfit:item.metrics.grossProfit,level:'YEAR',value:String(item.year)})).join('')||'<div class="empty-state compact">Belum ada transaksi penjualan.</div>';
  }catch(error){el('report-status').textContent=`Laporan belum dapat dimuat: ${error.message}`;toast(error.message);}
  finally{el('report-status').classList.remove('loading');}
}

async function selectSalesPeriod(level,value=null,{drill=false,back=false}={}){
  const today=storeDateToday();
  if(drill)state.salesPeriodTrail.push({level:state.salesPeriodLevel,value:state.salesPeriodValue});
  else if(!back)state.salesPeriodTrail=[];
  state.salesPeriodLevel=level;state.salesPeriodValue=value;
  el('sales-report-detail-title').textContent=salesPeriodTitle(level,value);
  el('sales-period-nav').querySelectorAll('[data-sales-period]').forEach((button)=>button.classList.toggle('active',button.dataset.salesPeriod===level));
  if(level==='ALL'){el('report-preset').value='CUSTOM';updateReportFilterSummary();return loadSalesAllTime();}
  let from=today,to=today;
  if(level==='DAY')from=to=value??today;
  if(level==='MONTH'){
    const month=value??today.slice(0,7);state.salesPeriodValue=month;from=`${month}-01`;to=month===today.slice(0,7)?today:salesMonthEnd(month);
  }
  if(level==='YEAR'){
    const year=String(value??today.slice(0,4));state.salesPeriodValue=year;from=`${year}-01-01`;to=year===today.slice(0,4)?today:`${year}-12-31`;
  }
  el('report-from').value=from;el('report-to').value=to;
  el('report-preset').value=level==='DAY'&&from===today?'TODAY':level==='MONTH'&&state.salesPeriodValue===today.slice(0,7)?'MONTH':'CUSTOM';
  updateReportFilterSummary();await loadReport();
}

function renderReportOutletOptions() {
  const selected = el('report-outlet').value;
  el('report-outlet').innerHTML = '<option value="">Semua outlet yang dapat diakses</option>' + state.outlets.map((outlet) => `<option value="${escapeHtml(outlet.id)}">${escapeHtml(outlet.name)}</option>`).join('');
  if (state.outlets.some((outlet) => outlet.id === selected)) el('report-outlet').value = selected;
  updateReportFilterSummary();
}

function reportTable(headers, rows) {
  if (!rows.length) return '<div class="empty-state compact">Belum ada data pada periode ini.</div>';
  return `<table class="report-table"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function renderOperationalReport(audit) {
  const report = state.report;
  const metrics = report.metrics;
  el('report-cards').innerHTML = [
    ['Pendapatan / penjualan bersih', money.format(metrics.netSales), ''],
    ['Keuntungan / laba kotor', money.format(metrics.grossProfit), 'profit-metric'],
    ['Retur pelanggan', money.format(metrics.returnTotal), 'return-metric'],
    ['Transaksi', Number(metrics.transactionCount).toLocaleString('id-ID'), ''],
    ['Nilai persediaan', money.format(metrics.inventoryValue), ''],
    ['Pembelian bersih', money.format(metrics.netPurchaseValue??metrics.purchaseValue), Number(metrics.purchaseReturnValue)?`Retur supplier ${money.format(metrics.purchaseReturnValue)}`:'']
  ].map(([label, value, className]) => `<div class="metric ${className}"><span>${label}</span><strong>${value}</strong></div>`).join('');
  if(state.reportView==='sales')renderSalesMetricCards(metrics);

  const daily = [...report.daily].reverse();
  el('daily-report').innerHTML = reportTable(['Tanggal', 'Bruto', 'Retur', 'Bersih', 'Laba'], daily.map((item) => `<tr><td>${new Date(`${item.date}T00:00:00`).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })}</td><td>${money.format(item.grossSales)}</td><td class="${Number(item.returns) ? 'negative' : ''}">${money.format(item.returns)}</td><td><strong>${money.format(item.netSales)}</strong></td><td class="${Number(item.grossProfit) >= 0 ? 'positive' : 'negative'}">${money.format(item.grossProfit)}</td></tr>`));

  el('best-products').innerHTML = report.products.filter((item) => Number(item.netQty) || Number(item.netRevenue) || Number(item.grossProfit)).slice(0, 10).map((item, index) => `<div class="report-item"><div><strong>${index + 1}. ${escapeHtml(item.productName)}</strong><small>${Number(item.netQty).toLocaleString('id-ID')} pcs bersih</small></div><div class="report-item-value"><strong>${money.format(item.netRevenue)}</strong><small>Laba ${money.format(item.grossProfit)}</small></div></div>`).join('') || '<div class="empty-state compact">Belum ada penjualan produk.</div>';
  el('outlet-performance').innerHTML = report.outlets.map((item) => `<div class="report-item"><div><strong>${escapeHtml(item.outletName)}</strong><small>${Number(item.transactionCount).toLocaleString('id-ID')} transaksi · retur ${money.format(item.returnTotal)}</small></div><div class="report-item-value"><strong>${money.format(item.netSales)}</strong><small>Laba ${money.format(item.grossProfit)}</small></div></div>`).join('') || '<div class="empty-state compact">Belum ada outlet.</div>';
  el('supplier-purchases').innerHTML = report.suppliers.slice(0, 10).map((item) => `<div class="report-item"><div><strong>${escapeHtml(item.supplierName)}</strong><small>${Number(item.receiptCount).toLocaleString('id-ID')} penerimaan · ${Number(item.units).toLocaleString('id-ID')} pcs${Number(item.returnCount)?` · ${Number(item.returnCount)} retur`:''}</small></div><div class="report-item-value"><strong>${money.format(item.netPurchaseValue??item.purchaseValue)}</strong>${Number(item.returnCredit)?`<small>Retur −${money.format(item.returnCredit)}</small>`:''}</div></div>`).join('') || '<div class="empty-state compact">Belum ada penerimaan pembelian.</div>';
  el('audit-logs').innerHTML = audit.logs.slice(0, 12).map((log) => `<div class="sale-row"><span><strong>${escapeHtml(log.action.replaceAll('_', ' '))}</strong><br><small>${escapeHtml(log.entity_type)} · ${new Date(log.occurred_at).toLocaleString('id-ID')}</small></span><small>${escapeHtml(log.actor_name ?? log.actor_id ?? 'Sistem')}</small></div>`).join('') || '<p class="muted">Belum ada aktivitas tercatat.</p>';
  el('report-status').textContent = `Periode ${new Date(`${report.period.from}T00:00:00`).toLocaleDateString('id-ID')}–${new Date(`${report.period.to}T00:00:00`).toLocaleDateString('id-ID')} · Margin kotor ${Number(metrics.grossMarginPercent).toLocaleString('id-ID', { maximumFractionDigits: 2 })}% · Dibuat ${new Date(report.generatedAt).toLocaleTimeString('id-ID')}`;
}

async function loadReport() {
  if (!el('report-from').value || !el('report-to').value) applyReportPreset();
  renderReportOutletOptions();
  const from = el('report-from').value;
  const to = el('report-to').value;
  if (!from || !to || from > to) return toast('Periode laporan tidak valid.');
  const params = new URLSearchParams({ from, to });
  if (el('report-outlet').value) params.set('outletId', el('report-outlet').value);
  el('report-status').classList.add('loading'); el('report-status').textContent = 'Menghitung laporan...';
  try {
    const [report, audit] = await Promise.all([request(`/api/reports/summary?${params}`), request('/api/audit')]);
    state.report = report;
    renderOperationalReport(audit);
    if(state.reportView==='sales'){
      await loadFilteredSalesReport();
      renderSalesPeriodBreakdown();
      if(['DAY','RANGE'].includes(state.salesPeriodLevel))await loadPosSales('',{reportScope:true});
    }
  } catch (error) {
    el('report-status').textContent = `Laporan belum dapat dimuat: ${error.message}`;
    toast(error.message);
  } finally { el('report-status').classList.remove('loading'); }
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportReportCsv() {
  if (!state.report) return toast('Muat laporan terlebih dahulu.');
  const rows = [['Tanggal','Penjualan bruto','Retur','Penjualan bersih','Laba kotor','Transaksi','Jumlah retur']];
  for (const item of state.report.daily) rows.push([item.date,item.grossSales,item.returns,item.netSales,item.grossProfit,item.transactionCount,item.returnCount]);
  const blob = new Blob([`\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = `laporan-kasir-nusa-${state.report.period.from}-${state.report.period.to}.csv`;
  link.click(); URL.revokeObjectURL(link.href);
}

function returnConditionLabel(condition) {
  return ({ SALEABLE:'Layak dijual kembali',OPENED:'Sudah dibuka/dipakai',DAMAGED:'Rusak atau bocor',EXPIRED:'Kedaluwarsa' })[condition] ?? condition;
}

function effectiveRefundMethod() {
  const selected=el('return-refund-method').value;
  if(selected!=='ORIGINAL') return selected;
  if(Number(state.returnSale?.creditAmount??0)>0) return 'ACCOUNT_CREDIT';
  const original=state.returnSale?.paymentMethod ?? '';
  if(/^tunai/i.test(original)) return 'CASH';
  if(/^qris/i.test(original)) return 'QRIS';
  if(/^edc/i.test(original)) return 'EDC';
  return 'TRANSFER';
}

function selectedReturnItems() {
  if(!state.returnSale) return [];
  return [...el('return-item-list').querySelectorAll('.return-line')].filter((row)=>row.querySelector('.return-select').checked).map((row)=>{
    const line=state.returnSale.lines.find((item)=>item.saleItemId===row.dataset.saleItemId);
    const qty=Math.min(Number(row.querySelector('.return-qty').value),Number(line?.remainingQty??0));
    return { saleItemId:row.dataset.saleItemId,baseQty:qty,condition:row.querySelector('.return-condition').value,unitRefund:Number(line?.unitRefund??0) };
  }).filter((item)=>item.baseQty>0);
}

function syncReturnRefundFields() {
  const method=effectiveRefundMethod(); const nonCash=!['CASH','ACCOUNT_CREDIT'].includes(method);
  el('return-reference-field').classList.toggle('hidden',!nonCash);
  el('return-refund-reference').required=nonCash;
  const cashReady=method!=='CASH'||Boolean(state.currentShift&&state.currentShift.status==='OPEN'&&state.currentShift.outlet_id===state.returnSale?.outletId);
  el('return-cash-warning').classList.toggle('hidden',method!=='CASH');
  el('return-cash-warning').innerHTML=cashReady?`<strong>Refund tunai tercatat pada shift aktif.</strong><small>${escapeHtml(state.currentShift?.cashier_name??state.session?.user.displayName)} · kas akan berkurang otomatis.</small>`:'<strong>Belum ada shift aktif pada outlet transaksi.</strong><small>Buka shift milik Anda terlebih dahulu sebelum melakukan refund tunai.</small>';
  const total=selectedReturnItems().reduce((sum,item)=>sum+item.baseQty*item.unitRefund,0);
  el('return-refund-total').textContent=money.format(total);
  el('submit-return').disabled=!selectedReturnItems().length||!cashReady;
}

function renderReturnSale() {
  const sale=state.returnSale;
  if(!sale){el('return-workspace').classList.add('hidden');return;}
  el('return-workspace').classList.remove('hidden');
  const statusLabel=({RETURNABLE:'BELUM DIRETUR',PARTIALLY_RETURNED:'RETUR SEBAGIAN',FULLY_RETURNED:'SUDAH DIRETUR PENUH'})[sale.status]??sale.status;
  el('return-sale-summary').innerHTML=`<div><p class="eyebrow">STRUK DITEMUKAN</p><h2>${escapeHtml(sale.receiptNo)}</h2><small>${new Date(sale.occurredAt).toLocaleString('id-ID')} · ${escapeHtml(sale.outletName)} · ${escapeHtml(sale.cashierName)}</small></div><div><span class="status-badge ${sale.status==='FULLY_RETURNED'?'received':'approved'}">${statusLabel}</span><strong>${money.format(sale.grandTotal)}</strong><small>${escapeHtml(sale.paymentMethod)} · ${escapeHtml(sale.customer?.name??'Pelanggan umum')}</small></div>`;
  el('return-item-list').innerHTML=sale.lines.map((line)=>`<article class="return-line ${line.remainingQty<=0?'completed':''}" data-sale-item-id="${escapeHtml(line.saleItemId)}"><label class="return-line-select"><input class="return-select" type="checkbox" ${line.remainingQty<=0?'disabled':''}><span><strong>${escapeHtml(line.productName)}</strong><small>Terjual ${Number(line.soldQty).toLocaleString('id-ID')} pcs · pernah diretur ${Number(line.returnedQty).toLocaleString('id-ID')} pcs</small></span></label><div class="return-line-fields"><label>Jumlah retur<input class="return-qty" type="number" min="0" max="${line.remainingQty}" step="any" value="${line.remainingQty>0?1:0}" ${line.remainingQty<=0?'disabled':''}></label><label>Kondisi barang<select class="return-condition" ${line.remainingQty<=0?'disabled':''}><option value="SALEABLE">Layak dijual kembali</option><option value="OPENED">Sudah dibuka/dipakai</option><option value="DAMAGED">Rusak atau bocor</option><option value="EXPIRED">Kedaluwarsa</option></select></label><div class="return-line-value"><span>Sisa dapat diretur</span><strong>${Number(line.remainingQty).toLocaleString('id-ID')} pcs</strong><small>${money.format(line.unitRefund)} / pcs</small></div></div><div class="return-stock-impact"><span class="badge ok">Kembali ke stok jual</span><strong class="return-line-refund">${money.format(0)}</strong></div></article>`).join('');
  syncReturnRefundFields();
}

function updateReturnLine(row) {
  const line=state.returnSale?.lines.find((item)=>item.saleItemId===row.dataset.saleItemId); if(!line)return;
  const qtyInput=row.querySelector('.return-qty'); let qty=Math.max(0,Number(qtyInput.value)||0); qty=Math.min(qty,Number(line.remainingQty)); qtyInput.value=qty;
  const condition=row.querySelector('.return-condition').value; const restockable=condition==='SALEABLE';
  row.querySelector('.return-stock-impact .badge').className=`badge ${restockable?'ok':'danger'}`;
  row.querySelector('.return-stock-impact .badge').textContent=restockable?'Kembali ke stok jual':'Tidak masuk stok jual';
  row.querySelector('.return-line-refund').textContent=money.format(row.querySelector('.return-select').checked?qty*Number(line.unitRefund):0);
  syncReturnRefundFields();
}

async function findReturnSale() {
  const receiptNo=el('return-receipt-search').value.trim(); if(!receiptNo)return toast('Masukkan nomor struk.');
  el('return-search-status').textContent='Mencari transaksi...';
  try{const data=await request(`/api/sales/lookup?receiptNo=${encodeURIComponent(receiptNo)}`);state.returnSale=data.sale;el('return-search-status').textContent=`Transaksi ${data.sale.receiptNo} ditemukan.`;renderReturnSale();}
  catch(error){state.returnSale=null;renderReturnSale();el('return-search-status').textContent=error.message;}
}

function cancelCustomerReturn() {
  if(!state.returnSale)return;
  if(!window.confirm('Batalkan proses retur yang sedang diisi dan kembali ke pencarian struk?'))return;
  state.returnSale=null;
  el('return-form').reset();
  el('return-refund-reference').value='';
  el('return-workspace').classList.add('hidden');
  el('return-receipt-search').value='';
  el('return-search-status').textContent='Proses retur dibatalkan. Masukkan nomor struk lain untuk memulai kembali.';
  el('return-receipt-search').focus();
}

async function submitCustomerReturn(event) {
  event.preventDefault(); const items=selectedReturnItems(); if(!items.length)return toast('Pilih minimal satu barang retur.');
  const reason=el('return-reason').value; if(!reason)return toast('Pilih alasan retur.');
  const note=el('return-note').value.trim(); const refundMethod=el('return-refund-method').value; const effective=effectiveRefundMethod();
  const refundReference=el('return-refund-reference').value.trim(); if(!['CASH','ACCOUNT_CREDIT'].includes(effective)&&!refundReference)return toast('Isi nomor referensi refund.');
  const total=items.reduce((sum,item)=>sum+item.baseQty*item.unitRefund,0);
  if(!window.confirm(`Proses retur ${items.length} barang dengan refund ${money.format(total)}?`))return;
  const button=el('submit-return');button.disabled=true;button.textContent='Memproses retur...';
  try{
    const result=await request('/api/returns',{method:'POST',headers:{'idempotency-key':crypto.randomUUID()},body:JSON.stringify({saleId:state.returnSale.id,reason:note?`${reason} — ${note}`:reason,refundMethod,refundReference:refundReference||null,refundShiftId:effective==='CASH'?state.currentShift?.id:null,items:items.map(({unitRefund,...item})=>item)})});
    toast(`Retur ${result.returnNo} berhasil · ${money.format(result.total)}`);
    const refreshed=await request(`/api/sales/${state.returnSale.id}`);state.returnSale=refreshed.sale;renderReturnSale();await refreshCatalog();await loadCustomerAging();
    if(state.session.permissions.includes('inventory.manage'))await loadInventory(); if(state.session.permissions.includes('report.view'))await loadReport();
  }catch(error){toast(error.message);}finally{button.textContent='Proses retur dan refund';syncReturnRefundFields();}
}

function syncAge(occurredAt) {
  const minutes = Math.max(0, Math.floor((Date.now()-new Date(occurredAt).getTime())/60000));
  if (minutes < 60) return `${minutes} menit`;
  if (minutes < 1440) return `${Math.floor(minutes/60)} jam`;
  return `${Math.floor(minutes/1440)} hari`;
}

function renderSyncReview() {
  const commands = state.syncReview;
  const expected = commands.reduce((sum, command) => sum+Number(command.expectedTotal), 0);
  const difference = commands.reduce((sum, command) => sum+Number(command.difference), 0);
  const oldest = commands[0]?.occurredAt ? syncAge(commands[0].occurredAt) : '-';
  el('sync-review-metrics').innerHTML = [
    ['Perlu keputusan', commands.length, 'transaksi'],
    ['Total di kasir', money.format(expected), 'sudah ditagihkan'],
    ['Selisih harga terbaru', money.format(difference), difference === 0 ? 'tidak berubah' : difference > 0 ? 'harga terbaru lebih tinggi' : 'harga terbaru lebih rendah'],
    ['Antrean tertua', oldest, commands.length ? 'sejak transaksi' : 'antrean kosong']
  ].map(([label,value,note]) => `<div class="metric"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join('');
  el('sync-review-status').textContent = commands.length ? `${commands.length} transaksi menunggu Owner/Admin` : 'Semua transaksi sudah tertangani';
  el('sync-review-nav-count').textContent = commands.length;
  el('sync-review-nav-count').classList.toggle('hidden', !commands.length);
  el('sync-review-list').innerHTML = commands.map((command) => {
    const deltaClass = command.difference > 0 ? 'negative' : command.difference < 0 ? 'positive' : '';
    const lines = command.lines.map((line) => `<tr><td><strong>${escapeHtml(line.productName ?? 'Produk')}</strong><br><small>${Number(line.qty).toLocaleString('id-ID')} ${escapeHtml(line.unitName ?? '')} · ${Number(line.baseQty).toLocaleString('id-ID')} pcs</small></td><td>${money.format(line.gross)}</td><td>${money.format(line.discount)}</td><td><strong>${money.format(line.total)}</strong></td></tr>`).join('');
    return `<article class="sync-review-card" data-command-id="${escapeHtml(command.id)}"><div class="sync-review-card-head"><div><div class="sync-review-title"><span class="status-badge submitted">PERLU KEPUTUSAN</span><strong>${new Date(command.occurredAt).toLocaleString('id-ID')}</strong></div><p>${escapeHtml(command.outletName)} · ${escapeHtml(command.cashierName)} · ${escapeHtml(command.device?.name ?? 'Perangkat POS')}</p><small>${escapeHtml(command.paymentMethod)} · tersimpan offline ${syncAge(command.occurredAt)} lalu</small></div><div class="sync-review-delta ${deltaClass}"><span>Perubahan total</span><strong>${command.difference > 0 ? '+' : ''}${money.format(command.difference)}</strong></div></div><div class="sync-total-compare"><div><span>TOTAL PADA KASIR</span><strong>${money.format(command.expectedTotal)}</strong><small>Nominal yang kemungkinan sudah dibayar</small></div><div class="sync-arrow">→</div><div><span>HARGA TERBARU SERVER</span><strong>${money.format(command.serverTotal)}</strong><small>Hasil harga dan promo saat sinkron</small></div></div><div class="table-wrap"><table class="sync-lines"><thead><tr><th>Barang</th><th>Bruto</th><th>Promo</th><th>Total terbaru</th></tr></thead><tbody>${lines || '<tr><td colspan="4">Rincian barang tidak tersedia.</td></tr>'}</tbody></table></div>${command.error ? `<p class="sync-error">Percobaan terakhir: ${escapeHtml(command.error)}</p>` : ''}<div class="sync-review-actions"><button class="button primary sync-decision" data-action="honor-offline" ${command.canHonorOffline ? '' : 'disabled'}>Pertahankan total kasir</button><button class="button secondary sync-decision" data-action="apply-server">Gunakan harga terbaru</button><button class="button danger sync-decision" data-action="reject">Tolak transaksi</button>${command.canHonorOffline ? '' : '<small>Transaksi lama ini belum memiliki snapshot harga kasir.</small>'}</div></article>`;
  }).join('') || '<div class="empty-state compact"><strong>Tidak ada konflik harga.</strong><br><small>Transaksi offline yang aman akan masuk otomatis tanpa keputusan manual.</small></div>';
}

async function loadSyncReview() {
  el('sync-review-status').textContent = 'Memuat antrean...';
  try {
    const data = await request('/api/sync/review');
    state.syncReview = data.commands ?? [];
    renderSyncReview();
  } catch (error) {
    el('sync-review-status').textContent = `Antrean gagal dimuat: ${error.message}`;
  }
}

async function decideSyncCommand(commandId, action) {
  const command = state.syncReview.find((item) => item.id === commandId);
  if (!command) return;
  const messages = {
    'honor-offline': `Catat transaksi sebesar ${money.format(command.expectedTotal)} sesuai total di kasir?`,
    'apply-server': `Gunakan harga terbaru ${money.format(command.serverTotal)}? Pastikan selisih kas sudah dipahami.`,
    reject: 'Tolak transaksi ini? Stok dan penjualan tidak akan dicatat.'
  };
  if (!window.confirm(messages[action])) return;
  const buttons = [...document.querySelectorAll(`[data-command-id="${commandId}"] .sync-decision`)];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await request(`/api/sync/commands/${commandId}/${action}`, { method: 'POST', body: '{}' });
    if (result.status === 'NEEDS_REVIEW') toast(`Belum dapat diproses: ${result.error}`);
    else toast(action === 'reject' ? 'Transaksi ditolak dan dicatat di audit' : 'Transaksi disetujui dan stok diperbarui');
    await loadSyncReview();
    if (state.session.permissions.includes('report.view')) await loadReport();
  } catch (error) {
    toast(error.message);
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function queueSale(payload) {
  await enqueueCommand(payload);
  await updateQueueCount();
}

async function updateQueueCount() {
  const queue = await listCommands();
  el('queue-count').textContent = queue.length;
  el('sync-button').title = `${queue.filter((item) => item.status === 'NEEDS_REVIEW').length} perlu ditinjau`;
}

async function syncQueue() {
  if (!navigator.onLine) return toast('Masih offline. Transaksi tetap aman di perangkat.');
  const queue = (await listCommands()).filter((command) => command.actorId === state.session.user.id && ['PENDING','FAILED','NEEDS_REVIEW'].includes(command.status)).slice(0, 20);
  if (!queue.length) {
    const review = (await listCommands()).filter((command) => command.status === 'NEEDS_REVIEW').length;
    return toast(review ? `${review} transaksi menunggu tinjauan owner` : 'Tidak ada transaksi yang perlu disinkronkan');
  }
  try {
    const data = await request('/api/sync/sales', { method: 'POST', body: JSON.stringify({
      device: { ...posDevice, outletId: state.activeOutletId },
      commands: queue.map(({ key, occurredAt, expectedTotal, payload }) => ({ key, occurredAt, expectedTotal, payload }))
    }) });
    for (const result of data.results) {
      if (['APPLIED','REJECTED'].includes(result.status)) await removeCommand(result.key);
      else await updateCommand(result.key, { status: result.status, attempts: (queue.find((item) => item.key === result.key)?.attempts ?? 0) + 1, error: result.error ?? null, result: result.result ?? null });
    }
    await updateQueueCount();
    const remaining = await listCommands();
    const review = remaining.filter((item) => item.status === 'NEEDS_REVIEW').length;
    const failed = remaining.filter((item) => item.status === 'FAILED').length;
    toast(review ? `${review} transaksi perlu ditinjau karena harga berubah` : failed ? `${failed} transaksi belum berhasil disinkronkan` : 'Semua transaksi sudah sinkron');
    if (!remaining.length) await refreshCatalog();
  } catch (error) { toast(`Sinkronisasi tertunda: ${error.message}`); }
}

function localHeldSales(){
  try{return JSON.parse(localStorage.getItem('pos_held_sales')??'[]');}catch{return [];}
}

function saveLocalHeldSales(rows){localStorage.setItem('pos_held_sales',JSON.stringify(rows));}

async function loadHeldSales(){
  const local=localHeldSales().filter((hold)=>hold.userId===state.session.user.id&&hold.outletId===state.activeOutletId);
  let cloud=[];
  if(navigator.onLine)try{cloud=(await request('/api/held-sales')).holds??[];}catch{}
  state.heldSales=[...local,...cloud].sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  el('held-sales-count').textContent=state.heldSales.length;
  el('held-sales-list').innerHTML=state.heldSales.length?state.heldSales.map((hold)=>`<div class="held-sale-row" data-hold-id="${hold.id}" data-local="${Boolean(hold.local)}"><div><strong>${escapeHtml(hold.label)}</strong><small>${new Date(hold.createdAt).toLocaleString('id-ID')} · ${(hold.cart??[]).length} jenis barang</small></div><strong>${money.format(hold.quote?.grandTotal??0)}</strong><div><button class="button primary resume-held-sale" type="button">Lanjutkan</button><button class="button secondary cancel-held-sale" type="button">Batalkan</button></div></div>`).join(''):'<div class="empty-state compact">Belum ada transaksi ditahan.</div>';
}

async function holdCurrentCart(){
  if(!state.cart.length)return;
  if(state.saleAuthorization)return toast('Batalkan diskon manual sebelum menahan transaksi.');
  if(state.voucherCode)return toast('Hapus voucher sebelum menahan transaksi agar kuotanya tidak terkunci semu.');
  const label=window.prompt('Beri nama transaksi agar mudah ditemukan:',`Pelanggan ${new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}`);
  if(label===null)return;
  const payload={label:label.trim()||'Tanpa nama',lines:structuredClone(state.cart),customerId:el('customer-select').value||null,customerGroupId:el('customer-group').value,notes:el('sale-note').value.trim()};
  try{
    if(navigator.onLine)await request('/api/held-sales',{method:'POST',body:JSON.stringify(payload)});
    else{
      const rows=localHeldSales();rows.push({id:crypto.randomUUID(),local:true,userId:state.session.user.id,outletId:state.activeOutletId,label:payload.label,cart:payload.lines,quote:structuredClone(state.quote),customerId:payload.customerId,customerGroupId:payload.customerGroupId,notes:payload.notes,createdAt:new Date().toISOString()});saveLocalHeldSales(rows);
    }
    state.cart=[];resetPosCustomer();el('sale-note').value='';invalidateSaleAuthorization();await updateQuote();await loadHeldSales();toast('Transaksi ditahan. Stok belum berkurang.');
  }catch(error){toast(error.message);}
}

async function actOnHeldSale(holdId,action,isLocal){
  const hold=state.heldSales.find((item)=>item.id===holdId);if(!hold)return;
  if(action==='cancel'&&!window.confirm(`Batalkan transaksi ditahan “${hold.label}”?`))return;
  if(action==='resume'&&state.cart.length&&!window.confirm('Keranjang saat ini akan diganti dengan transaksi yang ditahan. Lanjutkan?'))return;
  try{
    let result;
    if(isLocal){
      const rows=localHeldSales();saveLocalHeldSales(rows.filter((item)=>item.id!==holdId));
      result={cart:hold.cart,customerId:hold.customerId,customerGroupId:hold.customerGroupId,notes:hold.notes??''};
    }else result=await request(`/api/held-sales/${holdId}/${action}`,{method:'POST',body:'{}'});
    if(action==='resume'){
      resetPosCustomer();
      if(result.customerId&&state.customers.some((customer)=>customer.id===result.customerId))el('customer-select').value=result.customerId;
      invalidateSaleAuthorization();el('customer-group').value=result.customerGroupId??'retail';el('sale-note').value=result.notes??'';state.cart=structuredClone(result.cart??[]);await updateQuote();
      syncCustomerSearchLabel();
      el('held-sales-dialog').close();toast('Transaksi dilanjutkan.');
    }else toast('Transaksi ditahan dibatalkan.');
    await loadHeldSales();
  }catch(error){toast(error.message);}
}

function paymentMethodOptions(selected){
  const customer=state.customers.find((item)=>item.id===el('customer-select').value);
  const methods=[['CASH','Tunai'],['QRIS','QRIS'],['TRANSFER','Transfer'],['EDC','Kartu / EDC']];
  if(customer?.credit_enabled&&Number(customer.available_credit)>0)methods.push(['CREDIT',`Piutang · tersedia ${money.format(customer.available_credit)}`]);
  return methods.map(([value,label])=>`<option value="${value}" ${selected===value?'selected':''}>${label}</option>`).join('');
}

function paymentTotals(){
  const allocated=state.paymentDraft.reduce((sum,payment)=>sum+Number(payment.amount||0),0);
  const remaining=Math.max(0,Number(state.quote?.grandTotal??0)-allocated);
  const change=state.paymentDraft.filter((payment)=>payment.method==='CASH').reduce((sum,payment)=>sum+Math.max(0,Number(payment.tendered||0)-Number(payment.amount||0)),0);
  return {allocated,remaining,change};
}

function updatePaymentSummary(){
  const totals=paymentTotals();el('payment-allocated').textContent=money.format(totals.allocated);el('payment-remaining').textContent=money.format(totals.remaining);el('payment-change').textContent=money.format(totals.change);
  el('confirm-payment').disabled=totals.remaining>0.01||Math.abs(totals.allocated-state.quote.grandTotal)>0.01||state.paymentDraft.some((payment)=>payment.method==='CASH'&&Number(payment.tendered)<Number(payment.amount));
}

function activeCashPayment() {
  if (state.paymentDraft[state.paymentKeypadIndex]?.method === 'CASH') {
    return { payment: state.paymentDraft[state.paymentKeypadIndex], index: state.paymentKeypadIndex };
  }
  const index = state.paymentDraft.findIndex((payment) => payment.method === 'CASH');
  if (index < 0) return null;
  state.paymentKeypadIndex = index;
  return { payment: state.paymentDraft[index], index };
}

function renderCashKeypad() {
  const active = activeCashPayment();
  el('cash-keypad').classList.toggle('hidden', !active);
  if (!active) return;
  el('cash-keypad-value').textContent = money.format(active.payment.tendered ?? 0);
  el('cash-suggestions').innerHTML = suggestedCashAmounts(active.payment.amount).map((amount, index) =>
    `<button type="button" data-cash-amount="${amount}" class="${index === 0 ? 'exact' : ''}">${index === 0 ? 'Uang pas' : money.format(amount)}</button>`
  ).join('');
}

function setCashTendered(value, { fresh = false } = {}) {
  const active = activeCashPayment();
  if (!active) return;
  active.payment.tendered = Math.max(0, Number(value) || 0);
  state.paymentKeypadFresh = fresh;
  const input = document.querySelector(`.payment-line[data-index="${active.index}"] .payment-line-tendered`);
  if (input) input.value = active.payment.tendered;
  el('cash-keypad-value').textContent = money.format(active.payment.tendered);
  updatePaymentSummary();
}

function renderPaymentLines(){
  el('payment-lines').innerHTML=state.paymentDraft.map((payment,index)=>`<div class="payment-line" data-index="${index}"><label>Metode<select class="payment-line-method">${paymentMethodOptions(payment.method)}</select></label><label>Jumlah<input class="payment-line-amount" type="number" min="1" value="${payment.amount||''}" required></label><label class="payment-tendered ${payment.method==='CASH'?'':'hidden'}">Uang diterima<input class="payment-line-tendered" type="number" min="0" value="${payment.tendered??payment.amount??''}"></label><label class="payment-reference ${payment.method==='CASH'?'hidden':''}">Referensi (opsional)<input class="payment-line-reference" value="${escapeHtml(payment.reference??'')}" placeholder="Nomor QRIS/transfer"></label><button class="icon-button remove-payment-line" type="button" ${state.paymentDraft.length===1?'disabled':''}>×</button></div>`).join('');
  updatePaymentSummary();
  renderCashKeypad();
  el('add-payment-line').classList.toggle('hidden',el('payment-mode').value!=='SPLIT'||state.paymentDraft.length>=4);
}

function openPaymentDialog(){
  state.paymentDraft=[{method:'CASH',amount:state.quote.grandTotal,tendered:state.quote.grandTotal,reference:''}];
  state.paymentKeypadIndex=0;state.paymentKeypadFresh=true;
  el('payment-mode').value='SINGLE';el('payment-total').textContent=money.format(state.quote.grandTotal);el('payment-error').textContent='';
  renderPaymentLines();el('payment-dialog').showModal();
}

function bindReceiptImageFallbacks(root=document) {
  root.querySelectorAll('.receipt-logo').forEach((image)=>image.addEventListener('error',()=>image.remove(),{once:true}));
}

function renderReceiptVoucherQrs(root=document){
  const Writer=window.ZXingBrowser?.BrowserQRCodeSvgWriter;
  if(!Writer)return;
  const writer=new Writer();
  root.querySelectorAll('.receipt-voucher-qr[data-code]').forEach((container)=>{
    container.replaceChildren(writer.write(container.dataset.code,128,128));
  });
}

function saleReturnLabel(sale){
  if(sale?.returnStatus==='FULLY_RETURNED')return 'DIRETUR PENUH';
  if(sale?.returnStatus==='PARTIALLY_RETURNED')return 'DIRETUR SEBAGIAN';
  return '';
}

function buildReceiptMarkup(receipt,payments=[],options={}){
  const customer=receipt.customer??state.customers.find((item)=>item.id===el('customer-select')?.value);
  const business=options.business??receipt.business??state.business;
  const outlet=options.outlet??receipt.outlet??state.outlets.find((item)=>item.id===state.activeOutletId)??{};
  const layout={...defaultReceiptLayout,...(business.receiptLayout??{})};
  const groupId=receipt.customerGroupId??customer?.group_id??'retail';
  const priceLabel=groupId==='retail'?'':`Harga ${customerGroupName(groupId)}`;
  const address=outlet.address||business.address,phone=outlet.phone||business.phone;
  const footer=outlet.receipt_footer||business.receiptFooter||'Terima kasih telah berbelanja.';
  const customerView=customerReceiptView(receipt.quote),receiptDiscount=Number(customerView.discountTotal),change=Number(receipt.change??0);
  const returnLabel=saleReturnLabel(receipt),returnTotal=Number(receipt.returnTotal??0);
  const netTotal=Math.max(0,Number(receipt.netTotal??customerView.grandTotal-returnTotal));
  const classes=['receipt-copy',`receipt-header-${layout.headerAlignment}`,`receipt-footer-${layout.footerAlignment}`,`receipt-title-${layout.titleSize}`,`receipt-density-${layout.density}`,`receipt-separator-${layout.separator}`].join(' ');
  const logo=layout.showLogo&&business.logoUrl?`<img class="receipt-logo" src="${escapeHtml(business.logoUrl)}" alt="Logo ${escapeHtml(business.name??'usaha')}" style="width:${layout.logoSize}px">`:'';
  const meta=`${layout.showCashier?`<span>Kasir</span><strong>${escapeHtml(receipt.cashier??'-')}</strong>`:''}${layout.showCustomer&&customer?`<span>Pelanggan</span><strong>${escapeHtml(customer.name)}</strong>`:''}`;
  const paymentRows=layout.showPaymentDetail?payments.map((payment)=>`<div><span>${escapeHtml(payment.method)}${payment.method==='CASH'&&payment.tendered?` · diterima ${money.format(payment.tendered)}`:''}</span><strong>${money.format(payment.amount)}</strong></div>`).join(''):'';
  const pointsEarned=Number(receipt.pointsEarned??0),pointsBalance=receipt.pointsBalance==null?null:Number(receipt.pointsBalance);
  const loyaltyBlock=layout.showLoyaltyPoints&&customer&&pointsBalance!=null
    ? `<div class="receipt-loyalty"><div><span>Poin bertambah</span><strong>${receipt.sourceSystem==='KASPIN'&&receipt.pointsBalanceIsCurrent?'Tidak tersedia':`+${pointsEarned.toLocaleString('id-ID')}`}</strong></div><div><span>${receipt.pointsBalanceIsCurrent?(receipt.sourceSystem==='KASPIN'?'Saldo poin impor saat ini':'Saldo poin saat ini'):'Saldo poin setelah transaksi'}</span><strong>${pointsBalance.toLocaleString('id-ID')}</strong></div>${receipt.tierName?`<small>${escapeHtml(receipt.tierName)}</small>`:''}</div>`
    :'';
  const voucher=receipt.issuedVoucher;
  const voucherBlock=voucher?`<div class="receipt-issued-voucher"><strong>VOUCHER BELANJA BERIKUTNYA</strong><span>${voucher.discountType==='PERCENT'?`Diskon ${Number(voucher.discountValue)}%`:`Potongan ${money.format(voucher.discountValue)}`}</span><div class="receipt-voucher-qr" data-code="${escapeHtml(voucher.code)}"></div><b>${escapeHtml(voucher.code)}</b><small>Min. belanja ${money.format(voucher.minPurchase)} · berlaku ${new Date(voucher.startsAt).toLocaleDateString('id-ID')}–${new Date(voucher.endsAt).toLocaleDateString('id-ID')}</small><small>Scan saat transaksi berikutnya · hanya 1 kali pakai</small></div>`:'';
  return `<section class="${classes}"><div class="receipt-head">${logo}${layout.showBusinessName?`<strong>${escapeHtml(business.name??'Kasir Nusa')}</strong>`:''}${layout.showOutletName?`<span>${escapeHtml(receipt.outletName??outlet.name??'Outlet')}</span>`:''}${layout.customHeader?`<small class="receipt-custom-header">${escapeHtml(layout.customHeader)}</small>`:''}${layout.showAddress&&address?`<small>${escapeHtml(address)}</small>`:''}${layout.showPhone&&phone?`<small>${escapeHtml(layout.contactLabel||'Tel.')} ${escapeHtml(phone)}</small>`:''}${layout.showDate?`<small>${new Date(receipt.occurredAt).toLocaleString('id-ID')}</small>`:''}${layout.showReceiptNumber?`<b>${escapeHtml(receipt.receiptNo)}</b>`:''}${receipt.status==='VOIDED'?'<b>VOID / DIBATALKAN</b>':''}${returnLabel?`<b class="receipt-return-status">${returnLabel}</b>`:''}</div><div class="receipt-meta">${meta}</div><div class="receipt-lines">${customerView.lines.map((line)=>`<div class="${Number(line.returnedQty)>0?'receipt-line-returned':''}"><span><strong>${escapeHtml(line.productName)}</strong>${layout.showPriceType&&priceLabel?`<small>${escapeHtml(priceLabel)}</small>`:''}<small>${line.qty} ${escapeHtml(line.unitName)} × ${money.format(line.customerUnitPrice)}</small>${Number(line.returnedQty)>0?`<small class="receipt-returned-note">Diretur ${Number(line.returnedQty).toLocaleString('id-ID')} ${escapeHtml(line.unitName)} · ${money.format(line.returnedTotal)}</small>`:''}</span><strong>${money.format(line.total)}</strong></div>`).join('')}</div><div class="receipt-totals"><div><span>Subtotal</span><strong>${money.format(customerView.subtotal)}</strong></div>${Math.abs(receiptDiscount)>0.01?`<div><span>Promo & diskon</span><strong>${receiptDiscount<0?'+':'−'}${money.format(Math.abs(receiptDiscount))}</strong></div>`:''}<div class="${returnTotal?'':'receipt-grand'}"><span>${returnTotal?'Total awal':'Total'}</span><strong>${money.format(customerView.grandTotal)}</strong></div>${returnTotal?`<div class="receipt-return-deduction"><span>Retur / refund</span><strong>−${money.format(returnTotal)}</strong></div><div class="receipt-grand"><span>Total setelah retur</span><strong>${money.format(netTotal)}</strong></div>`:''}${paymentRows}${layout.showPaymentDetail&&change?`<div><span>Kembalian</span><strong>${money.format(change)}</strong></div>`:''}</div>${returnTotal?`<div class="receipt-return-summary"><strong>${returnLabel}</strong>${(receipt.returns??[]).map((returned)=>`<small>${escapeHtml(returned.returnNo)} · ${new Date(returned.occurredAt).toLocaleString('id-ID')} · ${escapeHtml(returned.reason??'Retur')}</small>`).join('')}</div>`:''}${layout.showTransactionNote&&receipt.notes?`<p class="receipt-thanks"><strong>Catatan:</strong> ${escapeHtml(receipt.notes)}</p>`:''}${loyaltyBlock}${voucherBlock}${layout.customFooter?`<p class="receipt-thanks receipt-custom-footer">${escapeHtml(layout.customFooter)}</p>`:''}<p class="receipt-thanks">${escapeHtml(footer)}</p>${options.copyLabel?`<small class="receipt-copy-label">${escapeHtml(options.copyLabel)}</small>`:''}</section>`;
}

function renderReceipt(receipt,payments,{allowAutoPrint=true,closeLabel='Transaksi baru'}={}){
  const copies=Math.max(1,Math.min(3,Number(state.deviceSettings.receiptCopies??1)));
  el('receipt-content').innerHTML=Array.from({length:copies},(_,index)=>buildReceiptMarkup(receipt,payments,{copyLabel:copies>1?`Salinan ${index+1} dari ${copies}`:''})).join('');
  bindReceiptImageFallbacks(el('receipt-content'));
  renderReceiptVoucherQrs(el('receipt-content'));
  const width=Number(state.deviceSettings.paperWidth??80)===58?58:80;
  el('receipt-dialog').classList.toggle('paper-58',width===58);
  let printStyle=el('receipt-print-page-style');
  if(!printStyle){printStyle=document.createElement('style');printStyle.id='receipt-print-page-style';document.head.append(printStyle);}
  printStyle.textContent=`@media print{@page{size:${width}mm auto;margin:2mm}}`;
  const customer=receipt.customer??state.customers.find((item)=>item.id===el('customer-select').value);
  el('whatsapp-receipt').classList.toggle('hidden',!(customer?.phone&&customer?.whatsapp_consent));
  el('close-receipt').textContent=closeLabel;
  el('receipt-dialog').showModal();
  if(allowAutoPrint&&state.deviceSettings.autoPrint)setTimeout(()=>printReceiptDirect(receipt,payments,{automatic:true}),250);
}

function historyReceiptShareText(sale){
  const lines=(sale.quote?.lines??[]).map((line)=>`${line.qty} ${line.unitName} ${line.productName}: ${money.format(line.total)}${Number(line.returnedQty)>0?`\n  Diretur ${Number(line.returnedQty).toLocaleString('id-ID')} ${line.unitName}: -${money.format(line.returnedTotal)}`:''}`).join('\n');
  const returnSummary=Number(sale.returnTotal)>0?`\n${saleReturnLabel(sale)}\nRefund: -${money.format(sale.returnTotal)}\nTotal setelah retur: ${money.format(sale.netTotal)}`:'';
  return `${state.business.name??'Kasir Nusa POS'}\nStruk ${sale.receiptNo}\n${new Date(sale.occurredAt).toLocaleString('id-ID')}\n\n${lines}\n\nTotal awal: ${money.format(sale.quote?.grandTotal??0)}${returnSummary}\nTerima kasih.`;
}

function openHistoryReceiptPage(sale){
  if(!sale)return;
  state.historyReceiptSale=sale;state.lastReceipt=sale;
  el('history-receipt-number').textContent=sale.receiptNo;
  el('history-receipt-content').innerHTML=buildReceiptMarkup(sale,sale.payments??[]);
  bindReceiptImageFallbacks(el('history-receipt-content'));renderReceiptVoucherQrs(el('history-receipt-content'));
  el('history-receipt-details').innerHTML=`<p class="eyebrow">RINCIAN TRANSAKSI</p><h2>${escapeHtml(sale.receiptNo)}</h2><div><span>Status</span><strong>${sale.status==='VOIDED'?'Dibatalkan':saleReturnLabel(sale)||'Selesai'}</strong></div><div><span>Waktu</span><strong>${new Date(sale.occurredAt).toLocaleString('id-ID')}</strong></div><div><span>Outlet</span><strong>${escapeHtml(sale.outletName??'Outlet')}</strong></div><div><span>Kasir</span><strong>${escapeHtml(sale.cashier??'-')}</strong></div><div><span>Pelanggan</span><strong>${escapeHtml(sale.customer?.name??'Pelanggan umum')}</strong></div><div><span>Pembayaran</span><strong>${(sale.payments??[]).map((payment)=>escapeHtml(payment.method)).join(' + ')||'-'}</strong></div>${Number(sale.returnTotal)>0?`<div><span>Total refund</span><strong>${money.format(sale.returnTotal)}</strong></div><div><span>Total setelah retur</span><strong>${money.format(sale.netTotal)}</strong></div>`:''}${sale.notes?`<div><span>Catatan</span><strong>${escapeHtml(sale.notes)}</strong></div>`:''}${sale.voidReason?`<div><span>Alasan pembatalan</span><strong>${escapeHtml(sale.voidReason)}</strong></div>`:''}`;
  el('history-receipt-details').classList.add('hidden');
  closeHistoryReceiptMenu();
  el('report-sale-receipt-page').classList.remove('hidden');el('page-reports').classList.add('receipt-page-open');
  document.body.classList.add('history-receipt-open');
  scrollTo({top:0,behavior:'auto'});
}

function closeHistoryReceiptPage(){
  el('page-reports').classList.remove('receipt-page-open');el('report-sale-receipt-page').classList.add('hidden');
  document.body.classList.remove('history-receipt-open');closeHistoryReceiptMenu();state.historyReceiptSale=null;
}

function closeHistoryReceiptMenu(){
  el('history-receipt-menu').classList.add('hidden');el('history-receipt-menu-backdrop').classList.add('hidden');
  el('history-receipt-menu-toggle').setAttribute('aria-expanded','false');
}

function toggleHistoryReceiptMenu(){
  const opening=el('history-receipt-menu').classList.contains('hidden');
  el('history-receipt-menu').classList.toggle('hidden',!opening);el('history-receipt-menu-backdrop').classList.toggle('hidden',!opening);
  el('history-receipt-menu-toggle').setAttribute('aria-expanded',String(opening));
}

async function printHistoryReceipt(sale){
  if(supportsBluetoothClassicPrinting())return printReceiptDirect(sale,sale.payments??[]);
  document.body.classList.add('history-receipt-print');window.print();
}

async function shareHistoryReceipt(sale){
  const text=historyReceiptShareText(sale);
  try{
    if(navigator.share){await navigator.share({title:`Struk ${sale.receiptNo}`,text});return;}
    await navigator.clipboard.writeText(text);toast('Rincian struk disalin dan siap dibagikan.');
  }catch(error){if(error.name!=='AbortError')toast('Struk belum dapat dibagikan dari perangkat ini.');}
}

async function handleHistoryReceiptAction(action){
  const sale=state.historyReceiptSale;if(!sale)return;
  closeHistoryReceiptMenu();
  if(action==='details'){el('history-receipt-details').classList.toggle('hidden');return;}
  if(action==='print'){await printHistoryReceipt(sale);return;}
  if(action==='share'){await shareHistoryReceipt(sale);return;}
  if(action==='return'){
    if(sale.status==='VOIDED')return toast('Transaksi yang sudah dibatalkan tidak dapat diretur.');
    closeHistoryReceiptPage();showPage('returns');el('return-receipt-search').value=sale.receiptNo;await findReturnSale();return;
  }
  if(action==='void'){
    if(sale.status==='VOIDED')return toast('Transaksi ini sudah dibatalkan.');
    closeHistoryReceiptPage();openVoidSale(sale);return;
  }
  if(action==='edit')return toast('Transaksi selesai tidak dapat diedit langsung. Batalkan lalu buat transaksi pengganti, atau gunakan retur.');
  if(action==='delete')return toast('Transaksi selesai tidak boleh dihapus permanen. Gunakan Batalkan transaksi agar audit, stok, dan laporan tetap benar.');
}

function shareReceiptWhatsApp(){
  const receipt=state.lastReceipt,customer=receipt?.customer;
  if(!receipt||!customer?.phone||!customer.whatsapp_consent)return toast('Pelanggan belum memberi izin WhatsApp.');
  const groupId=receipt.customerGroupId??customer.group_id??'retail',priceLabel=groupId==='retail'?'':` [Harga ${customerGroupName(groupId)}]`;
  const lines=(receipt.quote?.lines??[]).map((line)=>`${line.qty} ${line.unitName} ${line.productName}${priceLabel}: ${money.format(line.total)}`).join('\n');
  const text=`${receipt.business?.name??state.business.name}\nStruk ${receipt.receiptNo}\n${lines}\nTotal: ${money.format(receipt.quote?.grandTotal??0)}\nTerima kasih.`;
  let digits=String(customer.phone).replace(/\D/g,'');if(digits.startsWith('0'))digits=`62${digits.slice(1)}`;
  window.open(`https://wa.me/${digits}?text=${encodeURIComponent(text)}`,'_blank','noopener,noreferrer');
}

async function completePayment(event) {
  event.preventDefault();
  if (!state.currentShift?.id) return toast('Shift aktif belum siap. Muat ulang kasir lalu coba lagi.');
  const totals=paymentTotals();
  if(Math.abs(totals.allocated-state.quote.grandTotal)>0.01)return el('payment-error').textContent='Total pembayaran harus sama dengan total transaksi.';
  if(!navigator.onLine&&state.saleAuthorization)return el('payment-error').textContent='Diskon berizin hanya dapat diselesaikan saat online. Sambungkan internet atau batalkan diskon manual.';
  if(!navigator.onLine&&state.voucherCode)return el('payment-error').textContent='Voucher memerlukan koneksi internet untuk memeriksa kuota.';
  if(!navigator.onLine&&state.paymentDraft.some((payment)=>payment.method==='CREDIT'))return el('payment-error').textContent='Penjualan kredit memerlukan koneksi internet untuk memeriksa plafon pelanggan.';
  if(!navigator.onLine&&state.paymentDraft.length>1)return el('payment-error').textContent='Pembayaran gabungan memerlukan koneksi internet.';
  const sale = {
    key: crypto.randomUUID(), actorId: state.session.user.id, occurredAt: new Date().toISOString(), expectedTotal: state.quote.grandTotal,
    payload: { lines: structuredClone(state.cart), offlineQuote: structuredClone(state.quote), customerId: el('customer-select').value || null, customerGroupId: el('customer-group').value, voucherCode:state.voucherCode||null, notes:el('sale-note').value.trim(), payments:structuredClone(state.paymentDraft),paymentMethod:({CASH:'Tunai',QRIS:'QRIS',TRANSFER:'Transfer',EDC:'EDC',CREDIT:'Piutang'})[state.paymentDraft[0].method], shiftId: state.currentShift.id, ...(state.saleAuthorization?{authorization:structuredClone(state.saleAuthorization)}:{}) }
  };
  let refreshAfterPayment = false;
  if (!navigator.onLine) {
    await queueSale(sale); toast('Transaksi disimpan offline dan akan disinkronkan.');
  } else {
    try {
      const receipt = await request('/api/sales', { method: 'POST', headers: { 'idempotency-key': sale.key }, body: JSON.stringify(sale.payload) });
      toast(`Transaksi ${receipt.receiptNo} berhasil`);state.lastReceipt={...receipt,payments:structuredClone(state.paymentDraft),customer:selectedPosCustomer()};
      renderReceipt(state.lastReceipt,state.paymentDraft);
      refreshAfterPayment = true;
    } catch (error) {
      if (error.status) return toast(error.message);
      if (state.saleAuthorization) return toast('Transaksi dengan diskon berizin harus diselesaikan saat online. Coba lagi tanpa mengubah keranjang.');
      await queueSale(sale); toast('Jaringan bermasalah. Transaksi diamankan di antrean.');
    }
  }
  state.cart = []; resetPosCustomer();el('sale-note').value='';invalidateSaleAuthorization(); await updateQuote(); el('payment-dialog').close();
  if (refreshAfterPayment) {
    await refreshCatalog();
    if (state.session.permissions.includes('inventory.manage')) await loadInventory();
    if (state.session.permissions.includes('report.view')) await loadReport();
  }
}

async function loadPosSales(query='',{reportScope=false}={}) {
  if(!navigator.onLine)return;
  try{
    const params=new URLSearchParams();
    if(query)params.set('q',query);
    if(reportScope){
      params.set('scope','report');
      params.set('from',el('report-from').value);
      params.set('to',el('report-to').value);
      if(el('report-outlet').value)params.set('outletId',el('report-outlet').value);
    }
    const data=await request(`/api/pos-sales${params.size?`?${params}`:''}`);
    state.posSales=data.sales??[];
    if(state.selectedPosSaleId&&!state.posSales.some((sale)=>sale.id===state.selectedPosSaleId))state.selectedPosSaleId=null;
    renderPosSales();
  }catch(error){
    el('pos-history-list').innerHTML=`<div class="empty-state compact">${escapeHtml(error.message)}</div>`;
  }
}

function purchaseReportRange(period=state.purchaseReportPeriod){
  const today=storeDateToday();
  if(period==='MONTH')return{from:`${today.slice(0,7)}-01`,to:today,title:'Bulan ini'};
  if(period==='YEAR')return{from:`${today.slice(0,4)}-01-01`,to:today,title:'Tahun ini'};
  if(period==='ALL')return{from:'2000-01-01',to:today,title:'Selama ini'};
  return{from:today,to:today,title:'Hari ini'};
}

function renderPurchaseReportReceipts(){
  const query=el('purchase-report-search').value.trim().toLowerCase();
  const receipts=(state.purchaseReportReceipts??[]).filter((receipt)=>!query||`${receipt.documentNo} ${receipt.supplierName} ${receipt.outletName} ${receipt.receiver}`.toLowerCase().includes(query));
  const metrics=(state.purchaseReportReceipts??[]).reduce((sum,receipt)=>{
    sum.total+=Number(receipt.total);sum.qty+=receipt.lines.reduce((qty,line)=>qty+Number(line.qty),0);sum.suppliers.add(receipt.supplierId??receipt.supplierName);return sum;
  },{total:0,qty:0,suppliers:new Set()});
  el('purchase-report-metrics').innerHTML=`<article><small>Jumlah transaksi</small><strong>${Number(state.purchaseReportReceipts?.length??0).toLocaleString('id-ID')}</strong></article><article><small>Total pembelian</small><strong>${money.format(metrics.total)}</strong></article><article><small>Qty diterima</small><strong>${metrics.qty.toLocaleString('id-ID')} pcs</strong></article><article><small>Supplier</small><strong>${metrics.suppliers.size.toLocaleString('id-ID')}</strong></article>`;
  el('purchase-report-list').innerHTML=receipts.length?receipts.map((receipt)=>`<button class="purchase-report-row" type="button" data-purchase-report-id="${escapeHtml(receipt.id)}"><span><small>Nomor struk</small><strong>${escapeHtml(receipt.documentNo)}</strong><small>${escapeHtml(receipt.supplierName)}</small></span><span><small>Waktu transaksi</small><strong>${new Date(receipt.occurredAt).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}</strong><small>${new Date(receipt.occurredAt).toLocaleDateString('id-ID')}</small></span><span><small>Total pembelian</small><strong>${money.format(receipt.total)}</strong><small>${receipt.lines.length} jenis · ${escapeHtml(receipt.outletName)}</small></span><b>›</b></button>`).join(''):'<div class="empty-state compact">Pembelian tidak ditemukan pada periode ini.</div>';
}

async function loadPurchaseReportReceipts(){
  if(!navigator.onLine)return;
  const range=purchaseReportRange(),params=new URLSearchParams({from:range.from,to:range.to});
  if(el('report-outlet').value)params.set('outletId',el('report-outlet').value);
  el('purchase-report-list').innerHTML='<div class="empty-state compact">Memuat pembelian...</div>';
  try{
    const data=await request(`/api/purchase-receipts/report?${params}`);
    state.purchaseReportReceipts=data.receipts??[];
    renderPurchaseReportReceipts();
  }catch(error){el('purchase-report-list').innerHTML=`<div class="empty-state compact">${escapeHtml(error.message)}</div>`;}
}

function openPurchaseReportReceipt(receipt){
  if(!receipt)return;
  state.activePurchaseReportReceipt=receipt;
  el('purchase-report-number').textContent=receipt.documentNo;
  el('purchase-report-content').innerHTML=`<header><p class="eyebrow">STRUK PEMBELIAN</p><h1>${escapeHtml(state.business.name??'Kasir Nusa POS')}</h1><strong>${escapeHtml(receipt.documentNo)}</strong><small>${new Date(receipt.occurredAt).toLocaleString('id-ID')}</small></header><section class="purchase-original-meta"><div><span>Supplier</span><strong>${escapeHtml(receipt.supplierName)}</strong></div><div><span>Outlet</span><strong>${escapeHtml(receipt.outletName)}</strong></div><div><span>Lokasi penerimaan</span><strong>${escapeHtml(receipt.locationName)}</strong></div><div><span>Diterima oleh</span><strong>${escapeHtml(receipt.receiver)}</strong></div></section><section class="purchase-receipt-lines"><div class="purchase-receipt-line heading"><span>Barang</span><span>Jumlah</span><span>Modal</span><span>Total</span></div>${receipt.lines.map((line)=>`<div class="purchase-receipt-line"><span><strong>${escapeHtml(line.productName)}</strong><small>${escapeHtml(line.sku)}${line.batchNo?` · Batch ${escapeHtml(line.batchNo)}`:''}${line.expiresOn?` · EXP ${new Date(`${line.expiresOn}T00:00:00`).toLocaleDateString('id-ID')}`:''}</small></span><span data-label="Jumlah">${Number(line.qty).toLocaleString('id-ID')} ${escapeHtml(line.unitName)}</span><span data-label="Modal">${money.format(line.unitCost)}</span><strong data-label="Total">${money.format(line.total)}</strong></div>`).join('')}<div class="purchase-receipt-total"><span>TOTAL PEMBELIAN</span><strong>${money.format(receipt.total)}</strong></div></section><footer><small>Dokumen ini merupakan catatan penerimaan barang sesuai data yang tersimpan pada sistem.</small></footer>`;
  el('purchase-report-receipt-page').classList.remove('hidden');
  el('page-reports').classList.add('purchase-receipt-open');
  document.body.classList.add('purchase-receipt-open');
  window.scrollTo({top:0,behavior:'instant'});
}

function closePurchaseReportReceipt(){
  el('purchase-report-receipt-page').classList.add('hidden');
  el('page-reports').classList.remove('purchase-receipt-open');
  document.body.classList.remove('purchase-receipt-open');
  state.activePurchaseReportReceipt=null;
}

function renderPosSales(){
  const visible=filteredPosSales();
  el('pos-history-list').innerHTML=visible.length?visible.map((sale)=>{
    const amounts=saleReportAmounts(sale);
    return `<button class="pos-history-row sales-day-card ${sale.id===state.selectedPosSaleId?'active':''}" type="button" data-pos-sale-id="${sale.id}"><span class="sales-day-identity"><small>Nomor struk</small><strong>${escapeHtml(sale.receiptNo)}</strong><small>${escapeHtml(sale.customer?.name??'Pelanggan umum')} · ${escapeHtml(sale.cashier)}</small></span><span class="sales-day-metric"><small>Waktu transaksi</small><strong>${new Date(sale.occurredAt).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}</strong></span><span class="sales-day-metric"><small>Pendapatan</small><strong>${money.format(amounts.revenue)}</strong></span><span class="sales-day-metric"><small>Keuntungan</small><strong>${money.format(amounts.profit)}</strong></span><span class="${sale.status==='VOIDED'?'void-label':sale.returnStatus!=='NONE'?'return-label':''}">${sale.status==='VOIDED'?'VOID':saleReturnLabel(sale)||'Selesai'}</span></button>`;
  }).join(''):'<div class="empty-state compact">Transaksi tidak ditemukan dengan filter ini.</div>';
  const selected=state.posSales.find((sale)=>sale.id===state.selectedPosSaleId);
  if(selected)renderPosSaleDetail(selected);
  else el('pos-history-detail').innerHTML='<div class="empty-state compact">Pilih transaksi untuk melihat detail.</div>';
}

function renderPosSaleDetail(sale){
  const canVoid=state.session.permissions.includes('sale.void');
  el('pos-history-detail').innerHTML=`<div class="pos-history-detail-head"><div><p class="eyebrow">${sale.status==='VOIDED'?'TRANSAKSI VOID':saleReturnLabel(sale)||'TRANSAKSI SELESAI'}</p><h2>${escapeHtml(sale.receiptNo)}</h2><small>${new Date(sale.occurredAt).toLocaleString('id-ID')} · ${escapeHtml(sale.cashier)}</small></div><strong>${money.format(Number(sale.returnTotal)>0?sale.netTotal:sale.quote.grandTotal)}</strong></div><div class="pos-history-facts"><div><span>Pelanggan</span><strong>${escapeHtml(sale.customer?.name??'Pelanggan umum')}</strong></div><div><span>Pembayaran</span><strong>${sale.payments.map((payment)=>escapeHtml(payment.method)).join(' + ')}</strong></div></div><div class="pos-history-lines">${sale.quote.lines.map((line)=>`<div><span>${escapeHtml(line.productName)}<small> · ${line.qty} ${escapeHtml(line.unitName)}</small>${Number(line.returnedQty)>0?`<small class="returned-line-detail">Diretur ${Number(line.returnedQty).toLocaleString('id-ID')} ${escapeHtml(line.unitName)} · −${money.format(line.returnedTotal)}</small>`:''}</span><strong>${money.format(line.total)}</strong></div>`).join('')}</div>${Number(sale.returnTotal)>0?`<div class="sale-note-display return-summary-display"><strong>${saleReturnLabel(sale)}</strong><br>Refund ${money.format(sale.returnTotal)} · total setelah retur ${money.format(sale.netTotal)}</div>`:''}${sale.notes?`<div class="sale-note-display"><strong>Catatan transaksi</strong><br>${escapeHtml(sale.notes)}</div>`:''}${sale.customer?.notes?`<div class="sale-note-display"><strong>Catatan pelanggan</strong><br>${escapeHtml(sale.customer.notes)}</div>`:''}${sale.status==='VOIDED'?`<div class="sale-note-display"><strong>Alasan void</strong><br>${escapeHtml(sale.voidReason)}</div>`:''}<div class="pos-history-actions"><button class="button primary reprint-pos-sale" type="button">Cetak ulang struk</button>${sale.status==='COMPLETED'&&canVoid?'<button class="button danger open-void-sale" type="button">Void transaksi</button>':''}</div>`;
}

function openVoidSale(sale){
  if(!navigator.onLine)return toast('Void transaksi memerlukan koneksi internet.');
  if(!state.session.permissions.includes('sale.void'))return toast('Akun Anda tidak memiliki hak void transaksi.');
  el('void-sale-id').value=sale.id;
  el('void-sale-title').textContent=`Void ${sale.receiptNo}`;
  el('void-sale-reason').value='';el('void-sale-error').textContent='';
  el('void-sale-dialog').showModal();el('void-sale-reason').focus();
}

async function submitVoidSale(event){
  event.preventDefault();const button=el('confirm-void-sale');button.disabled=true;el('void-sale-error').textContent='';
  try{
    const result=await request(`/api/pos-sales/${el('void-sale-id').value}/void`,{method:'POST',body:JSON.stringify({reason:el('void-sale-reason').value})});
    toast(`${result.receiptNo} berhasil di-void`);el('void-sale-dialog').close();await Promise.all([loadPosSales(el('pos-history-search').value,{reportScope:true}),refreshCatalog(),refreshShift()]);
    if(state.session.permissions.includes('report.view'))await loadReport();
  }catch(error){el('void-sale-error').textContent=error.message;}
  finally{button.disabled=false;}
}

function handlePosShortcut(event){
  if(el('app-view').classList.contains('hidden')||document.querySelector('dialog[open]'))return;
  const editing=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)||document.activeElement?.isContentEditable;
  if(event.key==='/'&&!editing){event.preventDefault();el('product-search').focus();el('product-search').select();return;}
  if(event.key==='F9'&&state.quote&&state.currentShift){event.preventDefault();document.activeElement?.blur();openPaymentDialog();return;}
  if(editing)return;
  if((event.key==='+'||event.key==='=')&&state.cart.length){event.preventDefault();changeQty(state.cart.length-1,1);return;}
  if(event.key==='-'&&state.cart.length){event.preventDefault();changeQty(state.cart.length-1,-1);return;}
  if(event.key.toLowerCase()==='h'&&state.cart.length){event.preventDefault();holdCurrentCart();return;}
  if(event.key.toLowerCase()==='p'&&state.lastReceipt){event.preventDefault();renderReceipt(state.lastReceipt,state.lastReceipt.payments??state.paymentDraft,{allowAutoPrint:false,closeLabel:'Tutup'});setTimeout(()=>printReceiptDirect(state.lastReceipt,state.lastReceipt.payments??state.paymentDraft),250);return;}
}

const mobileSidebarMedia = window.matchMedia('(max-width: 760px)');

function setMobilePosView(view, { focus = true } = {}) {
  const layout = document.querySelector('.pos-layout');
  const showCart = mobileSidebarMedia.matches && view === 'cart';
  layout.classList.toggle('mobile-cart-view', showCart);
  el('mobile-cart-jump').setAttribute('aria-expanded', String(showCart));
  if (!focus || !mobileSidebarMedia.matches) return;
  window.scrollTo({ top:0 });
  requestAnimationFrame(() => (showCart ? el('mobile-cart-back') : el('product-search')).focus());
}

function setSidebarOpen(requestedOpen, { restoreFocus = false } = {}) {
  const app = el('app-view');
  const sidebar = el('app-sidebar');
  const toggle = el('sidebar-toggle');
  const mobile = mobileSidebarMedia.matches;
  const open = mobile && requestedOpen;
  app.classList.toggle('sidebar-open', open);
  document.body.classList.toggle('sidebar-drawer-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Tutup menu' : 'Buka menu');
  sidebar.setAttribute('aria-hidden', String(mobile && !open));
  sidebar.inert = mobile && !open;
  if (open) requestAnimationFrame(() => sidebar.querySelector('.nav-item.active:not(.hidden), .nav-item:not(.hidden)')?.focus());
  else if (restoreFocus && mobile) toggle.focus();
}

function syncSidebarMode() {
  setSidebarOpen(false);
  if (!mobileSidebarMedia.matches) setMobilePosView('catalog', { focus:false });
  openNavGroup(state.activeNavGroup??'sales');
}

function trapSidebarFocus(event) {
  if (event.key !== 'Tab' || !el('app-view').classList.contains('sidebar-open')) return;
  const focusable = [...el('app-sidebar').querySelectorAll('button:not([disabled]):not(.hidden),select:not([disabled]),input:not([disabled]),a[href]')]
    .filter((item) => item.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function showStockView(name='list'){
  const page=el('page-stock'),workspace=page.querySelector('.stock-workspace'),parts=[...workspace.children];
  const headings={
    list:['PERSEDIAAN','Manajemen stok','Tekan barang untuk menambah, mengurangi, melihat batch, atau memeriksa log stok.'],
    expiry:['BATCH & EXP','Batch dan kedaluwarsa','Pantau urutan FEFO, stok tanpa tanggal EXP, dan risiko kedaluwarsa.'],
    count:['STOK OPNAME','Stok opname','Catat jumlah fisik; setiap selisih masuk jurnal dan audit.'],
    ledger:['JURNAL STOK','Jurnal stok','Jejak pergerakan stok terbaru di seluruh barang dan lokasi.']
  };
  const [eyebrow,title,description]=headings[name]??headings.list;
  el('stock-page-eyebrow').textContent=eyebrow;
  el('stock-page-title').textContent=title;
  el('stock-page-description').textContent=description;
  page.querySelector('.expiry-dashboard').classList.toggle('hidden',name!=='expiry');
  workspace.classList.toggle('hidden',name!=='count');
  parts[0]?.classList.toggle('hidden',name!=='count');
  el('stock-management-panel').classList.toggle('hidden',name!=='list');
  page.querySelector('.ledger-title').classList.toggle('hidden',name!=='ledger');
  el('ledger-table').classList.toggle('hidden',name!=='ledger');
}

function syncSalesReportShell(){
  const salesActive=state.reportView==='sales';
  const analysisActive=['sales-products','sales-categories','sales-addons','stock-flow'].includes(state.reportView);
  const detailOpen=salesActive&&state.salesReportOpen;
  el('sales-period-nav').classList.toggle('hidden',!salesActive||detailOpen);
  el('sales-report-detail-toolbar').classList.toggle('hidden',!detailOpen);
  el('sales-report-filters').classList.toggle('hidden',!detailOpen&&!analysisActive);
  el('sales-metric-value').classList.toggle('hidden',!detailOpen);
  el('sales-analysis-page').classList.toggle('hidden',!analysisActive);
  if(!salesActive&&!analysisActive){
    el('report-filter-panel').classList.remove('hidden');
    el('report-status').classList.remove('hidden');
    return;
  }
  el('report-filter-panel').classList.add('hidden');
  el('report-status').classList.toggle('hidden',salesActive&&!detailOpen);
  el('report-cards').classList.toggle('hidden',!detailOpen);
  if(!detailOpen||analysisActive){
    el('sales-period-breakdown').classList.add('hidden');
    el('report-sales-workspace').classList.add('hidden');
  }
}

function syncPurchaseReportShell(){
  const active=state.reportView==='purchases-history',detail=active&&state.purchaseReportOpen;
  el('purchase-period-nav').classList.toggle('hidden',!active||detail);
  el('purchase-report-detail-toolbar').classList.toggle('hidden',!detail);
  el('report-purchase-workspace').classList.toggle('hidden',!detail);
  if(!active)return;
  el('report-filter-panel').classList.add('hidden');
  el('report-status').classList.add('hidden');
  el('report-cards').classList.add('hidden');
  el('sales-metric-value').classList.add('hidden');
}

function showReportView(name='summary'){
  const page=el('page-reports'),primary=page.querySelector('.report-grid.report-primary'),grids=[...page.querySelectorAll('.report-grid')],secondary=grids.find((grid)=>grid!==primary);
  if(page.classList.contains('receipt-page-open'))closeHistoryReceiptPage();
  if(page.classList.contains('purchase-receipt-open'))closePurchaseReportReceipt();
  const cards=el('report-cards'),daily=primary?.children[0],products=primary?.children[1],outlets=secondary?.children[0],purchases=secondary?.children[1];
  const sales=el('report-sales-workspace'),purchaseWorkspace=el('report-purchase-workspace'),audit=el('audit-logs').closest('.surface');
  state.reportView=name;
  const headings={
    summary:['Kinerja usaha','Pendapatan bersih dan laba sudah memperhitungkan retur pada periode terpilih.'],
    performance:['Kinerja produk & outlet','Bandingkan omzet, laba, jumlah terjual, dan kontribusi setiap outlet.'],
    purchases:['Laporan pembelian','Nilai penerimaan dan retur pembelian dirangkum per supplier.'],
    'purchases-history':['Laporan pembelian','Pilih periode untuk melihat nilai, supplier, dan struk pembelian asli.'],
    sales:['Transaksi','Pendapatan, keuntungan, retur, dan seluruh riwayat struk dalam satu halaman.'],
    'sales-products':['Penjualan barang','Daftar barang terjual beserta qty, pendapatan, dan keuntungan.'],
    'sales-categories':['Penjualan kategori','Bandingkan qty, pendapatan, dan keuntungan setiap kategori.'],
    'sales-addons':['Add-on','Barang tambahan yang terjual bersama barang lain dalam satu transaksi.'],
    'stock-flow':['Arus stok','Pantau setiap kejadian stok masuk dan keluar secara berurutan.'],
    audit:['Jejak aktivitas','Tinjau aktivitas sensitif yang tercatat oleh sistem.']
  };
  el('report-page-title').textContent=headings[name]?.[0]??headings.summary[0];
  el('report-page-description').textContent=headings[name]?.[1]??headings.summary[1];
  el('export-report').classList.toggle('hidden',['sales-products','sales-categories','sales-addons','stock-flow','purchases-history'].includes(name));
  el('refresh-report').classList.toggle('hidden',name==='purchases-history');
  if(name!=='sales')el('sales-period-breakdown').classList.add('hidden');
  cards.classList.toggle('hidden',!['summary','sales'].includes(name));
  daily?.classList.toggle('hidden',name!=='summary');
  products?.classList.add('hidden');
  outlets?.classList.toggle('hidden',name!=='performance');
  purchases?.classList.toggle('hidden',name!=='purchases');
  sales.classList.add('hidden');
  purchaseWorkspace.classList.toggle('hidden',name!=='purchases-history');
  audit.classList.toggle('hidden',name!=='audit');
  primary?.classList.toggle('hidden',name!=='summary');
  secondary?.classList.toggle('hidden',!['performance','purchases'].includes(name));
  if(primary)primary.style.gridTemplateColumns='1fr';
  if(secondary)secondary.style.gridTemplateColumns='1fr';
  if(name==='sales')state.salesReportOpen=false;
  if(name==='purchases-history')state.purchaseReportOpen=false;
  if(['sales-products','sales-categories','sales-addons','stock-flow'].includes(name)){
    const switchingFlow=(name==='stock-flow')!==(state.salesAnalysis.view==='stock-flow');
    if(switchingFlow){state.salesAnalysis.preset='TODAY';state.salesAnalysis.sort=name==='stock-flow'?'DATE_DESC':'QTY_DESC';}
    state.salesAnalysis.view=name;state.salesAnalysis.data=null;
    el('sales-analysis-periods').querySelectorAll('[data-analysis-period]').forEach((button)=>button.classList.toggle('active',button.dataset.analysisPeriod===state.salesAnalysis.preset));
    el('stock-flow-date-filter').querySelectorAll('[data-stock-flow-period]').forEach((button)=>button.classList.toggle('active',button.dataset.stockFlowPeriod===state.salesAnalysis.preset));
    el('stock-flow-date-label').textContent=state.salesAnalysis.preset==='YESTERDAY'?'Kemarin':state.salesAnalysis.preset==='CUSTOM'?'Kustom':'Today';
    el('sales-analysis-custom-period').classList.toggle('hidden',state.salesAnalysis.preset!=='CUSTOM');
    el('sales-analysis-sort-menu').querySelectorAll('[data-analysis-sort]').forEach((button)=>button.classList.toggle('active',button.dataset.analysisSort===state.salesAnalysis.sort));
  }
  syncSalesReportShell();
  syncPurchaseReportShell();
  if(['sales-products','sales-categories','sales-addons','stock-flow'].includes(name)&&state.session)loadSalesAnalysis();
}

function showSettingsView(name='business'){
  const page=el('page-settings'),splits=[...page.querySelectorAll('.settings-split')];
  const views={business:el('business-settings-form'),receipt:el('receipt-settings-form'),outlets:splits[0],locations:splits[1],health:page.querySelector('.system-health'),reset:el('data-reset-settings'),device:el('device-settings-form')};
  Object.entries(views).forEach(([key,node])=>node?.classList.toggle('hidden',key!==name));
}

const multioutletPages=new Set([
  'outlet-transfer-request','outlet-transfer-approval','outlet-in-transit',
  'outlet-pricing','outlet-promotions','outlet-consolidation','outlet-notifications'
]);

const transferStatusLabels={
  REQUESTED:'Menunggu persetujuan',APPROVED:'Disetujui',IN_TRANSIT:'Dalam perjalanan',
  RECEIVED:'Diterima',REJECTED:'Ditolak',CANCELLED:'Dibatalkan'
};

function transferCard(transfer,actions=[]){
  const lines=transfer.items.map((item)=>`${escapeHtml(item.product?.name??'Produk')} · ${Number(item.requested_qty)} pcs`).join('<br>');
  return `<article class="surface multioutlet-card"><div class="multioutlet-card-heading"><div><strong>${escapeHtml(transfer.transfer_no)}</strong><small>${new Date(transfer.requested_at).toLocaleString('id-ID')}</small></div><span class="pill">${transferStatusLabels[transfer.status]??transfer.status}</span></div><p><strong>${escapeHtml(transfer.fromLocation?.name??'-')} → ${escapeHtml(transfer.toLocation?.name??'-')}</strong></p><p class="muted">${lines}</p>${transfer.note?`<p class="multioutlet-note">${escapeHtml(transfer.note)}</p>`:''}${actions.length?`<div class="button-row">${actions.map(([action,label,tone='secondary'])=>`<button type="button" class="button ${tone}" data-transfer-action="${action}" data-transfer-id="${transfer.id}">${label}</button>`).join('')}</div>`:''}</article>`;
}

function renderMultiOutletTransfers(){
  const transfers=state.multioutlet.transfers;
  const requests=transfers.filter((item)=>item.status!=='IN_TRANSIT');
  el('transfer-request-list').innerHTML=requests.map((item)=>transferCard(item,[])).join('')||'<div class="empty-state">Belum ada dokumen transfer.</div>';
  const approvals=transfers.filter((item)=>['REQUESTED','APPROVED'].includes(item.status));
  el('transfer-approval-list').innerHTML=approvals.map((item)=>transferCard(item,item.status==='REQUESTED'
    ?[['approve','Setujui','primary'],['reject','Tolak']]
    :[['ship','Kirim barang','primary'],['cancel','Batalkan']]
  )).join('')||'<div class="empty-state">Tidak ada transfer yang menunggu tindakan.</div>';
  const transit=transfers.filter((item)=>item.status==='IN_TRANSIT');
  const qty=transit.flatMap((item)=>item.items).reduce((sum,item)=>sum+Number(item.shipped_qty),0);
  el('transfer-transit-metrics').innerHTML=`<article><span>Dokumen perjalanan</span><strong>${transit.length}</strong></article><article><span>Jumlah barang</span><strong>${qty} pcs</strong></article>`;
  el('transfer-transit-list').innerHTML=transit.map((item)=>transferCard(item,[['receive','Terima di tujuan','primary']])).join('')||'<div class="empty-state">Tidak ada stok dalam perjalanan.</div>';
}

function renderOutletPricing(){
  const rows=state.multioutlet.pricing.overrides;
  el('outlet-price-list').innerHTML=`<table><thead><tr><th>Outlet</th><th>Produk</th><th>Tipe pelanggan</th><th>Minimal</th><th>Harga</th><th>Status</th></tr></thead><tbody>${rows.map((item)=>`<tr><td>${escapeHtml(state.outlets.find((outlet)=>outlet.id===item.outlet_id)?.name??'-')}</td><td>${escapeHtml(state.products.find((product)=>product.id===item.product_id)?.name??'-')}</td><td>${escapeHtml(customerGroupName(item.customer_group_id))}</td><td>${Number(item.min_base_qty)} pcs</td><td>${money.format(item.unit_price_base)}</td><td>${item.active?'Aktif':'Nonaktif'}</td></tr>`).join('')||'<tr><td colspan="6">Belum ada harga khusus outlet.</td></tr>'}</tbody></table>`;
}

function renderOutletPromotions(){
  el('outlet-promotion-list').innerHTML=state.multioutlet.promotions.map((promo)=>`<article class="surface multioutlet-card"><div class="multioutlet-card-heading"><div><strong>${escapeHtml(promo.name??promo.code)}</strong><small>${escapeHtml(promo.code)} · v${promo.version} · ${promo.status}</small></div><span class="pill">${promo.outletIds.length?`${promo.outletIds.length} outlet`:'Global'}</span></div><div class="outlet-scope-options">${state.outlets.map((outlet)=>`<label><input type="checkbox" data-promo-outlet="${promo.id}" value="${outlet.id}" ${promo.outletIds.includes(outlet.id)?'checked':''}> ${escapeHtml(outlet.name)}</label>`).join('')}</div><button type="button" class="button primary" data-save-promo-scope="${promo.id}">Simpan cakupan</button></article>`).join('')||'<div class="empty-state">Belum ada versi promo.</div>';
}

function renderOutletConsolidation(){
  const data=state.multioutlet.consolidation;
  if(!data)return;
  const total=data.totals;
  el('outlet-consolidation-metrics').innerHTML=[
    ['Outlet',total.outlets],['Penjualan 30 hari',money.format(total.sales30d)],['Laba kotor 30 hari',money.format(total.grossProfit30d)],
    ['Nilai stok',money.format(total.stockValue)],['Stok perjalanan',`${total.inTransitQty} pcs`]
  ].map(([label,value])=>`<article><span>${label}</span><strong>${value}</strong></article>`).join('');
  el('outlet-consolidation-list').innerHTML=`<table><thead><tr><th>Outlet</th><th>Penjualan 30 hari</th><th>Laba kotor</th><th>Jumlah stok</th><th>Nilai stok</th></tr></thead><tbody>${data.outlets.map((item)=>`<tr><td><strong>${escapeHtml(item.name)}</strong></td><td>${money.format(item.sales30d)}</td><td>${money.format(item.grossProfit30d)}</td><td>${item.stockQty} pcs</td><td>${money.format(item.stockValue)}</td></tr>`).join('')}</tbody></table>`;
}

function renderOutletNotifications(){
  el('outlet-notification-list').innerHTML=state.multioutlet.notifications.map((item)=>`<article class="surface multioutlet-card notification-${item.severity.toLowerCase()}"><div class="multioutlet-card-heading"><div><strong>${escapeHtml(item.title)}</strong><small>${new Date(item.detected_at).toLocaleString('id-ID')}</small></div><span class="pill">${item.severity}</span></div><p>${escapeHtml(item.message)}</p><div class="button-row"><button type="button" class="button primary" data-notification-action="acknowledge" data-notification-id="${item.id}">Sudah ditangani</button><button type="button" class="button secondary" data-notification-action="dismiss" data-notification-id="${item.id}">Abaikan</button></div></article>`).join('')||'<div class="empty-state">Tidak ada notifikasi terbuka.</div>';
}

function populateMultiOutletForms(){
  const locationOptions=state.locations.map((item)=>`<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
  el('advanced-transfer-from').innerHTML=locationOptions;
  el('advanced-transfer-to').innerHTML=locationOptions;
  if(state.locations[1])el('advanced-transfer-to').value=state.locations[1].id;
  el('advanced-transfer-product').innerHTML=state.products.map((item)=>`<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
  el('outlet-price-outlet').innerHTML=state.outlets.map((item)=>`<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
  el('outlet-price-product').innerHTML=state.products.map((item)=>`<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
}

async function loadMultiOutletWorkspace(){
  const [transfers,pricing,promotions,consolidation,notifications]=await Promise.all([
    request('/api/multi-outlet/transfers'),request('/api/multi-outlet/pricing'),
    request('/api/multi-outlet/promotions'),request('/api/multi-outlet/consolidation'),
    request('/api/multi-outlet/notifications')
  ]);
  state.multioutlet={transfers:transfers.transfers??[],pricing,promotions:promotions.versions??[],consolidation,notifications:notifications.notifications??[]};
  populateMultiOutletForms();renderMultiOutletTransfers();renderOutletPricing();renderOutletPromotions();renderOutletConsolidation();renderOutletNotifications();
}

async function advanceTransfer(id,action){
  try{
    await request(`/api/multi-outlet/transfers/${id}/${action}`,{method:'POST',body:'{}'});
    toast('Status transfer diperbarui');await loadMultiOutletWorkspace();await refreshCatalog();
  }catch(error){toast(error.message);}
}

const accountingPages=new Set([
  'accounting-accounts','accounting-journals','accounting-ledger',
  'accounting-trial-balance','accounting-balance-sheet','accounting-periods'
]);

const accountingTypeLabels={ASSET:'Aset',LIABILITY:'Kewajiban',EQUITY:'Modal',REVENUE:'Pendapatan',EXPENSE:'Biaya'};

function initializeAccountingDates(){
  const today=storeDateToday();
  if(!el('accounting-from').value)el('accounting-from').value=today;
  if(!el('accounting-to').value)el('accounting-to').value=today;
  if(!el('manual-journal-date').value)el('manual-journal-date').value=today;
  if(!el('accounting-period-start').value)el('accounting-period-start').value=`${today.slice(0,8)}01`;
  if(!el('accounting-period-end').value)el('accounting-period-end').value=today;
}

function accountingBalanceDisplay(item){
  const raw=Number(item.ending??0);
  const amount=item.normalBalance==='CREDIT'?-raw:raw;
  return `${money.format(Math.abs(amount))}${amount<0?' (berlawanan)':''}`;
}

function renderManualJournalLines(){
  const accounts=(state.accounting?.accounts??[]).filter((item)=>item.allow_manual);
  const options=accounts.map((item)=>`<option value="${item.id}">${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`).join('');
  const outletOptions=`<option value="">Tanpa outlet</option>${state.outlets.map((item)=>`<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}`;
  el('manual-journal-lines').innerHTML=state.manualJournalLines.map((line,index)=>`<article class="manual-journal-line" data-journal-line="${index}"><select class="manual-line-account">${options}</select><select class="manual-line-outlet">${outletOptions}</select><input class="manual-line-memo" maxlength="240" placeholder="Memo baris"><input class="manual-line-debit" type="number" min="0" step="1" placeholder="Debit" value="${line.debit||''}"><input class="manual-line-credit" type="number" min="0" step="1" placeholder="Kredit" value="${line.credit||''}"><button type="button" class="link-button remove-manual-line" ${state.manualJournalLines.length<=2?'disabled':''}>Hapus</button></article>`).join('');
  state.manualJournalLines.forEach((line,index)=>{
    const row=el('manual-journal-lines').querySelector(`[data-journal-line="${index}"]`);
    if(accounts.some((item)=>item.id===line.accountId))row.querySelector('.manual-line-account').value=line.accountId;
    if(state.outlets.some((item)=>item.id===line.outletId))row.querySelector('.manual-line-outlet').value=line.outletId;
    row.querySelector('.manual-line-memo').value=line.memo??'';
  });
  updateManualJournalTotals();
}

function updateManualJournalTotals(){
  const debit=state.manualJournalLines.reduce((sum,item)=>sum+Number(item.debit||0),0);
  const credit=state.manualJournalLines.reduce((sum,item)=>sum+Number(item.credit||0),0);
  el('manual-journal-debit').textContent=money.format(debit);
  el('manual-journal-credit').textContent=money.format(credit);
  el('manual-journal-debit').classList.toggle('negative',debit!==credit);
  el('manual-journal-credit').classList.toggle('negative',debit!==credit);
}

function renderAccounting(){
  const data=state.accounting;if(!data)return;
  const accounts=data.accounts??[],trial=data.trialBalance??[],entries=data.entries??[];
  const typeCounts=Object.fromEntries(['ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE'].map((type)=>[type,accounts.filter((item)=>item.account_type===type).length]));
  el('accounting-account-metrics').innerHTML=Object.entries(typeCounts).map(([type,count])=>`<article><span>${accountingTypeLabels[type]}</span><strong>${count}</strong></article>`).join('');
  el('accounting-account-list').innerHTML=`<table><thead><tr><th>Kode</th><th>Nama akun</th><th>Kelompok</th><th>Saldo normal</th><th>Input manual</th></tr></thead><tbody>${accounts.map((item)=>`<tr><td><strong>${escapeHtml(item.code)}</strong></td><td>${escapeHtml(item.name)}${item.system_key?`<br><small>${escapeHtml(item.system_key)}</small>`:''}</td><td>${accountingTypeLabels[item.account_type]??item.account_type}</td><td>${item.normal_balance==='DEBIT'?'Debit':'Kredit'}</td><td>${item.allow_manual?'Boleh':'Otomatis'}</td></tr>`).join('')}</tbody></table>`;
  el('accounting-journal-list').innerHTML=`<table><thead><tr><th>Tanggal</th><th>Nomor</th><th>Keterangan</th><th>Sumber</th><th>Debit</th><th>Kredit</th><th></th></tr></thead><tbody>${entries.map((item)=>`<tr class="${item.status==='REVERSED'?'voided-row':''}"><td>${new Date(`${item.entryDate}T00:00:00`).toLocaleDateString('id-ID')}</td><td><strong>${escapeHtml(item.entryNo)}</strong><br><small>${escapeHtml(item.status)}</small></td><td>${escapeHtml(item.description)}</td><td>${escapeHtml(item.sourceType.replaceAll('_',' '))}</td><td>${money.format(item.debit)}</td><td>${money.format(item.credit)}</td><td>${item.sourceType==='MANUAL'&&item.status==='POSTED'?`<button type="button" class="link-button reverse-manual-journal" data-entry-id="${item.id}">Balik</button>`:''}</td></tr>`).join('')||'<tr><td colspan="7">Belum ada jurnal pada periode ini.</td></tr>'}</tbody></table>`;
  const selectedAccount=el('accounting-ledger-account').value;
  el('accounting-ledger-account').innerHTML=accounts.map((item)=>`<option value="${item.id}">${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`).join('');
  if(accounts.some((item)=>item.id===selectedAccount))el('accounting-ledger-account').value=selectedAccount;
  let running=0;
  el('accounting-ledger-list').innerHTML=`<table><thead><tr><th>Tanggal</th><th>Nomor</th><th>Keterangan</th><th>Debit</th><th>Kredit</th><th>Saldo debit</th></tr></thead><tbody>${(data.ledger??[]).map((item)=>{running+=Number(item.debit)-Number(item.credit);return`<tr><td>${new Date(`${item.entryDate}T00:00:00`).toLocaleDateString('id-ID')}</td><td>${escapeHtml(item.entryNo)}</td><td>${escapeHtml(item.description)}${item.memo?`<br><small>${escapeHtml(item.memo)}</small>`:''}</td><td>${money.format(item.debit)}</td><td>${money.format(item.credit)}</td><td>${money.format(running)}</td></tr>`;}).join('')||'<tr><td colspan="6">Pilih akun untuk menampilkan buku besar.</td></tr>'}</tbody></table>`;
  const totalDebit=trial.reduce((sum,item)=>sum+Number(item.debit),0),totalCredit=trial.reduce((sum,item)=>sum+Number(item.credit),0);
  el('accounting-trial-metrics').innerHTML=[['Total debit',money.format(totalDebit)],['Total kredit',money.format(totalCredit)],['Selisih',money.format(Math.abs(totalDebit-totalCredit))],['Status',Math.abs(totalDebit-totalCredit)<1?'Seimbang':'Perlu diperiksa']].map(([label,value])=>`<article><span>${label}</span><strong>${value}</strong></article>`).join('');
  el('accounting-trial-list').innerHTML=`<table><thead><tr><th>Kode</th><th>Akun</th><th>Saldo awal (D-K)</th><th>Debit</th><th>Kredit</th><th>Saldo akhir</th></tr></thead><tbody>${trial.map((item)=>`<tr><td>${escapeHtml(item.code)}</td><td>${escapeHtml(item.name)}</td><td>${money.format(item.opening)}</td><td>${money.format(item.debit)}</td><td>${money.format(item.credit)}</td><td><strong>${accountingBalanceDisplay(item)}</strong></td></tr>`).join('')}</tbody><tfoot><tr><th colspan="3">Total periode</th><th>${money.format(totalDebit)}</th><th>${money.format(totalCredit)}</th><th>${money.format(Math.abs(totalDebit-totalCredit))}</th></tr></tfoot></table>`;
  const balance=data.balanceSheet??{},netIncome=Number(balance.revenue??0)-Number(balance.expenses??0),rightSide=Number(balance.liabilities??0)+Number(balance.equity??0)+netIncome,difference=Number(balance.assets??0)-rightSide;
  el('accounting-balance-metrics').innerHTML=[['Aset',money.format(balance.assets??0)],['Kewajiban',money.format(balance.liabilities??0)],['Modal',money.format(balance.equity??0)],['Laba berjalan',money.format(netIncome)],['Selisih neraca',money.format(Math.abs(difference))]].map(([label,value])=>`<article><span>${label}</span><strong>${value}</strong></article>`).join('');
  el('accounting-balance-list').innerHTML=`<table><thead><tr><th>Kelompok</th><th>Kode</th><th>Akun</th><th>Saldo</th></tr></thead><tbody>${trial.filter((item)=>['ASSET','LIABILITY','EQUITY'].includes(item.type)&&Math.abs(Number(item.ending))>=0.01).map((item)=>`<tr><td>${accountingTypeLabels[item.type]}</td><td>${escapeHtml(item.code)}</td><td>${escapeHtml(item.name)}</td><td>${accountingBalanceDisplay(item)}</td></tr>`).join('')}<tr><td>Modal</td><td>-</td><td><strong>Laba berjalan</strong></td><td><strong>${money.format(netIncome)}</strong></td></tr></tbody><tfoot><tr><th colspan="3">Aset − (kewajiban + modal + laba)</th><th>${money.format(difference)}</th></tr></tfoot></table>`;
  el('accounting-period-list').innerHTML=(data.periods??[]).map((item)=>`<article class="accounting-period-row"><div><strong>${escapeHtml(item.name)}</strong><small>${new Date(`${item.starts_on}T00:00:00`).toLocaleDateString('id-ID')} – ${new Date(`${item.ends_on}T00:00:00`).toLocaleDateString('id-ID')}</small></div><span class="pill">${item.status==='CLOSED'?'Ditutup':'Terbuka'}</span>${item.status==='OPEN'?`<button type="button" class="button primary close-accounting-period" data-period-id="${item.id}">Tutup buku</button>`:''}</article>`).join('')||'<div class="empty-state">Belum ada periode akuntansi.</div>';
  if(!state.manualJournalLines.length)state.manualJournalLines=[{accountId:accounts.find((item)=>item.system_key==='CASH')?.id,debit:0,credit:0},{accountId:accounts.find((item)=>item.system_key==='OWNER_EQUITY')?.id,debit:0,credit:0}];
  renderManualJournalLines();
  el('accounting-status').textContent=`Periode ${data.period.from}–${data.period.to} · ${entries.length} jurnal · dibuat ${new Date(data.generatedAt).toLocaleString('id-ID')}`;
}

async function loadAccounting({sync=false,accountId}={}){
  initializeAccountingDates();
  el('accounting-status').textContent=sync?'Menyinkronkan transaksi ke jurnal...':'Memuat pembukuan...';
  try{
    if(sync)await request('/api/accounting/sync',{method:'POST',body:'{}'});
    const params=new URLSearchParams({from:el('accounting-from').value,to:el('accounting-to').value});
    const selected=accountId===undefined?el('accounting-ledger-account').value:accountId;
    if(selected)params.set('accountId',selected);
    state.accounting=await request(`/api/accounting/dashboard?${params}`);
    renderAccounting();
  }catch(error){el('accounting-status').textContent=`Pembukuan belum dapat dimuat: ${error.message}`;throw error;}
}

async function postManualJournal(event){
  event.preventDefault();
  const debit=state.manualJournalLines.reduce((sum,item)=>sum+Number(item.debit||0),0);
  const credit=state.manualJournalLines.reduce((sum,item)=>sum+Number(item.credit||0),0);
  if(debit<=0||Math.abs(debit-credit)>=1)return toast('Total debit dan kredit harus sama dan lebih dari nol.');
  try{
    await request('/api/accounting/journals',{method:'POST',body:JSON.stringify({
      entryDate:el('manual-journal-date').value,description:el('manual-journal-description').value,
      lines:state.manualJournalLines
    })});
    state.manualJournalLines=[];event.currentTarget.reset();el('manual-journal-date').value=storeDateToday();
    toast('Jurnal manual berhasil diposting');await loadAccounting();
  }catch(error){toast(error.message);}
}

const pilotPages=new Set(['pilot-readiness','pilot-incidents','pilot-performance','pilot-recovery','pilot-sop']);

function pilotStatusLabel(status){
  return {DRAFT:'Draft',ACTIVE:'Berjalan',PASSED:'Lulus',NEEDS_REVISION:'Perlu revisi',CANCELLED:'Dibatalkan',
    PENDING:'Belum diuji',FAILED:'Gagal',NOT_APPLICABLE:'Tidak berlaku'}[status]??status;
}

function renderPilotDashboard(){
  const data=state.pilot;if(!data)return;
  const run=data.activeRun,checks=data.checks??[],passed=checks.filter((item)=>['PASSED','NOT_APPLICABLE'].includes(item.status)).length;
  const failed=checks.filter((item)=>item.status==='FAILED').length,pending=checks.filter((item)=>item.status==='PENDING').length;
  el('pilot-summary').innerHTML=[
    ['Status',run?pilotStatusLabel(run.status):'Belum dimulai'],['Checklist',run?`${passed}/${checks.length}`:'0'],
    ['Gagal',failed],['Insiden terbuka',(data.incidents??[]).filter((item)=>!['RESOLVED','CLOSED'].includes(item.status)).length],
    ['Kesehatan',data.health?.status??'-']
  ].map(([label,value])=>`<article><span>${label}</span><strong>${value}</strong></article>`).join('');
  el('pilot-run-form').classList.toggle('hidden',run?.status==='ACTIVE');
  el('pilot-active-workspace').classList.toggle('hidden',run?.status!=='ACTIVE');
  const safety=data.safety??{};
  el('pilot-safety-title').textContent=safety.ready?'Kontrol transaksi siap':'Kontrol transaksi perlu perhatian';
  el('pilot-safety-list').innerHTML=[
    ['Stok negatif',Number(safety.negativeStock??0)===0],['Idempotensi penjualan',safety.saleIdempotency],
    ['Idempotensi jurnal stok',safety.ledgerIdempotency],['Transaksi penjualan atomik',safety.atomicSaleRpc]
  ].map(([label,ok])=>`<span class="badge ${ok?'ok':'danger'}">${ok?'✓':'!'} ${label}</span>`).join('');
  const groups=[...new Set(checks.map((item)=>item.category))];
  el('pilot-checklist').innerHTML=groups.map((group)=>`<section class="surface pilot-check-group"><div class="settings-section-head"><div><p class="eyebrow">${escapeHtml(group.replaceAll('_',' '))}</p><h2>${checks.filter((item)=>item.category===group&&['PASSED','NOT_APPLICABLE'].includes(item.status)).length}/${checks.filter((item)=>item.category===group).length} selesai</h2></div></div>${checks.filter((item)=>item.category===group).map((item)=>`<article class="pilot-check-row" data-pilot-check="${item.id}"><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.check_code)}</small></div><select class="pilot-check-status"><option value="PENDING" ${item.status==='PENDING'?'selected':''}>Belum diuji</option><option value="PASSED" ${item.status==='PASSED'?'selected':''}>Lulus</option><option value="FAILED" ${item.status==='FAILED'?'selected':''}>Gagal</option><option value="NOT_APPLICABLE" ${item.status==='NOT_APPLICABLE'?'selected':''}>Tidak berlaku</option></select><input class="pilot-check-evidence" value="${escapeHtml(item.evidence_note??'')}" maxlength="500" placeholder="Bukti/catatan"><button class="button secondary save-pilot-check" type="button">Simpan</button></article>`).join('')}</section>`).join('');
  const blockingIncidents=(data.incidents??[]).some((item)=>['HIGH','CRITICAL'].includes(item.severity)&&!['RESOLVED','CLOSED'].includes(item.status));
  el('pilot-pass').disabled=pending>0||failed>0||blockingIncidents||!data.safety?.ready||data.health?.status==='CRITICAL';
  const outletOptions=state.outlets.map((item)=>`<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
  el('pilot-outlet').innerHTML=outletOptions;
  el('incident-outlet').innerHTML=`<option value="">Seluruh sistem</option>${outletOptions}`;
  el('recovery-backup').innerHTML=(data.backups??[]).map((item)=>`<option value="${item.id}">${escapeHtml(item.file_name)} · ${Number(item.total_rows).toLocaleString('id-ID')} baris</option>`).join('')||'<option value="">Belum ada backup selesai</option>';

  el('pilot-incident-list').innerHTML=(data.incidents??[]).map((item)=>`<article class="surface multioutlet-card incident-${item.severity.toLowerCase()}"><div class="multioutlet-card-heading"><div><strong>${escapeHtml(item.title)}</strong><small>${new Date(item.reported_at).toLocaleString('id-ID')} · ${escapeHtml(item.category)}</small></div><span class="pill">${item.severity} · ${item.status}</span></div><p>${escapeHtml(item.description)}</p>${!['RESOLVED','CLOSED'].includes(item.status)?`<div class="pilot-incident-resolution"><input data-incident-resolution="${item.id}" maxlength="500" placeholder="Catatan penyelesaian"><button type="button" class="button primary resolve-pilot-incident" data-incident-id="${item.id}">Selesaikan</button></div>`:`<p class="muted">${escapeHtml(item.resolution_note??'Sudah diselesaikan')}</p>`}</article>`).join('')||'<div class="empty-state">Belum ada insiden produksi.</div>';
  const telemetry=data.telemetry??{};
  el('pilot-performance-metrics').innerHTML=[['Event 7 hari',telemetry.total??0],['Error',telemetry.errors??0],['Permintaan lambat',telemetry.slowRequests??0],['P95 event',`${telemetry.p95DurationMs??0} ms`]].map(([label,value])=>`<article><span>${label}</span><strong>${value}</strong></article>`).join('');
  el('pilot-performance-list').innerHTML=`<table><thead><tr><th>Endpoint</th><th>Event</th><th>Error</th><th>Durasi maksimum</th><th>Terakhir</th></tr></thead><tbody>${(telemetry.endpoints??[]).map((item)=>`<tr><td><code>${escapeHtml(item.endpoint)}</code></td><td>${item.events}</td><td>${item.errors}</td><td>${item.maxDurationMs} ms</td><td>${item.lastSeenAt?new Date(item.lastSeenAt).toLocaleString('id-ID'):'-'}</td></tr>`).join('')||'<tr><td colspan="5">Belum ada error atau permintaan lambat.</td></tr>'}</tbody></table>`;
  el('recovery-drill-list').innerHTML=(data.drills??[]).map((item)=>`<article class="surface multioutlet-card"><div class="multioutlet-card-heading"><div><strong>Latihan ${item.result==='PASSED'?'lulus':'gagal'}</strong><small>${new Date(item.performed_at).toLocaleString('id-ID')} · ${Number(item.row_count).toLocaleString('id-ID')} baris</small></div><span class="pill">${item.result}</span></div><p>Checksum ${item.checksum_verified?'terverifikasi':'belum'} · prosedur ${item.procedure_reviewed?'ditinjau':'belum ditinjau'}</p>${item.notes?`<p class="muted">${escapeHtml(item.notes)}</p>`:''}</article>`).join('')||'<div class="empty-state">Belum ada latihan pemulihan.</div>';
}

async function loadPilotDashboard(){
  state.pilot=await request('/api/pilot/dashboard');
  renderPilotDashboard();
}

async function decidePilot(decision){
  if(!state.pilot?.activeRun)return;
  try{
    await request(`/api/pilot/runs/${state.pilot.activeRun.id}/decide`,{method:'POST',body:JSON.stringify({decision})});
    toast(decision==='PASSED'?'Pilot dinyatakan lulus':'Pilot ditandai perlu revisi');await loadPilotDashboard();
  }catch(error){toast(error.message);}
}

function showPage(name) {
  const item=document.querySelector(`.feature-nav-item[data-page="${name}"]`);
  const target=item?.dataset.targetPage??name;
  document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active', page.id === `page-${target}`));
  document.querySelectorAll('.feature-nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === name));
  if(item?.dataset.purchaseViewTarget)showPurchaseView(item.dataset.purchaseViewTarget);
  if(item?.dataset.stockView)showStockView(item.dataset.stockView);
  if(item?.dataset.reportView)showReportView(item.dataset.reportView);
  if(item?.dataset.settingsView)showSettingsView(item.dataset.settingsView);
  if(target==='pos')setMobilePosView('catalog',{focus:false});
  const group=item?.closest('[data-nav-panel]')?.dataset.navPanel;
  if(group)openNavGroup(group);
  if(item?.closest('#sales-report-subnav')){
    el('sales-report-subnav').classList.add('active');
    el('sales-report-subnav-toggle').setAttribute('aria-expanded','true');
  }
  localStorage.setItem('pos_active_page',name);
  if(target==='products')loadProductManagement().catch((error)=>toast(error.message));
  if(multioutletPages.has(name))loadMultiOutletWorkspace().catch((error)=>toast(error.message));
  if(accountingPages.has(name))loadAccounting({sync:!state.accounting}).catch((error)=>toast(error.message));
  if(pilotPages.has(name)&&name!=='pilot-sop')loadPilotDashboard().catch((error)=>toast(error.message));
}

function openNavGroup(group,{toggle=false}={}){
  const panel=document.querySelector(`[data-nav-panel="${group}"]`);
  if(!panel||panel.classList.contains('hidden'))return;
  const wasOpen=panel.classList.contains('active');
  state.activeNavGroup=group;
  const shouldOpen=!(toggle&&wasOpen);
  document.querySelectorAll('[data-nav-panel]').forEach((node)=>node.classList.toggle('active',shouldOpen&&node.dataset.navPanel===group));
  document.querySelectorAll('[data-nav-group]').forEach((button)=>{
    const expanded=shouldOpen&&button.dataset.navGroup===group;
    button.classList.toggle('active',expanded);
    button.setAttribute('aria-expanded',String(expanded));
    const arrow=button.querySelector('b');
    if(arrow)arrow.textContent=expanded?'⌄':'›';
  });
}

function syncNavigationPermissions(){
  document.querySelectorAll('[data-nav-panel]').forEach((panel)=>{
    const available=[...panel.querySelectorAll('.feature-nav-item')].some((item)=>!item.classList.contains('hidden'));
    panel.classList.toggle('hidden',!available);
    document.querySelector(`[data-nav-group="${panel.dataset.navPanel}"]`)?.classList.toggle('hidden',!available);
  });
  const active=document.querySelector('.feature-nav-item.active:not(.hidden)');
  if(!active){
    const first=document.querySelector('.feature-nav-item:not(.hidden)');
    if(first)showPage(first.dataset.page);
  }else{
    openNavGroup(active.closest('[data-nav-panel]').dataset.navPanel);
  }
}

document.querySelectorAll('[data-login-portal]').forEach((button) => button.addEventListener('click', () => {
  setLoginPortal(button.dataset.loginPortal);
  el('email').focus();
}));
el('open-owner-registration').addEventListener('click', () => setAuthView('register'));
el('back-to-login').addEventListener('click', () => {
  el('email').value = el('register-owner-email').value.trim();
  setAuthView('login');
});
el('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  el('login-error').textContent = '';
  button.disabled = true;
  button.textContent = 'Sedang masuk...';
  try {
    await login(el('email').value, el('password').value, state.loginPortal);
  } catch (error) {
    el('login-error').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = state.loginPortal === 'OWNER' ? 'Masuk sebagai Owner' : 'Masuk sebagai Staff';
  }
});
el('register-owner-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const password = el('register-owner-password').value;
  const confirmation = el('register-owner-password-confirmation').value;
  el('register-owner-error').textContent = '';
  el('register-owner-success').classList.add('hidden');
  if (password !== confirmation) {
    el('register-owner-error').textContent = 'Ulangi kata sandi harus sama.';
    return;
  }
  button.disabled = true;
  button.textContent = 'Menyiapkan ruang usaha...';
  try {
    const data = await registerOwner({
      ownerName: el('register-owner-name').value.trim(),
      businessName: el('register-business-name').value.trim(),
      email: el('register-owner-email').value.trim(),
      password
    });
    if (data.requiresEmailConfirmation) {
      el('register-owner-success').textContent = 'Akun dan ruang usaha berhasil dibuat. Periksa email untuk mengaktifkan akun, lalu kembali masuk sebagai Owner.';
      el('register-owner-success').classList.remove('hidden');
      button.classList.add('hidden');
    }
  } catch (error) {
    el('register-owner-error').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Buat akun Owner';
  }
});

async function endCurrentSession(nextPortal = null) {
  try {
    await request('/api/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: state.refreshToken })
    }, false);
  } catch {}
  clearAuth();
  if (nextPortal) sessionStorage.setItem('pos_login_portal', nextPortal);
  location.reload();
}

function renderOwnerContexts(data) {
  el('owner-switch-list').innerHTML=(data.owners??[]).map((owner)=>`
    <button class="owner-switch-option" type="button" data-owner-id="${escapeHtml(owner.id)}" ${owner.active?'disabled':''}>
      <strong>${escapeHtml(owner.displayName)}</strong>
      <small>${owner.authenticated?'Akun yang melakukan login':'Owner dalam usaha yang sama'}</small>
      ${owner.active?'<span class="pill success">Aktif</span>':''}
    </button>
  `).join('')||'<div class="empty-state compact">Tidak ada Owner aktif lainnya.</div>';
}

async function openOwnerSwitch() {
  if (!state.session?.canSwitchOwners) return toast('Hanya Owner yang dapat mengganti konteks Owner.');
  setSidebarOpen(false);
  el('owner-switch-list').innerHTML='<div class="empty-state compact">Memuat Owner...</div>';
  el('owner-switch-dialog').showModal();
  try {
    renderOwnerContexts(await request('/api/owner-contexts'));
  } catch (error) {
    el('owner-switch-list').innerHTML=`<div class="empty-state compact">${escapeHtml(error.message)}</div>`;
  }
}

async function switchOwnerContext(ownerId) {
  const result=await request('/api/owner-contexts/switch',{
    method:'POST',body:JSON.stringify({ownerId})
  });
  state.ownerContextId=result.contextId??null;
  if(state.ownerContextId)localStorage.setItem('pos_owner_context_id',state.ownerContextId);
  else localStorage.removeItem('pos_owner_context_id');
  localStorage.removeItem('pos_bootstrap_cache');
  location.reload();
}

el('switch-account').addEventListener('click', openOwnerSwitch);
el('sync-now').addEventListener('click', synchronizeData);
el('close-owner-switch').addEventListener('click',()=>el('owner-switch-dialog').close());
el('owner-switch-list').addEventListener('click',async(event)=>{
  const button=event.target.closest('[data-owner-id]');
  if(!button||button.disabled)return;
  button.disabled=true;
  try{await switchOwnerContext(button.dataset.ownerId);}
  catch(error){button.disabled=false;toast(error.message);}
});
el('logout').addEventListener('click', async () => {
  const portal = state.session?.user?.role === 'OWNER' ? 'OWNER' : 'STAFF';
  await endCurrentSession(portal);
});
el('nav').addEventListener('click', (event) => {
  const reportSubnav=event.target.closest('#sales-report-subnav-toggle');
  if(reportSubnav){
    const open=el('sales-report-subnav').classList.toggle('active');
    reportSubnav.setAttribute('aria-expanded',String(open));reportSubnav.querySelector('b').textContent=open?'⌄':'›';
    return;
  }
  const groupButton=event.target.closest('[data-nav-group]');
  if(groupButton){openNavGroup(groupButton.dataset.navGroup,{toggle:true});return;}
  const button=event.target.closest('[data-page]');
  if(!button)return;
  if(button.dataset.page==='imports'){
    state.productImportMode='GENERAL';
    syncProductImportModeUi();
  }
  showPage(button.dataset.page);
  const target=button.dataset.targetPage??button.dataset.page;
  if(mobileSidebarMedia.matches)setSidebarOpen(false);
  if(target==='users')loadUsers();
  if(target==='sync-review')loadSyncReview();
  if(target==='settings')loadSettingsWorkspace();
  if(target==='loyalty')showLoyaltyView('');
  if(['promotions','loyalty'].includes(target))loadPromotionManagement();
});
el('sales-analysis-sort-menu').addEventListener('click',(event)=>{
  const button=event.target.closest('[data-analysis-sort]');if(!button)return;
  state.salesAnalysis.sort=button.dataset.analysisSort;
  el('sales-analysis-sort-menu').querySelectorAll('[data-analysis-sort]').forEach((item)=>item.classList.toggle('active',item===button));
  el('sales-analysis-sort-menu').open=false;
  renderSalesAnalysis();
});
el('sales-analysis-search').addEventListener('input',renderSalesAnalysis);
el('sales-analysis-periods').addEventListener('click',(event)=>{
  const button=event.target.closest('[data-analysis-period]');if(!button)return;
  state.salesAnalysis.preset=button.dataset.analysisPeriod;
  el('sales-analysis-periods').querySelectorAll('button').forEach((item)=>item.classList.toggle('active',item===button));
  el('sales-analysis-custom-period').classList.toggle('hidden',state.salesAnalysis.preset!=='CUSTOM');
  if(state.salesAnalysis.preset==='CUSTOM'){
    if(!el('sales-analysis-from').value)el('sales-analysis-from').value=storeDateToday();
    if(!el('sales-analysis-to').value)el('sales-analysis-to').value=storeDateToday();
  }
  if(state.salesAnalysis.preset!=='CUSTOM')loadSalesAnalysis();
});
el('stock-flow-date-filter').addEventListener('click',(event)=>{
  const button=event.target.closest('[data-stock-flow-period]');if(!button)return;
  state.salesAnalysis.preset=button.dataset.stockFlowPeriod;
  el('stock-flow-date-filter').querySelectorAll('[data-stock-flow-period]').forEach((item)=>item.classList.toggle('active',item===button));
  el('stock-flow-date-label').textContent=state.salesAnalysis.preset==='YESTERDAY'?'Kemarin':state.salesAnalysis.preset==='CUSTOM'?'Kustom':'Today';
  el('stock-flow-date-filter').open=false;
  el('sales-analysis-custom-period').classList.toggle('hidden',state.salesAnalysis.preset!=='CUSTOM');
  if(state.salesAnalysis.preset==='CUSTOM'){
    if(!el('sales-analysis-from').value)el('sales-analysis-from').value=storeDateToday();
    if(!el('sales-analysis-to').value)el('sales-analysis-to').value=storeDateToday();
  }else loadSalesAnalysis();
});
el('apply-sales-analysis-period').addEventListener('click',loadSalesAnalysis);
el('sidebar-toggle').addEventListener('click', () => setSidebarOpen(!el('app-view').classList.contains('sidebar-open'), { restoreFocus:true }));
el('sidebar-backdrop').addEventListener('click', () => setSidebarOpen(false, { restoreFocus:true }));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && el('app-view').classList.contains('sidebar-open')) {
    event.preventDefault();
    setSidebarOpen(false, { restoreFocus:true });
    return;
  }
  trapSidebarFocus(event);
});
if (typeof mobileSidebarMedia.addEventListener === 'function') mobileSidebarMedia.addEventListener('change', syncSidebarMode);
else mobileSidebarMedia.addListener(syncSidebarMode);
syncSidebarMode();
el('current-outlet-select').addEventListener('change', switchActiveOutlet);
el('product-search').addEventListener('input', (event) => {state.posProductLimit=100;renderProducts(event.target.value);});
el('product-search').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const value = event.target.value.trim();
  const exact = barcodeMatch(value);
  if (exact) addScannedProduct(exact.product, exact.unit);
  else if(/^[A-Za-z0-9]{10}$/.test(value))tryScannedVoucher(value);
  event.target.value='';
});
el('pos-category-filters').addEventListener('click',(event)=>{const button=event.target.closest('[data-category]');if(!button)return;state.posCategoryFilter=button.dataset.category;state.posProductLimit=100;renderProducts(el('product-search').value);});
el('favorite-filter').addEventListener('click',()=>{state.favoriteOnly=!state.favoriteOnly;state.posProductLimit=100;renderProducts(el('product-search').value);});
el('product-grid').addEventListener('click',(event)=>{if(!event.target.closest('[data-product-load-more]'))return;state.posProductLimit+=100;renderProducts(el('product-search').value);});
el('scan-camera-pos').addEventListener('click', () => openBarcodeCamera('pos'));
el('close-barcode-camera').addEventListener('click', stopBarcodeCamera);
el('cancel-barcode-camera').addEventListener('click', stopBarcodeCamera);
el('barcode-camera-dialog').addEventListener('close', stopBarcodeCamera);
window.addEventListener('pagehide', stopBarcodeCamera);
el('customer-group').addEventListener('change', async () => { invalidateSaleAuthorization(); await updateQuote(); });
el('open-pos-customer').addEventListener('click',openPosCustomerPicker);
el('close-pos-customer').addEventListener('click',()=>el('pos-customer-dialog').close());
el('customer-search').addEventListener('focus', (event) => { event.currentTarget.select(); renderCustomerSearchResults(event.currentTarget.value); });
el('customer-search').addEventListener('input', (event) => renderCustomerSearchResults(event.currentTarget.value));
el('customer-search').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') return el('customer-search-results').classList.add('hidden');
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const customer = matchingCustomers(event.currentTarget.value)[0];
  if (customer) selectPosCustomer(customer.id);
});
el('customer-search-results').addEventListener('click', (event) => {
  const option = event.target.closest('[data-customer-id]');
  if (option) selectPosCustomer(option.dataset.customerId ?? '');
});
el('clear-pos-customer').addEventListener('click',()=>selectPosCustomer(''));
el('new-pos-customer').addEventListener('click',()=>{el('pos-customer-dialog').close();openCustomerEditor(null,'pos');});
el('clear-cart').addEventListener('click', async () => { state.cart = []; resetPosCustomer();el('sale-note').value='';invalidateSaleAuthorization(); await updateQuote(); });
el('mobile-cart-jump').addEventListener('click',()=>setMobilePosView('cart'));
el('mobile-cart-back').addEventListener('click',()=>setMobilePosView('catalog'));
el('refresh-pos-history').addEventListener('click',()=>loadPosSales(el('pos-history-search').value,{reportScope:true}));
el('pos-history-search').addEventListener('input',(event)=>{clearTimeout(event.currentTarget.searchTimer);event.currentTarget.searchTimer=setTimeout(()=>loadPosSales(event.currentTarget.value,{reportScope:true}),250);});
el('pos-history-list').addEventListener('click',(event)=>{const row=event.target.closest('[data-pos-sale-id]');if(!row)return;const sale=state.posSales.find((item)=>item.id===row.dataset.posSaleId);state.selectedPosSaleId=row.dataset.posSaleId;renderPosSales();if(state.reportView==='sales'&&sale)openHistoryReceiptPage(sale);});
el('back-history-receipt').addEventListener('click',closeHistoryReceiptPage);
el('history-receipt-menu-toggle').addEventListener('click',toggleHistoryReceiptMenu);
el('history-receipt-menu-backdrop').addEventListener('click',closeHistoryReceiptMenu);
el('close-history-receipt-menu').addEventListener('click',closeHistoryReceiptMenu);
el('history-receipt-menu').addEventListener('click',(event)=>{const button=event.target.closest('[data-history-receipt-action]');if(button)handleHistoryReceiptAction(button.dataset.historyReceiptAction);});
el('refresh-purchase-report').addEventListener('click',loadPurchaseReportReceipts);
el('purchase-period-nav').addEventListener('click',(event)=>{
  const button=event.target.closest('[data-purchase-period]');if(!button)return;
  state.purchaseReportPeriod=button.dataset.purchasePeriod;
  state.purchaseReportOpen=true;
  el('purchase-report-detail-title').textContent=purchaseReportRange().title;
  syncPurchaseReportShell();
  loadPurchaseReportReceipts();
});
el('close-purchase-report-detail').addEventListener('click',()=>{
  state.purchaseReportOpen=false;syncPurchaseReportShell();
});
el('purchase-report-search').addEventListener('input',renderPurchaseReportReceipts);
el('purchase-report-list').addEventListener('click',(event)=>{const row=event.target.closest('[data-purchase-report-id]');if(!row)return;const receipt=(state.purchaseReportReceipts||[]).find((item)=>item.id===row.dataset.purchaseReportId);if(receipt)openPurchaseReportReceipt(receipt);});
el('back-purchase-report').addEventListener('click',closePurchaseReportReceipt);
el('print-purchase-report').addEventListener('click',()=>{document.body.classList.add('purchase-report-print');window.print();});
window.addEventListener('afterprint',()=>document.body.classList.remove('purchase-report-print','history-receipt-print'));
el('pos-history-detail').addEventListener('click',(event)=>{
  const sale=state.posSales.find((item)=>item.id===state.selectedPosSaleId);if(!sale)return;
  if(event.target.closest('.reprint-pos-sale')){state.lastReceipt=sale;renderReceipt(sale,sale.payments,{allowAutoPrint:false,closeLabel:'Tutup'});}
  if(event.target.closest('.open-void-sale'))openVoidSale(sale);
});
el('void-sale-form').addEventListener('submit',submitVoidSale);
el('close-void-sale').addEventListener('click',()=>el('void-sale-dialog').close());
el('cancel-void-sale').addEventListener('click',()=>el('void-sale-dialog').close());
el('open-shortcuts').addEventListener('click',()=>el('shortcut-dialog').showModal());
el('close-shortcuts').addEventListener('click',()=>el('shortcut-dialog').close());
document.addEventListener('keydown',handlePosShortcut);
el('open-order-adjustment').addEventListener('click',()=>openSaleAdjustmentDialog(null));
el('sale-adjustment-form').addEventListener('submit',approveSaleAdjustment);
el('close-sale-adjustment').addEventListener('click',()=>el('sale-adjustment-dialog').close());
el('cancel-sale-adjustment').addEventListener('click',()=>el('sale-adjustment-dialog').close());
el('unit-picker-options').addEventListener('click', async (event) => {
  const option = event.target.closest('[data-unit-id]');
  const context = state.unitPicker;
  if (!option || !context) return;
  if (context.cartIndex !== null) return changeCartUnit(context.cartIndex, option.dataset.unitId);
  state.unitPicker = null;
  el('unit-picker-dialog').close();
  await addToCart(context.productId, option.dataset.unitId);
});
el('close-unit-picker').addEventListener('click',()=>el('unit-picker-dialog').close());
el('unit-picker-dialog').addEventListener('close',()=>{state.unitPicker=null;});
el('pay-button').addEventListener('click',openPaymentDialog);
el('exact-cash-button').addEventListener('click',openPaymentDialog);
el('apply-voucher').addEventListener('click',applyVoucherCode);
el('voucher-code').addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();applyVoucherCode();}});
el('remove-voucher').addEventListener('click',async()=>{state.voucherCode='';el('voucher-code').value='';await updateQuote();});
el('payment-form').addEventListener('submit',completePayment);
el('cancel-payment').addEventListener('click',()=>el('payment-dialog').close());
el('close-payment').addEventListener('click',()=>el('payment-dialog').close());
el('payment-mode').addEventListener('change',()=>{
  if(el('payment-mode').value==='SINGLE'){state.paymentDraft=state.paymentDraft.slice(0,1);state.paymentDraft[0].amount=state.quote.grandTotal;if(state.paymentDraft[0].method==='CASH')state.paymentDraft[0].tendered=state.quote.grandTotal;}
  renderPaymentLines();
});
el('add-payment-line').addEventListener('click',()=>{if(state.paymentDraft.length<4){state.paymentDraft.push({method:'QRIS',amount:0,tendered:null,reference:''});renderPaymentLines();}});
el('payment-lines').addEventListener('input',(event)=>{
  const row=event.target.closest('.payment-line');if(!row)return;const index=Number(row.dataset.index),payment=state.paymentDraft[index];
  if(event.target.classList.contains('payment-line-amount')){payment.amount=Number(event.target.value);renderCashKeypad();}
  if(event.target.classList.contains('payment-line-tendered')){payment.tendered=Number(event.target.value);state.paymentKeypadIndex=index;state.paymentKeypadFresh=false;renderCashKeypad();}
  if(event.target.classList.contains('payment-line-reference'))payment.reference=event.target.value;
  updatePaymentSummary();
});
el('payment-lines').addEventListener('focusin',(event)=>{
  if(!event.target.classList.contains('payment-line-tendered'))return;
  state.paymentKeypadIndex=Number(event.target.closest('.payment-line').dataset.index);state.paymentKeypadFresh=true;renderCashKeypad();
});
el('payment-lines').addEventListener('change',(event)=>{
  if(!event.target.classList.contains('payment-line-method'))return;const row=event.target.closest('.payment-line'),index=Number(row.dataset.index),payment=state.paymentDraft[index];
  payment.method=event.target.value;if(payment.method==='CASH'){payment.tendered=payment.amount;state.paymentKeypadIndex=index;state.paymentKeypadFresh=true;}renderPaymentLines();
});
el('payment-lines').addEventListener('click',(event)=>{const button=event.target.closest('.remove-payment-line');if(!button)return;state.paymentDraft.splice(Number(button.closest('.payment-line').dataset.index),1);state.paymentKeypadIndex=0;renderPaymentLines();});
el('cash-keypad').addEventListener('click',(event)=>{
  const amountButton=event.target.closest('[data-cash-amount]');
  if(amountButton)return setCashTendered(Number(amountButton.dataset.cashAmount),{fresh:true});
  const keyButton=event.target.closest('[data-cash-key]');
  if(!keyButton)return;
  const active=activeCashPayment();if(!active)return;
  const key=keyButton.dataset.cashKey;
  const replace=state.paymentKeypadFresh&&/^\d/.test(key);
  setCashTendered(appendMoneyKey(replace?0:active.payment.tendered,key),{fresh:false});
});
el('hold-cart').addEventListener('click',holdCurrentCart);
el('open-held-sales').addEventListener('click',async()=>{await loadHeldSales();el('held-sales-dialog').showModal();});
el('close-held-sales').addEventListener('click',()=>el('held-sales-dialog').close());
el('held-sales-list').addEventListener('click',(event)=>{const row=event.target.closest('[data-hold-id]');if(!row)return;if(event.target.closest('.resume-held-sale'))actOnHeldSale(row.dataset.holdId,'resume',row.dataset.local==='true');if(event.target.closest('.cancel-held-sale'))actOnHeldSale(row.dataset.holdId,'cancel',row.dataset.local==='true');});
el('close-receipt').addEventListener('click',()=>el('receipt-dialog').close());
el('whatsapp-receipt').addEventListener('click',shareReceiptWhatsApp);
el('print-receipt').addEventListener('click',()=>printReceiptDirect(state.lastReceipt,state.lastReceipt?.payments??state.paymentDraft));
el('close-purchase-order-print').addEventListener('click',()=>el('purchase-order-dialog').close());
el('share-purchase-order').addEventListener('click',sharePurchaseOrder);
el('print-purchase-order').addEventListener('click',printPurchaseOrder);
el('purchase-order-dialog').addEventListener('close',()=>document.body.classList.remove('printing-purchase-order'));
el('sync-button').addEventListener('click', syncQueue);
el('find-return-sale').addEventListener('click',findReturnSale);
el('return-receipt-search').addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();findReturnSale();}});
el('return-item-list').addEventListener('input',(event)=>{const row=event.target.closest('.return-line');if(row)updateReturnLine(row);});
el('return-item-list').addEventListener('change',(event)=>{const row=event.target.closest('.return-line');if(row)updateReturnLine(row);});
el('select-all-returnable').addEventListener('click',()=>{el('return-item-list').querySelectorAll('.return-select:not(:disabled)').forEach((input)=>{input.checked=true;updateReturnLine(input.closest('.return-line'));});});
el('return-refund-method').addEventListener('change',syncReturnRefundFields);
el('return-form').addEventListener('submit',submitCustomerReturn);
el('cancel-return').addEventListener('click',cancelCustomerReturn);
el('refresh-sync-review').addEventListener('click', loadSyncReview);
el('sync-review-list').addEventListener('click', (event) => {
  const button = event.target.closest('.sync-decision');
  if (button) decideSyncCommand(button.closest('[data-command-id]').dataset.commandId, button.dataset.action);
});
el('receive-button').addEventListener('click', receivePurchase);
el('restock-product-search').addEventListener('input', (event) => renderPurchaseProductResults('restock', event.currentTarget.value));
el('restock-product-search').addEventListener('keydown', (event) => handlePurchaseProductEnter('restock', event));
el('search-restock-product').addEventListener('click', () => renderPurchaseProductResults('restock', el('restock-product-search').value));
el('scan-restock-product').addEventListener('click', () => activatePurchaseScanner('restock'));
el('camera-restock-product').addEventListener('click', () => openBarcodeCamera('restock'));
document.querySelectorAll('[data-restock-step-target]').forEach((button)=>button.addEventListener('click',()=>{
  setRestockWizardStep(button.dataset.restockStepTarget,{validate:true});
}));
el('restock-wizard-back').addEventListener('click',()=>moveRestockWizard(-1));
el('restock-wizard-next').addEventListener('click',()=>moveRestockWizard(1));
el('restock-document').addEventListener('keydown',(event)=>{
  if(event.key==='Enter'){event.preventDefault();setRestockWizardStep('items',{validate:true});}
});
document.querySelectorAll('.purchase-tab').forEach((button) => button.addEventListener('click', () => {
  showPurchaseView(button.dataset.purchaseView);
  if(button.dataset.purchaseView==='supplier-return')loadRecentSupplierReturns();
  if(button.dataset.purchaseView==='planning')loadRestockPlanning();
}));
el('refresh-restock-planning').addEventListener('click',loadRestockPlanning);
el('planning-location').addEventListener('change',()=>{state.restockSelection.clear();state.restockPlanningLimit=100;loadRestockPlanning();});
el('planning-supplier-filter').addEventListener('change',()=>{state.restockSelection.clear();state.restockPlanningLimit=100;loadRestockPlanning();});
el('planning-order-supplier').addEventListener('change',syncPlanningSelection);
el('planning-needed-only').addEventListener('change',()=>{state.restockPlanningLimit=100;renderRestockPlanning();});
el('planning-product-search').addEventListener('input',()=>{state.restockPlanningLimit=100;renderRestockPlanning();});
el('restock-planning-list').addEventListener('click',(event)=>{
  if(event.target.closest('[data-planning-load-more]')){state.restockPlanningLimit+=100;renderRestockPlanning();return;}
  const row=event.target.closest('.planning-compact-row');if(row)openPlanningItem(row.dataset.productId);
});
el('create-planning-draft').addEventListener('click',createPlanningDraft);
el('planning-item-form').addEventListener('submit',savePlanningItem);
el('close-planning-item').addEventListener('click',()=>el('planning-item-dialog').close());
el('cancel-planning-item').addEventListener('click',()=>el('planning-item-dialog').close());
el('remove-planning-item').addEventListener('click',removePlanningItem);
el('planning-item-policy').addEventListener('click',()=>{const id=el('planning-item-product-id').value;el('planning-item-dialog').close();openRestockPolicy(id);});
el('planning-item-compare').addEventListener('click',()=>{const id=el('planning-item-product-id').value;el('planning-item-dialog').close();showSupplierComparison(id);});
el('purchase-planning-settings-form').addEventListener('submit',savePlanningSettings);
el('restock-policy-form').addEventListener('submit',saveRestockPolicy);
el('close-restock-policy').addEventListener('click',()=>el('restock-policy-dialog').close());
el('cancel-restock-policy').addEventListener('click',()=>el('restock-policy-dialog').close());
el('find-supplier-return-receipt').addEventListener('click',findSupplierReturnReceipt);
el('supplier-return-document').addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();findSupplierReturnReceipt();}});
el('supplier-return-item-list').addEventListener('input',updateSupplierReturnTotal);
el('supplier-return-item-list').addEventListener('change',updateSupplierReturnTotal);
el('select-all-supplier-return').addEventListener('click',()=>{el('supplier-return-item-list').querySelectorAll('.supplier-return-select:not(:disabled)').forEach((input)=>{input.checked=true;});updateSupplierReturnTotal();});
el('supplier-return-form').addEventListener('submit',postSupplierReturn);
el('refresh-supplier-returns').addEventListener('click',loadRecentSupplierReturns);
el('new-purchase-order').addEventListener('click', newPurchaseOrder);
el('cancel-po-edit').addEventListener('click', () => showPurchaseView('documents'));
el('refresh-purchase-orders').addEventListener('click', loadPurchaseOrders);
el('purchase-status-filter').addEventListener('change', renderPurchaseOrders);
el('po-product-search').addEventListener('input', (event) => renderPurchaseProductResults('po', event.currentTarget.value));
el('po-product-search').addEventListener('keydown', (event) => handlePurchaseProductEnter('po', event));
el('search-po-product').addEventListener('click', () => renderPurchaseProductResults('po', el('po-product-search').value));
el('scan-po-product').addEventListener('click', () => activatePurchaseScanner('po'));
el('camera-po-product').addEventListener('click', () => openBarcodeCamera('po'));
el('save-po-draft').addEventListener('click', savePurchaseOrder);
el('po-supplier').addEventListener('change', refreshPoSupplierSnapshots);
el('close-supplier-comparison').addEventListener('click', () => el('supplier-comparison-dialog').close());
['po-discount','po-tax','po-other-cost'].forEach((id) => el(id).addEventListener('input', renderPoTotal));
el('restock-supplier').addEventListener('change', async () => {
  await Promise.all([...document.querySelectorAll('.restock-line')].map(updateRestockComparison));
  el('restock-history').innerHTML = '<p class="eyebrow">HISTORI MODAL</p><p class="muted">Supplier berubah. Klik “Riwayat” untuk melihat histori supplier ini.</p>';
});
el('refresh-inventory').addEventListener('click', loadInventory);
el('stock-management-search').addEventListener('input', renderStockManagement);
el('stock-management-filter').addEventListener('change', renderStockManagement);
el('inventory-table').addEventListener('click', (event) => {
  const row = event.target.closest('[data-stock-product-id]');
  if (row) openStockProduct(row.dataset.stockProductId);
});
el('close-stock-product-dialog').addEventListener('click', () => el('stock-product-dialog').close());
el('stock-product-dialog').addEventListener('click', (event) => {
  const button = event.target.closest('[data-stock-product-view]');
  if (button) showStockProductView(button.dataset.stockProductView);
});
el('stock-product-log').addEventListener('click',(event)=>{
  const receiptButton=event.target.closest('[data-open-stock-sale]');
  if(receiptButton){event.stopPropagation();openStockSaleReceipt(receiptButton.dataset.openStockSale);return;}
  const row=event.target.closest('[data-stock-log-id]');
  if(!row)return;
  state.stockLogEntryId=state.stockLogEntryId===row.dataset.stockLogId?null:row.dataset.stockLogId;
  renderStockProductLog();
});
el('stock-adjustment-location').addEventListener('change', () => {
  el('stock-adjustment-unit-cost').dataset.edited = '';
  syncStockAdjustmentLocationCost();
});
el('stock-adjustment-unit-cost').addEventListener('input', () => { el('stock-adjustment-unit-cost').dataset.edited = 'true'; });
el('stock-adjustment-form').addEventListener('submit', submitStockAdjustment);
el('edit-stock-product').addEventListener('click', async () => {
  if (!state.stockProductId || !state.session.permissions.includes('catalog.manage')) return;
  await loadProductManagement();
  el('stock-product-dialog').close();
  openProductEditor(state.stockProductId);
});
el('expiry-search').addEventListener('input', renderExpiryDashboard);
el('expiry-filter').addEventListener('change', renderExpiryDashboard);
el('count-button').addEventListener('click', postStockCount);
el('advanced-transfer-form').addEventListener('submit',async(event)=>{
  event.preventDefault();
  const from=el('advanced-transfer-from').value,to=el('advanced-transfer-to').value;
  if(from===to)return toast('Lokasi asal dan tujuan harus berbeda.');
  try{
    await request('/api/multi-outlet/transfers',{method:'POST',headers:{'idempotency-key':crypto.randomUUID()},body:JSON.stringify({
      fromLocationId:from,toLocationId:to,note:el('advanced-transfer-note').value,
      items:[{productId:el('advanced-transfer-product').value,baseQty:Number(el('advanced-transfer-qty').value)}]
    })});
    event.currentTarget.reset();toast('Permintaan transfer dibuat');await loadMultiOutletWorkspace();
  }catch(error){toast(error.message);}
});
el('outlet-price-form').addEventListener('submit',async(event)=>{
  event.preventDefault();
  try{
    await request('/api/multi-outlet/pricing',{method:'PUT',body:JSON.stringify({
      outletId:el('outlet-price-outlet').value,productId:el('outlet-price-product').value,
      customerGroupId:el('outlet-price-group').value,minBaseQty:Number(el('outlet-price-min-qty').value),
      unitPriceBase:Number(el('outlet-price-amount').value),active:true
    })});
    toast('Harga outlet disimpan');await loadMultiOutletWorkspace();await refreshCatalog();
  }catch(error){toast(error.message);}
});
document.querySelectorAll('[data-refresh-multioutlet]').forEach((button)=>button.addEventListener('click',()=>loadMultiOutletWorkspace().catch((error)=>toast(error.message))));
document.addEventListener('click',async(event)=>{
  const transfer=event.target.closest('[data-transfer-action]');
  if(transfer)return advanceTransfer(transfer.dataset.transferId,transfer.dataset.transferAction);
  const promotion=event.target.closest('[data-save-promo-scope]');
  if(promotion){
    const id=promotion.dataset.savePromoScope;
    const outletIds=[...document.querySelectorAll(`[data-promo-outlet="${id}"]:checked`)].map((input)=>input.value);
    try{
      await request(`/api/multi-outlet/promotions/${id}/outlets`,{method:'PUT',body:JSON.stringify({outletIds})});
      toast(outletIds.length?'Cakupan promo disimpan':'Promo berlaku global');await loadMultiOutletWorkspace();await refreshCatalog();
    }catch(error){toast(error.message);}
    return;
  }
  const notification=event.target.closest('[data-notification-action]');
  if(notification){
    try{
      await request(`/api/multi-outlet/notifications/${notification.dataset.notificationId}/${notification.dataset.notificationAction}`,{method:'POST',body:'{}'});
      toast('Notifikasi diperbarui');await loadMultiOutletWorkspace();
    }catch(error){toast(error.message);}
  }
});
const pilotToday=new Date(),pilotEnd=new Date(Date.now()+7*86400000);
el('pilot-start').value=pilotToday.toISOString().slice(0,10);
el('pilot-end').value=pilotEnd.toISOString().slice(0,10);
document.querySelectorAll('[data-refresh-pilot]').forEach((button)=>button.addEventListener('click',()=>loadPilotDashboard().catch((error)=>toast(error.message))));
el('pilot-run-form').addEventListener('submit',async(event)=>{
  event.preventDefault();
  try{
    await request('/api/pilot/runs',{method:'POST',body:JSON.stringify({
      name:el('pilot-name').value,outletId:el('pilot-outlet').value,
      plannedStart:el('pilot-start').value,plannedEnd:el('pilot-end').value,notes:el('pilot-notes').value
    })});
    toast('Periode pilot dimulai');await loadPilotDashboard();
  }catch(error){toast(error.message);}
});
el('pilot-checklist').addEventListener('click',async(event)=>{
  const button=event.target.closest('.save-pilot-check');if(!button)return;
  const row=button.closest('[data-pilot-check]');
  try{
    await request(`/api/pilot/checks/${row.dataset.pilotCheck}`,{method:'PATCH',body:JSON.stringify({
      status:row.querySelector('.pilot-check-status').value,evidence:row.querySelector('.pilot-check-evidence').value
    })});
    toast('Hasil uji disimpan');await loadPilotDashboard();
  }catch(error){toast(error.message);}
});
el('pilot-needs-revision').addEventListener('click',()=>decidePilot('NEEDS_REVISION'));
el('pilot-pass').addEventListener('click',()=>decidePilot('PASSED'));
el('pilot-incident-form').addEventListener('submit',async(event)=>{
  event.preventDefault();
  try{
    await request('/api/pilot/incidents',{method:'POST',body:JSON.stringify({
      outletId:el('incident-outlet').value||null,pilotRunId:state.pilot?.activeRun?.status==='ACTIVE'?state.pilot.activeRun.id:null,
      category:el('incident-category').value,severity:el('incident-severity').value,title:el('incident-title').value,
      description:el('incident-description').value,reproductionSteps:el('incident-steps').value,
      expectedResult:el('incident-expected').value,actualResult:el('incident-actual').value
    })});
    event.currentTarget.reset();toast('Insiden produksi dicatat');await loadPilotDashboard();
  }catch(error){toast(error.message);}
});
el('pilot-incident-list').addEventListener('click',async(event)=>{
  const button=event.target.closest('.resolve-pilot-incident');if(!button)return;
  const note=document.querySelector(`[data-incident-resolution="${button.dataset.incidentId}"]`).value.trim();
  if(note.length<3)return toast('Isi catatan penyelesaian minimal 3 karakter.');
  try{
    await request(`/api/pilot/incidents/${button.dataset.incidentId}`,{method:'PATCH',body:JSON.stringify({status:'RESOLVED',resolutionNote:note})});
    toast('Insiden ditandai selesai');await loadPilotDashboard();
  }catch(error){toast(error.message);}
});
el('recovery-drill-form').addEventListener('submit',async(event)=>{
  event.preventDefault();
  if(!el('recovery-checksum').checked||!el('recovery-procedure').checked)return toast('Verifikasi checksum dan tinjau prosedur terlebih dahulu.');
  try{
    await request('/api/pilot/recovery-drills',{method:'POST',body:JSON.stringify({
      backupExportId:el('recovery-backup').value,result:'PASSED',checksumVerified:true,procedureReviewed:true,notes:el('recovery-notes').value
    })});
    event.currentTarget.reset();toast('Latihan pemulihan dicatat');await loadPilotDashboard();
  }catch(error){toast(error.message);}
});
el('purge-telemetry').addEventListener('click',async()=>{
  try{
    const result=await request('/api/pilot/telemetry/purge',{method:'POST',body:JSON.stringify({retentionDays:30})});
    toast(`${result.deleted??0} event lama dibersihkan`);await loadPilotDashboard();
  }catch(error){toast(error.message);}
});
el('refresh-report').addEventListener('click',()=>{
  if(['sales-products','sales-categories','sales-addons','stock-flow'].includes(state.reportView))return loadSalesAnalysis();
  return state.reportView==='sales'&&state.salesPeriodLevel==='ALL'?loadSalesAllTime():loadReport();
});
el('apply-report-filter').addEventListener('click',()=>{
  if(matchMedia('(max-width:760px)').matches)el('report-filter-panel').open=false;
  if(state.reportView==='sales'){
    const preset=el('report-preset').value;
    if(state.salesPeriodLevel==='ALL'&&preset==='CUSTOM')return loadSalesAllTime();
    state.salesPeriodLevel=preset==='TODAY'?'DAY':preset==='MONTH'?'MONTH':'RANGE';
    state.salesPeriodValue=preset==='TODAY'?storeDateToday():preset==='MONTH'?storeDateToday().slice(0,7):null;
    el('sales-report-detail-title').textContent=salesPeriodTitle(state.salesPeriodLevel,state.salesPeriodValue);
    el('sales-period-nav').querySelectorAll('[data-sales-period]').forEach((button)=>button.classList.toggle('active',button.dataset.salesPeriod===state.salesPeriodLevel));
  }
  loadReport();
});
el('report-preset').addEventListener('change', applyReportPreset);
el('sales-period-nav').addEventListener('click',(event)=>{
  const button=event.target.closest('[data-sales-period]');
  if(!button)return;
  state.salesReportOpen=true;state.salesMetricKey='transactions';syncSalesReportShell();
  selectSalesPeriod(button.dataset.salesPeriod);
});
el('close-sales-report-detail').addEventListener('click',()=>{
  state.salesReportOpen=false;state.salesPeriodTrail=[];syncSalesReportShell();
});
el('report-cards').addEventListener('click',(event)=>{
  const button=event.target.closest('[data-sales-metric]');
  if(!button||state.reportView!=='sales')return;
  state.salesMetricKey=button.dataset.salesMetric;renderSelectedSalesMetric();
});
el('sales-report-filters').addEventListener('change',async(event)=>{
  readSalesReportFilter();
  const calculationSummary=el('sales-report-filters').querySelectorAll('.sales-filter-group summary small')[1];
  calculationSummary.textContent=`${Number(state.salesReportFilter.includeCreditProfit)+Number(state.salesReportFilter.includeCreditRevenue)} pilihan aktif`;
  if(['sales-products','sales-categories','sales-addons','stock-flow'].includes(state.reportView)){await loadSalesAnalysis();return;}
  if(event.target.id==='sales-filter-sort'){renderPosSales();return;}
  el('report-status').classList.add('loading');el('report-status').textContent='Menerapkan filter transaksi...';
  try{
    if(state.salesPeriodLevel==='ALL')await loadSalesAllTime();
    else await loadReport();
  }finally{el('report-status').classList.remove('loading');}
});
el('sales-period-breakdown').addEventListener('click',(event)=>{
  const detail=event.target.closest('[data-sales-drill-level]');
  if(detail){selectSalesPeriod(detail.dataset.salesDrillLevel,detail.dataset.salesDrillValue,{drill:true});return;}
  if(event.target.closest('[data-sales-period-back]')){
    const parent=state.salesPeriodTrail.pop();if(parent)selectSalesPeriod(parent.level,parent.value,{back:true});
  }
});
el('report-outlet').addEventListener('change',updateReportFilterSummary);
el('export-report').addEventListener('click', exportReportCsv);
el('refresh-owner-finance').addEventListener('click',loadOwnerFinance);
el('apply-owner-finance').addEventListener('click',loadOwnerFinance);
el('outlet-expense-form').addEventListener('submit',saveOutletExpense);
el('expense-category-form').addEventListener('submit',saveExpenseCategory);
el('owner-expense-list').addEventListener('click',voidExpense);
el('owner-product-search').addEventListener('input',renderOwnerProductHealth);
el('owner-product-status').addEventListener('change',renderOwnerProductHealth);
el('export-accountant-csv').addEventListener('click',exportAccountantCsv);
document.querySelectorAll('[data-refresh-accounting]').forEach((button)=>button.addEventListener('click',()=>loadAccounting({sync:true}).catch((error)=>toast(error.message))));
el('apply-accounting-filter').addEventListener('click',()=>loadAccounting().catch((error)=>toast(error.message)));
el('apply-accounting-ledger').addEventListener('click',()=>loadAccounting({accountId:el('accounting-ledger-account').value}).catch((error)=>toast(error.message)));
el('add-manual-journal-line').addEventListener('click',()=>{
  const accountId=state.accounting?.accounts?.find((item)=>item.allow_manual)?.id;
  state.manualJournalLines.push({accountId,outletId:null,memo:'',debit:0,credit:0});renderManualJournalLines();
});
el('manual-journal-lines').addEventListener('input',(event)=>{
  const row=event.target.closest('[data-journal-line]');if(!row)return;
  const line=state.manualJournalLines[Number(row.dataset.journalLine)];
  if(event.target.classList.contains('manual-line-memo'))line.memo=event.target.value;
  if(event.target.classList.contains('manual-line-debit')){line.debit=Number(event.target.value||0);if(line.debit>0){line.credit=0;row.querySelector('.manual-line-credit').value='';}}
  if(event.target.classList.contains('manual-line-credit')){line.credit=Number(event.target.value||0);if(line.credit>0){line.debit=0;row.querySelector('.manual-line-debit').value='';}}
  updateManualJournalTotals();
});
el('manual-journal-lines').addEventListener('change',(event)=>{
  const row=event.target.closest('[data-journal-line]');if(!row)return;
  const line=state.manualJournalLines[Number(row.dataset.journalLine)];
  if(event.target.classList.contains('manual-line-account'))line.accountId=event.target.value;
  if(event.target.classList.contains('manual-line-outlet'))line.outletId=event.target.value||null;
});
el('manual-journal-lines').addEventListener('click',(event)=>{
  const button=event.target.closest('.remove-manual-line');if(!button||state.manualJournalLines.length<=2)return;
  state.manualJournalLines.splice(Number(button.closest('[data-journal-line]').dataset.journalLine),1);renderManualJournalLines();
});
el('manual-journal-form').addEventListener('submit',postManualJournal);
el('accounting-journal-list').addEventListener('click',async(event)=>{
  const button=event.target.closest('.reverse-manual-journal');if(!button)return;
  const reason=prompt('Alasan pembalikan jurnal:')?.trim();if(!reason)return;
  try{await request(`/api/accounting/journals/${button.dataset.entryId}/reverse`,{method:'POST',body:JSON.stringify({reason})});toast('Jurnal berhasil dibalik');await loadAccounting();}
  catch(error){toast(error.message);}
});
el('accounting-period-form').addEventListener('submit',async(event)=>{
  event.preventDefault();
  try{
    await request('/api/accounting/periods',{method:'POST',body:JSON.stringify({
      name:el('accounting-period-name').value,startsOn:el('accounting-period-start').value,endsOn:el('accounting-period-end').value
    })});
    event.currentTarget.reset();initializeAccountingDates();toast('Periode akuntansi dibuat');await loadAccounting();
  }catch(error){toast(error.message);}
});
el('accounting-period-list').addEventListener('click',async(event)=>{
  const button=event.target.closest('.close-accounting-period');if(!button)return;
  if(!confirm('Tutup periode ini? Jurnal manual bertanggal dalam periode tidak dapat ditambahkan lagi.'))return;
  try{
    await request('/api/accounting/sync',{method:'POST',body:'{}'});
    await request(`/api/accounting/periods/${button.dataset.periodId}/close`,{method:'POST',body:'{}'});
    toast('Periode berhasil ditutup');await loadAccounting();
  }catch(error){toast(error.message);}
});
el('refresh-users').addEventListener('click', loadUsers);
el('open-create-user').addEventListener('click', openCreateUserDialog);
el('create-user-form').addEventListener('submit', createUser);
el('close-create-user').addEventListener('click', () => el('create-user-dialog').close());
el('cancel-create-user').addEventListener('click', () => el('create-user-dialog').close());
el('user-search').addEventListener('input', renderUsers);
el('user-status-filter').addEventListener('change', renderUsers);
el('new-user-role').addEventListener('change', () => {const role=el('new-user-role').value;renderOutletOptions('new-user-outlets', selectedOutletIds('new-user-outlets', 'CASHIER'),role);renderPermissionOptions('new-user-permissions',permissionDefaults[role],role);});
el('edit-user-role').addEventListener('change', () => {const role=el('edit-user-role').value;renderOutletOptions('edit-user-outlets', selectedOutletIds('edit-user-outlets', 'CASHIER'),role);renderPermissionOptions('edit-user-permissions',permissionDefaults[role],role);});
el('user-list').addEventListener('click', (event) => { const button = event.target.closest('.edit-user'); if (button) openUserEditor(button.closest('[data-user-id]').dataset.userId); });
el('edit-user-dialog').addEventListener('click',(event)=>{const button=event.target.closest('[data-staff-detail-view]');if(button)setStaffDetailView(button.dataset.staffDetailView);});
el('refresh-staff-activity').addEventListener('click',loadStaffActivity);
el('edit-user-form').addEventListener('submit', saveUser);
el('close-user-editor').addEventListener('click', () => el('edit-user-dialog').close());
el('cancel-user-edit').addEventListener('click', () => el('edit-user-dialog').close());
el('open-product-dialog').addEventListener('click', () => openProductEditor());
el('open-price-policy').addEventListener('click',openPricePolicy);
el('open-import-products').addEventListener('click',()=>openProductImportWorkspace('PRODUCTS',{mode:'CREATE_ONLY'}));
el('open-export-products').addEventListener('click',()=>openProductImportWorkspace('PRODUCTS',{mode:'UPDATE_ONLY'}));
el('back-to-products').addEventListener('click',()=>showPage('products'));
el('open-product-data-types').addEventListener('click',()=>el('product-data-types-dialog').showModal());
el('close-product-data-types').addEventListener('click',()=>el('product-data-types-dialog').close());
el('product-data-types-dialog').addEventListener('click',(event)=>{
  const button=event.target.closest('[data-product-import-kind]');if(button)openProductImportWorkspace(button.dataset.productImportKind,{mode:'UPDATE_ONLY'});
});
el('close-price-policy').addEventListener('click',()=>el('price-policy-dialog').close());
el('preview-price-policy').addEventListener('click',previewPricePolicy);
el('price-policy-form').addEventListener('submit',applyPricePolicy);
el('price-policy-form').addEventListener('input',invalidatePricePolicyPreview);
el('price-policy-form').addEventListener('change',invalidatePricePolicyPreview);
el('add-price-policy-rule').addEventListener('click',()=>{
  readPricePolicyInput();
  const group=customCustomerGroups()[0];if(!group)return;
  state.pricePolicyRules.push({customerGroupId:group.id,minBaseQty:1,discountAmount:500});
  renderPricePolicyRules();invalidatePricePolicyPreview();
});
el('price-policy-rules').addEventListener('click',(event)=>{
  const button=event.target.closest('.remove-price-policy-rule');if(!button)return;
  const index=Number(button.closest('.price-policy-rule').dataset.index);
  readPricePolicyInput();if(state.pricePolicyRules.length>1)state.pricePolicyRules.splice(index,1);
  renderPricePolicyRules();invalidatePricePolicyPreview();
});
el('cancel-product').addEventListener('click', () => el('product-dialog').close());
el('close-product-dialog').addEventListener('click', () => el('product-dialog').close());
el('add-product-unit').addEventListener('click',()=>{state.productUnitsDraft.push({id:null,name:'',factor:12,barcode:''});renderProductUnitEditor();});
el('product-units-editor').addEventListener('input',(event)=>{
  const row=event.target.closest('.product-unit-row');if(!row)return;const unit=state.productUnitsDraft[Number(row.dataset.index)];
  if(event.target.classList.contains('unit-name'))unit.name=event.target.value;
  if(event.target.classList.contains('unit-factor'))unit.factor=Number(event.target.value);
  if(event.target.classList.contains('unit-barcode'))unit.barcode=event.target.value;
});
el('product-units-editor').addEventListener('click',(event)=>{
  const button=event.target.closest('.remove-product-unit');if(!button)return;
  state.productUnitsDraft.splice(Number(button.closest('.product-unit-row').dataset.index),1);renderProductUnitEditor();
});
el('product-price-tiers').addEventListener('click',(event)=>{
  const card=event.target.closest('.product-price-tier-card');if(!card)return;
  readProductPriceTierDraft();
  const tiers=state.productPriceTiers[card.dataset.groupId];
  if(event.target.closest('.add-product-price-tier')){
    const nextMinimum=Math.max(3,...tiers.map((tier)=>Number(tier.minBaseQty)+1));
    tiers.push({minBaseQty:nextMinimum,unitPriceBase:''});renderProductPriceTierEditor();
  }
  const remove=event.target.closest('.remove-product-price-tier');
  if(remove){
    const index=[...card.querySelectorAll('.product-price-tier-row')].indexOf(remove.closest('.product-price-tier-row'));
    if(index>0)tiers.splice(index,1);
    renderProductPriceTierEditor();
  }
});
el('product-admin-search').addEventListener('input',()=>{state.productAdminPage=1;renderProductTable();});
el('product-admin-status').addEventListener('change',()=>{state.productAdminPage=1;renderProductTable();});
el('delete-selected-products').addEventListener('click',deleteSelectedProducts);
el('print-selected-product-labels').addEventListener('click',openProductLabelDialog);
el('close-product-label-dialog').addEventListener('click',()=>el('product-label-dialog').close());
el('cancel-product-label').addEventListener('click',()=>el('product-label-dialog').close());
el('product-label-form').addEventListener('submit',printProductLabels);
el('product-label-copy-list').addEventListener('input',(event)=>{
  const input=event.target.closest('.product-label-item-copies');if(!input)return;
  const productId=input.closest('[data-product-id]')?.dataset.productId;if(!productId)return;
  state.productLabelCopies.set(productId,Math.min(9999,Math.max(0,Math.floor(Number(input.value)||0))));
});
el('product-label-all-one').addEventListener('click',()=>setProductLabelCopies('ONE'));
el('product-label-use-stock').addEventListener('click',()=>setProductLabelCopies('STOCK'));
el('product-label-form').addEventListener('input',()=>renderProductLabelSheet(el('product-label-preview'),{preview:true}));
el('product-label-form').addEventListener('change',(event)=>{
  if(event.target.id==='product-label-preset')return applyProductLabelPreset();
  if(event.target.closest('.product-label-options'))el('product-label-preset').value='CUSTOM';
  renderProductLabelSheet(el('product-label-preview'),{preview:true});
});
window.addEventListener('afterprint',()=>el('product-label-print-root').replaceChildren());
el('export-products-xlsx').addEventListener('click',exportProductsXlsx);
['export-product-category','export-product-brand','export-product-status','export-product-sort'].forEach((id)=>el(id).addEventListener('change',updateProductExportCount));
el('product-table').addEventListener('click',(event)=>{
  const pageButton=event.target.closest('[data-product-page]');
  if(pageButton){state.productAdminPage+=Number(pageButton.dataset.productPage);state.productActionId=null;renderProductTable();return;}
  const row=event.target.closest('[data-product-id]');if(!row)return;
  if(event.target.closest('.edit-product'))return openProductEditor(row.dataset.productId);
  const toggle=event.target.closest('.toggle-product');
  if(toggle){state.productActionId=null;return toggleProductStatus(row.dataset.productId,toggle.dataset.active==='true');}
  if(event.target.closest('input,button,a,select,label')||row.classList.contains('product-action-row'))return;
  state.productActionId=state.productActionId===row.dataset.productId?null:row.dataset.productId;
  renderProductTable();
});
el('product-table').addEventListener('keydown',(event)=>{
  if(!['Enter',' '].includes(event.key)||event.target.closest('input,button,a,select'))return;
  const row=event.target.closest('.product-admin-row[data-product-id]');if(!row)return;
  event.preventDefault();
  state.productActionId=state.productActionId===row.dataset.productId?null:row.dataset.productId;
  renderProductTable();
  document.querySelector(`#product-table .product-admin-row[data-product-id="${CSS.escape(row.dataset.productId)}"]`)?.focus();
});
el('product-table').addEventListener('change',(event)=>{
  if(event.target.id==='select-all-products'){
    const checked=event.target.checked;
    document.querySelectorAll('#product-table [data-product-id]').forEach((row)=>{
      if(checked)state.selectedProductIds.add(row.dataset.productId);else state.selectedProductIds.delete(row.dataset.productId);
    });
    renderProductTable();return;
  }
  const checkbox=event.target.closest('.select-product');if(!checkbox)return;
  const productId=checkbox.closest('[data-product-id]')?.dataset.productId;if(!productId)return;
  if(checkbox.checked)state.selectedProductIds.add(productId);else state.selectedProductIds.delete(productId);
  renderProductTable();
});
el('product-form').addEventListener('submit', saveProduct);
el('new-image-file').addEventListener('change',(event)=>{
  const file=event.target.files?.[0];if(!file)return;
  if(!file.type.match(/^image\/(png|jpeg|webp)$/))return el('product-error').textContent='Pilih foto PNG, JPEG, atau WebP.';
  if(state.productImagePreviewUrl?.startsWith('blob:'))URL.revokeObjectURL(state.productImagePreviewUrl);
  state.productImageFile=file;state.productImagePreviewUrl=URL.createObjectURL(file);
  el('new-image-url').value='';el('product-error').textContent='';
  renderProductPhotoPreview(state.productImagePreviewUrl);
});
el('new-image-url').addEventListener('input',(event)=>{
  state.productImageFile=null;state.productImagePreviewUrl=event.target.value.trim();
  renderProductPhotoPreview(state.productImagePreviewUrl);
});
el('remove-product-image').addEventListener('click',()=>{
  if(state.productImagePreviewUrl?.startsWith('blob:'))URL.revokeObjectURL(state.productImagePreviewUrl);
  state.productImageFile=null;state.productImagePreviewUrl='';
  el('new-image-file').value='';el('new-image-url').value='';
  renderProductPhotoPreview();
});
el('download-import-template').addEventListener('click', downloadImportTemplate);
el('import-file').addEventListener('change', inspectImportFile);
el('import-capital-file').addEventListener('change',()=>{
  const file=el('import-capital-file').files[0];
  el('import-capital-file-name').textContent=file?.name??'Belum ada file dipilih';
  if(el('import-file').files[0])inspectImportFile();
});
el('import-kind').addEventListener('change', () => {
  el('import-file').value = '';
  el('import-file-name').textContent = 'Belum ada file dipilih';
  el('import-capital-file').value='';el('import-capital-file-name').textContent='Belum ada file dipilih';
  syncImportKindUi();
  syncProductImportModeUi();
  resetImportPreview('Unduh dan gunakan template Excel untuk jenis data yang dipilih.');
});
el('import-source').addEventListener('change',()=>{
  syncImportSourceUi();
  if(el('import-file').files[0])inspectImportFile();
});
el('kaspin-code-as-barcode').addEventListener('change',()=>{if(el('import-file').files[0])inspectImportFile();});
el('import-location').addEventListener('change', () => { if (el('import-file').files[0]) inspectImportFile(); });
el('commit-import').addEventListener('click', commitImport);
el('refresh-imports').addEventListener('click', loadImportHistory);
el('create-backup').addEventListener('click', createBackup);
el('verify-backup-file').addEventListener('change', verifyBackupFile);
el('refresh-backups').addEventListener('click', loadBackupHistory);
el('refresh-settings').addEventListener('click', loadSettingsWorkspace);
el('refresh-system-health').addEventListener('click', loadSystemHealth);
document.querySelectorAll('[data-maintenance-mode]').forEach((button)=>button.addEventListener('click',()=>showDataMaintenanceMode(button.dataset.maintenanceMode)));
el('data-reset-form').addEventListener('change',(event)=>{if(event.target.matches('input[name="data-reset-scope"]'))syncDataResetForm(event);});
el('request-data-reset-otp').addEventListener('click',requestDataResetOtp);
el('data-reset-form').addEventListener('submit',executeDataReset);
el('data-restore-file').addEventListener('change',inspectDataRestoreFile);
el('request-data-restore-otp').addEventListener('click',requestDataRestoreOtp);
el('data-restore-form').addEventListener('submit',executeDataRestore);
el('install-app').addEventListener('click', installPwa);
el('business-settings-form').addEventListener('submit', saveBusinessSettings);
el('receipt-settings-form').addEventListener('submit',saveReceiptSettings);
el('receipt-settings-form').addEventListener('input',(event)=>{
  if(event.target.id==='setting-receipt-logo-file')return;
  if(event.target.id==='setting-receipt-logo-size')el('setting-receipt-logo-size-value').textContent=event.target.value;
  renderReceiptDesignPreview();
});
el('setting-receipt-logo-file').addEventListener('change',async(event)=>{
  el('receipt-settings-error').textContent='';
  try{
    const file=event.target.files[0];if(!file)return;
    el('setting-receipt-logo-url').value=await receiptLogoFromFile(file);
    el('receipt-show-logo').checked=true;renderReceiptDesignPreview();
  }catch(error){el('receipt-settings-error').textContent=error.message;}finally{event.target.value='';}
});
el('remove-receipt-logo').addEventListener('click',()=>{
  el('setting-receipt-logo-url').value='';el('receipt-show-logo').checked=false;renderReceiptDesignPreview();
});
el('reset-receipt-layout').addEventListener('click',()=>populateReceiptLayoutControls(defaultReceiptLayout));
el('new-outlet-setting').addEventListener('click', newOutletEditor);
el('outlet-settings-form').addEventListener('submit', saveOutletSettings);
el('settings-outlet-list').addEventListener('click',(event)=>{const row=event.target.closest('.edit-setting-outlet');if(row)editOutletSetting(row.dataset.outletId);});
el('new-location-setting').addEventListener('click', newLocationEditor);
el('location-settings-form').addEventListener('submit', saveLocationSettings);
el('settings-location-list').addEventListener('click',(event)=>{const row=event.target.closest('.edit-setting-location');if(row)editLocationSetting(row.dataset.locationId);});
el('device-settings-form').addEventListener('submit', saveDeviceSettings);
el('setting-device-paper').addEventListener('change',()=>{
  state.deviceSettings.paperWidth=Number(el('setting-device-paper').value);
  el('setting-receipt-paper').value=el('setting-device-paper').value;
  renderReceiptDesignPreview();
});
el('setting-receipt-paper').addEventListener('change',()=>{
  state.deviceSettings.paperWidth=Number(el('setting-receipt-paper').value);
  el('setting-device-paper').value=el('setting-receipt-paper').value;
  renderReceiptDesignPreview();
});
el('connect-printer').addEventListener('click', connectReceiptPrinter);
el('test-printer').addEventListener('click', testReceiptPrinter);
el('disconnect-printer').addEventListener('click', disconnectReceiptPrinter);
el('new-customer').addEventListener('click',()=>openCustomerEditor());
el('customer-form').addEventListener('submit',saveCustomer);
el('close-customer-dialog').addEventListener('click',()=>el('customer-dialog').close());
el('cancel-customer-dialog').addEventListener('click',()=>el('customer-dialog').close());
el('manage-customer-groups').addEventListener('click',openCustomerGroupDialog);
el('customer-group-form').addEventListener('submit',saveCustomerGroup);
el('close-customer-group-dialog').addEventListener('click',()=>el('customer-group-dialog').close());
el('cancel-customer-group-dialog').addEventListener('click',()=>el('customer-group-dialog').close());
el('customer-credit-enabled').addEventListener('change',()=>el('customer-credit-fields').classList.toggle('hidden',!el('customer-credit-enabled').checked));
el('customer-account-search').addEventListener('input',renderRelations);
el('customer-list').addEventListener('click',(event)=>{
  const card=event.target.closest('[data-customer-id]');if(!card)return;
  if(event.target.closest('.customer-statement'))openCustomerStatement(card.dataset.customerId);
  if(event.target.closest('.edit-customer'))openCustomerEditor(card.dataset.customerId);
});
el('close-customer-statement').addEventListener('click',()=>el('customer-statement-dialog').close());
el('customer-payment-form').addEventListener('submit',recordCustomerPayment);
el('customer-payment-method').addEventListener('change',()=>el('customer-payment-reference-wrap').classList.toggle('hidden',el('customer-payment-method').value==='CASH'));
el('save-supplier').addEventListener('click', saveSupplier);
el('supplier-list').addEventListener('click',(event)=>{const row=event.target.closest('[data-supplier-id]');if(row&&event.target.closest('.supplier-statement'))openSupplierStatement(row.dataset.supplierId);});
el('close-supplier-statement').addEventListener('click',()=>el('supplier-statement-dialog').close());
el('supplier-payment-form').addEventListener('submit',recordSupplierPayment);
el('supplier-payment-method').addEventListener('change',()=>el('supplier-payment-reference-wrap').classList.toggle('hidden',el('supplier-payment-method').value==='CASH'));
el('promotion-form').addEventListener('submit', publishPromotion);
el('loyalty-settings-form').addEventListener('submit',saveLoyaltySettings);
document.querySelectorAll('[data-loyalty-view]').forEach((button)=>button.addEventListener('click',()=>showLoyaltyView(button.dataset.loyaltyView)));
el('open-voucher-form').addEventListener('click',()=>openVoucherForm());
el('close-voucher-form').addEventListener('click',()=>el('voucher-form-dialog').close());
el('open-receipt-voucher-campaign').addEventListener('click',()=>openReceiptVoucherCampaign());
el('close-receipt-voucher-campaign').addEventListener('click',()=>el('receipt-voucher-campaign-dialog').close());
el('voucher-form').addEventListener('submit',publishVoucher);
el('receipt-voucher-campaign-form').addEventListener('submit',publishReceiptVoucherCampaign);
el('voucher-list').addEventListener('click',(event)=>{const card=event.target.closest('[data-voucher-id]');if(!card)return;const voucher=state.loyalty.vouchers.find((item)=>item.id===card.dataset.voucherId);if(event.target.closest('.edit-voucher'))openVoucherForm(voucher);if(event.target.closest('.delete-voucher'))deleteVoucher(card.dataset.voucherId);});
el('receipt-voucher-campaign-list').addEventListener('click',(event)=>{const card=event.target.closest('[data-receipt-campaign-id]');if(!card)return;const campaign=state.loyalty.receiptCampaigns.find((item)=>item.id===card.dataset.receiptCampaignId);if(event.target.closest('.edit-receipt-voucher'))openReceiptVoucherCampaign(campaign);if(event.target.closest('.delete-receipt-voucher'))deleteReceiptVoucherCampaign(card.dataset.receiptCampaignId);});
el('simulate-promo').addEventListener('click', simulatePromotion);
el('promo-type').addEventListener('change',syncPromotionForm);
el('promo-target-type').addEventListener('change',syncPromotionForm);
el('promo-repeat-mode').addEventListener('change',syncPromotionForm);
['promo-code','promo-name','promo-category','promo-brand','promo-min-qty','promo-min-basket','promo-value','promo-max','promo-buy-qty','promo-free-qty','promo-repeat-cap','promo-priority','promo-limit-total','promo-limit-customer','promo-starts','promo-ends','promo-time-start','promo-time-end'].forEach((id)=>el(id).addEventListener('input',updatePromoSummary));
['promo-target-product','promo-customer-group','promo-reward-product','promo-bundle-product-a','promo-bundle-product-b','promo-stackable'].forEach((id)=>el(id).addEventListener('change',updatePromoSummary));
el('promo-days').addEventListener('change',updatePromoSummary);
el('promo-status-filter').addEventListener('change',renderPromotionList);
el('promotion-list').addEventListener('click',(event)=>{const card=event.target.closest('[data-promo-id]');if(!card)return;if(event.target.closest('.edit-promotion'))editPromotion(card.dataset.promoId);if(event.target.closest('.delete-promotion'))deletePromotion(card.dataset.promoId);});
el('open-shift').addEventListener('click', openShift);
el('cash-movement').addEventListener('click', addCashMovement);
el('close-shift').addEventListener('click', closeShift);
el('refresh-workforce').addEventListener('click',loadWorkforceOverview);
el('attendance-action').addEventListener('click',clockAttendance);
el('schedule-form').addEventListener('submit',saveEmployeeSchedule);
el('target-form').addEventListener('submit',saveEmployeeTarget);
el('refresh-approvals').addEventListener('click',loadApprovals);
el('approval-request-form').addEventListener('submit',submitApprovalRequest);
el('approval-policy-form').addEventListener('submit',saveApprovalPolicy);
el('approval-request-list').addEventListener('click',decideApproval);
el('refresh-workforce-activity').addEventListener('click',loadWorkforceActivity);
el('refresh-reconciliations').addEventListener('click',loadWorkforceReconciliations);
window.addEventListener('error',()=>reportClientTelemetry('CLIENT_ERROR','/api/client/runtime'));
window.addEventListener('unhandledrejection',()=>reportClientTelemetry('CLIENT_ERROR','/api/client/runtime'));
window.addEventListener('online', () => { el('network-dot').classList.remove('offline'); el('network-status').textContent = 'Online'; syncQueue(); });
window.addEventListener('offline', () => { el('network-dot').classList.add('offline'); el('network-status').textContent = 'Offline'; });
window.addEventListener('storage', (event) => {
  if (event.key === 'pos_owner_context_id') {
    state.ownerContextId = event.newValue || null;
    localStorage.removeItem('pos_bootstrap_cache');
    location.reload();
    return;
  }
  if (!isAuthStorageEvent(event)) return;
  const auth = loadAuth();
  state.token = auth.token;
  state.refreshToken = auth.refreshToken;
  state.expiresAt = auth.expiresAt;
  if (!auth.token && !auth.refreshToken) {
    state.session = null;
    localStorage.removeItem('pos_bootstrap_cache');
    location.reload();
  }
});
setInterval(() => { el('clock').textContent = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date()); }, 1000);
updateQueueCount();
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallAppControl();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateInstallAppControl();
  toast('Kasir Nusa berhasil dipasang di perangkat ini.');
});
window.addEventListener('kasirnusa:barcode', (event) => handleNativeScannerBarcode(event.detail?.value));
updateInstallAppControl();
restoreGrantedPrinter().then(()=>renderPrinterStatus()).catch(()=>renderPrinterStatus('Izin printer perlu dipilih ulang'));
if (typeof navigator !== 'undefined' && navigator.serial) {
  navigator.serial.addEventListener('connect', async () => { await restoreGrantedPrinter(); renderPrinterStatus(); });
  navigator.serial.addEventListener('disconnect', () => renderPrinterStatus('Koneksi printer terputus'));
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js');
async function restoreAppSession() {
  if (state.token || state.refreshToken) return bootstrap();
  try {
    await refreshSession();
    await bootstrap();
  } catch {
    el('session-view').classList.add('hidden');
    el('login-view').classList.remove('hidden');
    el('app-view').classList.add('hidden');
  }
}

setLoginPortal(state.loginPortal);
if(matchMedia('(max-width:760px)').matches)el('report-filter-panel').open=false;
updateReportFilterSummary();
restoreAppSession();
