import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { compareCost, quoteBasket } from '../packages/domain/src/pricing.mjs';
import { summarizeExpiryBatches, todayInTimeZone } from '../packages/domain/src/expiry.mjs';
import { applySaleAdjustment, normalizeSaleAdjustment, saleAdjustmentFingerprintPayload } from '../packages/domain/src/sale-adjustment.mjs';
import { applyVoucher } from '../packages/domain/src/loyalty.mjs';
import { calculateEmployeeCommission } from '../packages/domain/src/employee-operations.mjs';
import { validateJournalLines } from '../packages/domain/src/ledger.mjs';
import { evaluateSafePricePolicy, normalizeSafePricePolicy } from '../packages/domain/src/safe-price-policy.mjs';
import { buildPushPayload } from '@block65/webcrypto-web-push';

const PERMISSIONS = {
  OWNER: ['pos.sell','purchasing.view_cost','purchasing.receive','inventory.manage','sales.return','catalog.manage','promotion.manage','report.transactions','report.view','audit.view','identity.manage_staff','identity.manage','workforce.self','workforce.manage','approval.manage','finance.owner','multioutlet.view','multioutlet.manage','pilot.manage','sale.adjust','sale.void','device.configure'],
  ADMIN: ['pos.sell','purchasing.view_cost','purchasing.receive','inventory.manage','sales.return','catalog.manage','promotion.manage','report.transactions','report.view','audit.view','identity.manage_staff','workforce.self','workforce.manage','approval.manage','multioutlet.view','multioutlet.manage','sale.adjust','sale.void'],
  MANAGER: ['pos.sell','inventory.manage','sales.return','catalog.manage','promotion.manage','report.transactions','report.view','audit.view','workforce.self','workforce.manage','approval.manage','multioutlet.view','multioutlet.manage'],
  CASHIER: ['pos.sell','workforce.self','device.configure'],
  PURCHASING: ['purchasing.view_cost','purchasing.receive','workforce.self'],
  WAREHOUSE: ['inventory.manage','workforce.self']
};
const ASSIGNABLE_PERMISSIONS=new Set([
  'pos.sell','purchasing.view_cost','purchasing.receive','inventory.manage',
  'sales.return','catalog.manage','promotion.manage','report.transactions','report.view','audit.view',
  'workforce.self','workforce.manage','approval.manage','multioutlet.view',
  'multioutlet.manage','sale.adjust','sale.void'
]);

function effectivePermissions(profile) {
  if(profile?.role==='OWNER')return [...PERMISSIONS.OWNER];
  if(Array.isArray(profile?.custom_permissions)){
    const permissions=profile.custom_permissions.filter((permission)=>ASSIGNABLE_PERMISSIONS.has(permission));
    // Admin selalu dapat mengelola akun staff, tetapi izin ini tidak dapat
    // diteruskan kepada peran operasional melalui daftar izin kustom.
    if(permissions.includes('report.view'))permissions.push('report.transactions');
    if(profile?.role==='ADMIN')permissions.push('identity.manage_staff');
    if(profile?.role==='CASHIER')permissions.push('device.configure');
    return [...new Set(permissions)];
  }
  return [...(PERMISSIONS[profile?.role]??[])];
}

function normalizedAssignablePermissions(value,role) {
  if(role==='OWNER')return null;
  if(!Array.isArray(value))return [...(PERMISSIONS[role]??[]).filter((permission)=>ASSIGNABLE_PERMISSIONS.has(permission))];
  const permissions=[...new Set(value.map(String))];
  if(permissions.some((permission)=>!ASSIGNABLE_PERMISSIONS.has(permission))){
    throw Object.assign(new Error('Hak akses pengguna tidak valid'),{status:400});
  }
  return permissions;
}

const BACKUP_TABLES = [
  'tenants','profiles','outlets','stock_locations','user_outlets',
  'customer_price_groups','customers','loyalty_settings','customer_tiers','customer_point_entries','vouchers','voucher_redemptions','receipt_voucher_campaigns','customer_account_entries','customer_payment_receipts','customer_payment_allocations','suppliers','supplier_bills','supplier_payable_entries','supplier_payment_receipts','supplier_payment_allocations','product_families','product_family_barcodes','products','product_variant_options','product_units','price_rules','promotions','promotion_versions','promotion_redemptions',
  'shifts','cash_movements','shift_reconciliations','sales','sale_items','payments','parked_sales','sale_adjustment_authorizations',
  'employee_schedules','attendance_records','employee_targets','approval_policies','approval_requests','restock_approval_requests',
  'backup_exports','pilot_runs','pilot_check_results','production_incidents','recovery_drills',
  'expense_categories','outlet_expenses','chart_of_accounts','accounting_periods','journal_entries','journal_lines',
  'purchase_planning_settings','restock_policies','purchase_orders','purchase_order_items','purchase_receipts','purchase_receipt_items','supplier_returns','supplier_return_items',
  'stock_balances','stock_ledger','inventory_batches','inventory_batch_movements','sale_stock_allocations','stock_adjustments',
  'stock_transfers','stock_transfer_items','transfer_requests','transfer_request_items','transfer_request_batches','outlet_price_overrides','promotion_outlets','operational_notifications','stock_counts','stock_count_items',
  'customer_returns','customer_return_items','customer_refunds',
  'pos_devices','sync_commands','document_sequences','audit_logs','import_jobs'
];
const RESTORE_TABLES = [
  'suppliers','product_families','product_family_barcodes','products','product_variant_options','product_units','price_rules','customer_tiers','customers','loyalty_settings',
  'promotions','promotion_versions','promotion_outlets','receipt_voucher_campaigns',
  'employee_schedules','attendance_records','employee_targets','approval_policies','approval_requests','restock_approval_requests',
  'shifts','cash_movements','shift_reconciliations','sales','vouchers','parked_sales',
  'sale_adjustment_authorizations','sale_items','payments','promotion_redemptions','voucher_redemptions',
  'customer_point_entries','customer_returns','customer_return_items','customer_refunds',
  'customer_account_entries','customer_payment_receipts','customer_payment_allocations',
  'purchase_orders','purchase_order_items','purchase_receipts','purchase_receipt_items',
  'inventory_batches','stock_balances','stock_ledger','inventory_batch_movements','sale_stock_allocations',
  'stock_adjustments','supplier_bills','supplier_payable_entries','supplier_payment_receipts',
  'supplier_payment_allocations','supplier_returns','supplier_return_items','stock_transfers',
  'stock_transfer_items','transfer_requests','transfer_request_items','transfer_request_batches',
  'stock_counts','stock_count_items','restock_policies','outlet_price_overrides','accounting_periods',
  'journal_entries','journal_lines','outlet_expenses','sync_commands','import_jobs'
];
const OPTIONAL_CATALOG_TABLES = new Set(['product_families','product_family_barcodes','product_variant_options']);

const env = () => ({
  url: process.env.SUPABASE_URL?.replace(/\/$/, ''),
  anon: process.env.SUPABASE_ANON_KEY,
  service: process.env.SUPABASE_SERVICE_ROLE_KEY,
  platformAdminIds: process.env.PLATFORM_ADMIN_USER_IDS ?? '',
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
  cloudflareApiToken: process.env.CLOUDFLARE_ANALYTICS_TOKEN ?? '',
  cloudflareScriptName: process.env.CLOUDFLARE_SCRIPT_NAME ?? 'kasir-nusa-pos',
  cloudflarePlan: String(process.env.CLOUDFLARE_WORKERS_PLAN ?? 'FREE').toUpperCase(),
  supabaseStorageLimitBytes: Math.max(1,Number(process.env.SUPABASE_STORAGE_LIMIT_BYTES)||1073741824),
  paymentCredentialsMasterKey: process.env.PAYMENT_CREDENTIALS_MASTER_KEY ?? '',
  webPushPublicKey: process.env.WEB_PUSH_VAPID_PUBLIC_KEY ?? '',
  webPushPrivateKey: process.env.WEB_PUSH_VAPID_PRIVATE_KEY ?? '',
  webPushSubject: process.env.WEB_PUSH_VAPID_SUBJECT ?? 'https://nusapos.my.id'
});

function requireTenantOwner(session) {
  if(!session){const error=new Error('Sesi tidak valid');error.status=401;throw error;}
  if(session.profile?.role!=='OWNER'){
    const error=new Error('Pengaturan pembayaran hanya dapat dikelola Owner usaha');error.status=403;throw error;
  }
}

function paymentCredentialsMasterKey() {
  const encoded=String(env().paymentCredentialsMasterKey??'').trim();
  let bytes;
  try{bytes=Buffer.from(encoded,'base64');}catch{bytes=Buffer.alloc(0);}
  if(bytes.length!==32){
    const error=new Error('Penyimpanan kredensial pembayaran belum dikonfigurasi oleh Platform Admin');
    error.status=503;throw error;
  }
  return bytes;
}

async function paymentCryptoKey() {
  return globalThis.crypto.subtle.importKey('raw',paymentCredentialsMasterKey(),{name:'AES-GCM'},false,['encrypt','decrypt']);
}

async function encryptPaymentCredential(value) {
  const iv=randomBytes(12),key=await paymentCryptoKey();
  const ciphertext=await globalThis.crypto.subtle.encrypt({name:'AES-GCM',iv},key,Buffer.from(String(value),'utf8'));
  return {ciphertext:Buffer.from(ciphertext).toString('base64'),iv:iv.toString('base64'),keyVersion:1};
}

async function decryptPaymentCredential(account) {
  try{
    const key=await paymentCryptoKey(),iv=Buffer.from(String(account.server_key_iv??''),'base64');
    if(iv.length!==12||!account.server_key_ciphertext)throw new Error('ciphertext tidak lengkap');
    const plaintext=await globalThis.crypto.subtle.decrypt({name:'AES-GCM',iv},key,Buffer.from(account.server_key_ciphertext,'base64'));
    return Buffer.from(plaintext).toString('utf8');
  }catch(error){
    if(error?.status)throw error;
    throw Object.assign(new Error('Kredensial pembayaran tenant tidak dapat dibuka; hubungi Platform Admin'),{status:503});
  }
}

async function midtransAccount(tenantId,environment='SANDBOX',{required=true}={}) {
  const rows=await rest('payment_gateway_accounts',`tenant_id=eq.${encodeURIComponent(tenantId)}&provider=eq.MIDTRANS&environment=eq.${environment}&select=*&limit=1`);
  const account=rows[0];
  if(!account||account.status==='DISABLED'){
    if(!required)return null;
    throw Object.assign(new Error(`Akun Midtrans ${environment} belum dihubungkan oleh Owner usaha`),{status:503});
  }
  const serverKey=await decryptPaymentCredential(account);
  const validPrefix=environment==='SANDBOX'
    ? (serverKey.startsWith('SB-Mid-server-')||serverKey.startsWith('Mid-server-'))
    : serverKey.startsWith('Mid-server-');
  if(!validPrefix)throw Object.assign(new Error(`Server Key Midtrans tidak cocok untuk ${environment}`),{status:503});
  return {...account,serverKey,baseUrl:environment==='SANDBOX'?'https://api.sandbox.midtrans.com':'https://api.midtrans.com'};
}

function safeSecretEqual(left,right) {
  const a=Buffer.from(String(left??'')),b=Buffer.from(String(right??''));
  return a.length===b.length&&a.length>0&&timingSafeEqual(a,b);
}

function sanitizedMidtransPayload(payload={}) {
  const allowed=['status_code','status_message','transaction_id','order_id','merchant_id','gross_amount','currency','payment_type','transaction_time','settlement_time','expiry_time','transaction_status','fraud_status','acquirer','issuer','reference_id','channel_response_code','channel_response_message'];
  const sanitized=Object.fromEntries(allowed.filter((key)=>payload?.[key]!==undefined).map((key)=>[key,String(payload[key]).slice(0,300)]));
  const actions=Array.isArray(payload?.actions)?payload.actions:[];
  if(actions.length){
    sanitized.action_names=actions.map((item)=>String(item?.name??'').slice(0,80)).filter(Boolean).slice(0,10);
    sanitized.action_hosts=actions.map((item)=>{try{return new URL(String(item?.url??'')).hostname;}catch{return '';}}).filter(Boolean).slice(0,10);
  }
  if(Array.isArray(payload?.error_messages))sanitized.error_messages=payload.error_messages.map((item)=>String(item).slice(0,200)).slice(0,10);
  sanitized.response_keys=Object.keys(payload&&typeof payload==='object'?payload:{}).filter((key)=>payload[key]!==undefined&&!['actions','signature_key'].includes(key)).slice(0,30);
  return sanitized;
}

function midtransResponseDiagnostic(payload={}) {
  const safe=sanitizedMidtransPayload(payload);
  const values=[
    `kode ${safe.status_code??'tidak ada'}`,
    `pesan ${safe.status_message??safe.error_messages?.join(' / ')??'tidak ada'}`,
    `status ${safe.transaction_status??'tidak ada'}`,
    `tipe ${safe.payment_type??'tidak ada'}`,
    `aksi ${safe.action_names?.join(', ')||'tidak ada'}`,
    `host ${safe.action_hosts?.join(', ')||'tidak ada'}`,
    `kolom ${safe.response_keys?.join(', ')||'tidak ada'}`
  ];
  return values.join('; ').slice(0,700);
}

function midtransValidationError(message,payload) {
  const details=sanitizedMidtransPayload(payload);
  return Object.assign(new Error(`${message}. Respons Midtrans: ${midtransResponseDiagnostic(payload)}`),{status:409,details});
}

function midtransPayloadHash(payload={}) {
  return createHash('sha256').update(JSON.stringify(sanitizedMidtransPayload(payload))).digest('hex');
}

function midtransStatus(value) {
  return ({pending:'PENDING',settlement:'SETTLEMENT',expire:'EXPIRED',deny:'DENIED',cancel:'CANCELLED'})[String(value??'').toLowerCase()]??'ERROR';
}

function midtransQrUrl(payload={}) {
  const action=(Array.isArray(payload.actions)?payload.actions:[]).find((item)=>['generate-qr-code-v2','generate-qr-code'].includes(item?.name));
  if(!action?.url)return null;
  try{
    const url=new URL(action.url);
    return url.protocol==='https:'&&/(^|\.)(midtrans\.com|veritrans\.co\.id)$/i.test(url.hostname)?url.toString():null;
  }catch{return null;}
}

async function midtransRequest(config,path,{method='GET',body}={}) {
  const response=await fetch(`${config.baseUrl}${path}`,{
    method,headers:{authorization:`Basic ${Buffer.from(`${config.serverKey}:`).toString('base64')}`,'content-type':'application/json','accept':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)
  });
  const text=await response.text();
  let payload={};
  try{payload=text?JSON.parse(text):{};}catch{throw Object.assign(new Error('Respons Midtrans tidak dapat dibaca'),{status:502});}
  const payloadStatusCode=Number(payload?.status_code);
  if(!response.ok||(Number.isFinite(payloadStatusCode)&&payloadStatusCode>=400)){
    const error=new Error(String(payload.status_message??payload.error_messages?.[0]??`Midtrans ${response.status}`).slice(0,240));
    const observedStatus=Number.isFinite(payloadStatusCode)?payloadStatusCode:response.status;
    error.status=observedStatus>=500?502:Math.max(400,Math.min(observedStatus,499));error.details=sanitizedMidtransPayload(payload);throw error;
  }
  return payload;
}

function validateMidtransIntentStatus(intent,payload,{identityVerifiedByLookup=false}={}) {
  if(String(payload.order_id??'')!==intent.order_id&&!identityVerifiedByLookup)throw midtransValidationError('Order ID Midtrans tidak cocok dengan intent Nusa',payload);
  const paymentType=String(payload.payment_type??'').toLowerCase();
  const isQrisFlow=paymentType==='qris'||(paymentType==='gopay'&&Boolean(midtransQrUrl(payload)));
  if(!isQrisFlow)throw midtransValidationError('Jenis pembayaran Midtrans bukan alur QRIS atau URL QR tidak dikenali',payload);
  if(String(payload.currency??'IDR').toUpperCase()!=='IDR')throw midtransValidationError('Mata uang Midtrans bukan IDR',payload);
  if(Math.abs(Number(payload.gross_amount)-Number(intent.gross_amount))>0.001)throw midtransValidationError('Nominal Midtrans tidak cocok dengan intent Nusa',payload);
  if(String(payload.transaction_status??'').toLowerCase()==='settlement'&&payload.fraud_status&&String(payload.fraud_status).toLowerCase()!=='accept')throw midtransValidationError('Settlement Midtrans tidak memiliki fraud status accept',payload);
}

async function recordMidtransEvent(intentId,source,payload,processingResult,signatureVerified=null) {
  await rest('payment_gateway_events','',{method:'POST',body:{intent_id:intentId,source,event_status:String(payload?.transaction_status??''),signature_verified:signatureVerified,payload_hash:midtransPayloadHash(payload),sanitized_payload:sanitizedMidtransPayload(payload),processing_result:String(processingResult).slice(0,500)}});
}

async function updateMidtransIntent(intent,payload,source,signatureVerified=null,{identityVerifiedByLookup=false}={}) {
  validateMidtransIntentStatus(intent,payload,{identityVerifiedByLookup});
  const observedStatus=midtransStatus(payload.transaction_status);
  const terminal=new Set(['SETTLEMENT','EXPIRED','DENIED','CANCELLED']);
  const status=observedStatus==='SETTLEMENT'||intent.status==='SETTLEMENT'?'SETTLEMENT':terminal.has(intent.status)?intent.status:observedStatus;
  const body={status,gateway_transaction_id:String(payload.transaction_id??intent.gateway_transaction_id??'')||null,qr_url:midtransQrUrl(payload)??intent.qr_url??null,gateway_status_code:String(payload.status_code??'')||null,gateway_status_message:String(payload.status_message??'').slice(0,500)||null,last_gateway_payload:sanitizedMidtransPayload(payload),updated_at:new Date().toISOString()};
  if(payload.expiry_time){const expiry=new Date(String(payload.expiry_time).replace(' ','T')+'+07:00');if(Number.isFinite(expiry.getTime()))body.expires_at=expiry.toISOString();}
  if(observedStatus==='SETTLEMENT'&&!intent.settled_at)body.settled_at=new Date().toISOString();
  const rows=await rest('payment_gateway_intents',`id=eq.${intent.id}&tenant_id=eq.${intent.tenant_id}&environment=eq.${intent.environment}`,{method:'PATCH',prefer:'return=representation',body});
  await recordMidtransEvent(intent.id,source,payload,`${intent.environment} mengamati ${observedStatus}, status tersimpan ${status}; belum ada penjualan atau stok yang diubah`,signatureVerified);
  return rows[0]??{...intent,...body};
}

function isPlatformAdmin(session) {
  const allowed = new Set(env().platformAdminIds.split(',').map((value) => value.trim()).filter(Boolean));
  return allowed.has(String(session?.authenticatedUser?.id ?? ''));
}

function requirePlatformAdmin(session) {
  if (isPlatformAdmin(session)) return;
  const error = new Error('Halaman ini hanya dapat diakses Platform Admin Nusa');
  error.status = 403;
  throw error;
}

function summarizeWorkerRows(rows = []) {
  const summary = rows.reduce((result, row) => {
    const requests = Number(row.sum?.requests ?? 0);
    result.requests += requests;
    result.errors += Number(row.sum?.errors ?? 0);
    result.subrequests += Number(row.sum?.subrequests ?? 0);
    result.cpuP50Microseconds = Math.max(result.cpuP50Microseconds, Number(row.quantiles?.cpuTimeP50 ?? 0));
    result.cpuP99Microseconds = Math.max(result.cpuP99Microseconds, Number(row.quantiles?.cpuTimeP99 ?? 0));
    return result;
  }, { requests:0, errors:0, subrequests:0, cpuP50Microseconds:0, cpuP99Microseconds:0 });
  return {
    requests:summary.requests,errors:summary.errors,subrequests:summary.subrequests,
    errorRate:summary.requests ? summary.errors*100/summary.requests : 0,
    cpuP50Ms:summary.cpuP50Microseconds/1000,cpuP99Ms:summary.cpuP99Microseconds/1000
  };
}

async function loadCloudflareInfrastructure() {
  const config = env();
  const configured = Boolean(config.cloudflareAccountId && config.cloudflareApiToken);
  if (!configured) return {
    configured:false,plan:config.cloudflarePlan,scriptName:config.cloudflareScriptName,
    message:'Token Analytics Cloudflare belum dipasang pada Worker.'
  };
  const end = new Date();
  const dayStart = new Date(end.getTime()-24*60*60*1000);
  const monthStart = new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth(),1));
  const query=`query PlatformWorkerMetrics($accountTag: string, $dayStart: string, $monthStart: string, $end: string, $scriptName: string) {
    viewer { accounts(filter: {accountTag: $accountTag}) {
      day: workersInvocationsAdaptive(limit: 10000, filter: {scriptName: $scriptName, datetime_geq: $dayStart, datetime_leq: $end}) {
        sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 }
      }
      month: workersInvocationsAdaptive(limit: 10000, filter: {scriptName: $scriptName, datetime_geq: $monthStart, datetime_leq: $end}) {
        sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 }
      }
    } }
  }`;
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql',{
    method:'POST',headers:{authorization:`Bearer ${config.cloudflareApiToken}`,'content-type':'application/json','accept':'application/json'},
    body:JSON.stringify({query,variables:{
      accountTag:config.cloudflareAccountId,dayStart:dayStart.toISOString(),monthStart:monthStart.toISOString(),
      end:end.toISOString(),scriptName:config.cloudflareScriptName
    }})
  });
  const payload = await response.json().catch(()=>({}));
  if (!response.ok || payload.errors?.length) {
    const error = new Error(payload.errors?.[0]?.message ?? `Cloudflare Analytics ${response.status}`);
    error.status = response.status || 502;
    throw error;
  }
  const account = payload.data?.viewer?.accounts?.[0];
  if (!account) throw Object.assign(new Error('Akun Cloudflare tidak ditemukan oleh token Analytics'),{status:502});
  const plan=config.cloudflarePlan==='PAID'?'PAID':'FREE';
  return {
    configured:true,plan,scriptName:config.cloudflareScriptName,generatedAt:end.toISOString(),
    quota:plan==='PAID'
      ?{period:'MONTH',requestLimit:10000000,cpuPoolMs:30000000,cpuPerRequestMs:30000}
      :{period:'DAY',requestLimit:100000,cpuPoolMs:null,cpuPerRequestMs:10},
    last24Hours:summarizeWorkerRows(account.day),month:summarizeWorkerRows(account.month)
  };
}

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
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (response.ok) {
        const error = new Error('Respons database tidak dapat dibaca');
        error.status = 502;
        error.details = { response: text.slice(0, 300) };
        throw error;
      }
      data = { message: text.trim().slice(0, 300) || `Supabase ${response.status}` };
    }
  }
  if (!response.ok) {
    const error = new Error(data?.message ?? data?.msg ?? data?.error_description ?? `Supabase ${response.status}`);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function uploadPublicMedia(tenantId, kind, dataUrl) {
  const match=String(dataUrl??'').match(/^data:image\/(jpeg|png|webp);base64,([a-z0-9+/=\s]+)$/i);
  if(!match)throw Object.assign(new Error('Pilih foto PNG, JPEG, atau WebP yang valid'),{status:400});
  const contentType=`image/${match[1].toLowerCase()}`;
  const bytes=Buffer.from(match[2].replace(/\s/g,''),'base64');
  if(!bytes.length||bytes.length>900000)throw Object.assign(new Error('Foto terlalu besar setelah diperkecil'),{status:400});
  const extension=contentType==='image/jpeg'?'jpg':contentType.split('/')[1];
  const objectPath=`${tenantId}/${kind}/${randomBytes(18).toString('hex')}.${extension}`;
  const config=env();
  const upload=await fetch(`${config.url}/storage/v1/object/pos-media/${objectPath}`,{
    method:'POST',
    headers:{
      apikey:config.service,authorization:`Bearer ${config.service}`,
      'content-type':contentType,'x-upsert':'false'
    },
    body:bytes
  });
  if(!upload.ok){
    const detail=await upload.text();
    const error=new Error(/bucket.*not found/i.test(detail)
      ?'Penyimpanan foto belum aktif. Jalankan migrasi media terbaru.'
      :'Foto gagal diunggah. Coba ulangi.');
    error.status=upload.status;throw error;
  }
  return `${config.url}/storage/v1/object/public/pos-media/${objectPath}`;
}

async function uploadAttendancePhoto(tenantId,dataUrl) {
  const match=String(dataUrl??'').match(/^data:image\/(jpeg|png|webp);base64,([a-z0-9+/=\s]+)$/i);
  if(!match)throw Object.assign(new Error('Foto wajah wajib diambil dalam format JPEG, PNG, atau WebP'),{status:400});
  const contentType=`image/${match[1].toLowerCase()}`;
  const bytes=Buffer.from(match[2].replace(/\s/g,''),'base64');
  if(!bytes.length||bytes.length>500000)throw Object.assign(new Error('Foto wajah terlalu besar setelah diperkecil'),{status:400});
  const extension=contentType==='image/jpeg'?'jpg':contentType.split('/')[1];
  const objectPath=`${tenantId}/attendance/${new Date().toISOString().slice(0,10)}/${randomBytes(18).toString('hex')}.${extension}`;
  const config=env();
  const upload=await fetch(`${config.url}/storage/v1/object/attendance-media/${objectPath}`,{
    method:'POST',headers:{apikey:config.service,authorization:`Bearer ${config.service}`,
      'content-type':contentType,'x-upsert':'false'},body:bytes
  });
  if(!upload.ok){
    const detail=await upload.text();
    throw Object.assign(new Error(/bucket.*not found/i.test(detail)
      ?'Penyimpanan foto absensi belum aktif. Jalankan migrasi absensi terbaru.'
      :'Foto absensi gagal disimpan. Coba lagi.'),{status:upload.status});
  }
  return objectPath;
}

async function deleteAttendancePhoto(objectPath) {
  const config=env();
  await fetch(`${config.url}/storage/v1/object/attendance-media/${objectPath}`,{
    method:'DELETE',headers:{apikey:config.service,authorization:`Bearer ${config.service}`}
  }).catch(()=>null);
}

async function signedAttendancePhotoUrl(objectPath) {
  const config=env();
  const response=await fetch(`${config.url}/storage/v1/object/sign/attendance-media/${objectPath}`,{
    method:'POST',headers:{apikey:config.service,authorization:`Bearer ${config.service}`,'content-type':'application/json'},
    body:JSON.stringify({expiresIn:120})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.signedURL)throw Object.assign(new Error('Foto absensi belum dapat dibuka'),{status:response.status||500});
  if(data.signedURL.startsWith('http'))return data.signedURL;
  const signedPath=data.signedURL.startsWith('/')?data.signedURL:`/${data.signedURL}`;
  return signedPath.startsWith('/storage/v1/')?`${config.url}${signedPath}`:`${config.url}/storage/v1${signedPath}`;
}

function distanceMeters(lat1,lon1,lat2,lon2){
  const radians=(value)=>value*Math.PI/180;
  const a=Math.sin(radians(lat2-lat1)/2)**2+Math.cos(radians(lat1))*Math.cos(radians(lat2))*Math.sin(radians(lon2-lon1)/2)**2;
  return 6371000*2*Math.asin(Math.sqrt(a));
}

const rest = (table, query = '', options = {}) => supabase(`/rest/v1/${table}${query ? `?${query}` : ''}`, options);
async function restAll(table,query='',options={}){
  const rows=[];
  for(let offset=0;;offset+=1000){
    const page=await rest(table,`${query}${query?'&':''}limit=1000&offset=${offset}`,options);
    rows.push(...page);
    if(page.length<1000)return rows;
  }
}
const rpc = (name, body) => supabase(`/rest/v1/rpc/${name}`, { method: 'POST', body });

function notificationPayload(notification) {
  const appUrl=String(process.env.PUBLIC_APP_URL??'https://app.nusapos.my.id').replace(/\/$/,'');
  const page=String(notification.actionPage??'').replace(/[^a-z0-9-]/gi,'');
  return {
    title:String(notification.title??'Kasir Nusa POS').slice(0,120),
    body:String(notification.message??'Ada pembaruan baru.').slice(0,500),
    icon:`${appUrl}/icon-192.svg`,badge:`${appUrl}/icon-192.svg`,
    tag:String(notification.dedupeKey??notification.entityId??notification.type??'nusa-update').slice(0,120),
    data:{url:page?`${appUrl}/?notification-page=${encodeURIComponent(page)}`:appUrl,page},
    timestamp:Date.now()
  };
}

async function sendWebPush(subscription,notification) {
  const config=env();
  if(!config.webPushPublicKey||!config.webPushPrivateKey)return {sent:false,reason:'NOT_CONFIGURED'};
  const payload=await buildPushPayload({
    data:JSON.stringify(notificationPayload(notification)),
    options:{ttl:300,urgency:notification.severity==='CRITICAL'?'high':'normal',topic:String(notification.type??'nusa').slice(0,32)}
  },{
    endpoint:subscription.endpoint,expirationTime:subscription.expiration_time===null?null:Number(subscription.expiration_time),
    keys:{p256dh:subscription.p256dh,auth:subscription.auth_key}
  },{subject:config.webPushSubject,publicKey:config.webPushPublicKey,privateKey:config.webPushPrivateKey});
  const response=await fetch(subscription.endpoint,{...payload,signal:AbortSignal.timeout(3500)});
  if(response.ok){
    await rest('web_push_subscriptions',`id=eq.${subscription.id}`,{
      method:'PATCH',body:{last_success_at:new Date().toISOString(),failure_count:0,active:true}
    }).catch(()=>{});
    return {sent:true};
  }
  const expired=[404,410].includes(response.status);
  await rest('web_push_subscriptions',`id=eq.${subscription.id}`,{
    method:'PATCH',body:{active:!expired,failure_count:Number(subscription.failure_count??0)+1,updated_at:new Date().toISOString()}
  }).catch(()=>{});
  return {sent:false,status:response.status,expired};
}

async function notifyTenantOwners(tenantId,notification,waitUntil=null) {
  try{
    const recipients=await rpc('create_owner_notifications_v1',{
      p_tenant_id:tenantId,p_type:notification.type,p_title:notification.title,p_message:notification.message,
      p_severity:notification.severity??'INFO',p_entity_type:notification.entityType??null,
      p_entity_id:notification.entityId??null,p_action_page:notification.actionPage??null,
      p_data_json:notification.data??{},p_dedupe_key:notification.dedupeKey??null
    });
    const userIds=[...new Set((Array.isArray(recipients)?recipients:[]).map((row)=>row.recipientUserId).filter(Boolean))];
    if(!userIds.length||!env().webPushPublicKey||!env().webPushPrivateKey)return;
    const subscriptions=(await rest('web_push_subscriptions',
      `tenant_id=eq.${tenantId}&active=eq.true&select=*&limit=100`))
      .filter((subscription)=>userIds.includes(subscription.user_id));
    const delivery=Promise.allSettled(subscriptions.map((subscription)=>sendWebPush(subscription,notification)));
    if(typeof waitUntil==='function')waitUntil(delivery);
    else await delivery;
  }catch(error){
    // Notification delivery is deliberately isolated from sales and attendance.
    console.error('Owner notification failed',notification.type,error.message);
  }
}

async function rawRpc(response,name,body){
  const config=env();
  const upstream=await fetch(`${config.url}/rest/v1/rpc/${name}`,{
    method:'POST',headers:{apikey:config.service,authorization:`Bearer ${config.service}`,'content-type':'application/json'},
    body:JSON.stringify(body)
  });
  const text=await upstream.text();
  if(!upstream.ok){
    let details={};try{details=text?JSON.parse(text):{};}catch{}
    const error=new Error(details.message??`Supabase ${upstream.status}`);error.status=upstream.status;error.details=details;throw error;
  }
  response.statusCode=200;
  response.setHeader('content-type','application/json; charset=utf-8');
  response.setHeader('cache-control','no-store');
  response.end(text);
}

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

async function provisionOwnerWorkspace(authUser,{ownerName,businessName,email}) {
  const existing=await profileFor(authUser.id);
  if(existing)return existing;
  await rpc('register_owner_workspace_v1', {
    p_user_id:authUser.id,
    p_display_name:ownerName,
    p_business_name:businessName,
    p_email:email
  });
  const profile=await profileFor(authUser.id);
  if(!profile?.active||profile.role!=='OWNER'){
    const error=new Error('Ruang usaha gagal diaktifkan');error.status=500;throw error;
  }
  return profile;
}

function ownerRegistrationMetadata(authUser,fallback={}) {
  const metadata=authUser?.user_metadata??{};
  return {
    ownerName:String(metadata.display_name??fallback.ownerName??'').trim(),
    businessName:String(metadata.business_name??fallback.businessName??'').trim(),
    email:String(authUser?.email??fallback.email??'').trim().toLowerCase()
  };
}

async function adminAuthUserForEmail(email){
  const expected=String(email??'').trim().toLowerCase();
  for(let page=1;page<=10;page+=1){
    const result=await supabase(`/auth/v1/admin/users?page=${page}&per_page=100`,{token:env().service});
    const users=Array.isArray(result?.users)?result.users:[];
    const found=users.find((user)=>String(user.email??'').toLowerCase()===expected);
    if(found)return found;
    if(users.length<100)break;
  }
  return null;
}

async function passwordAuth(email,password){
  return supabase('/auth/v1/token?grant_type=password',{
    method:'POST',token:env().anon,body:{email,password}
  });
}

async function sessionOf(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  let authenticatedUser;
  try {
    authenticatedUser = await supabase('/auth/v1/user', { token });
  } catch (error) {
    // GoTrue dapat mengembalikan 403 untuk JWT kedaluwarsa/invalid. Di sisi
    // aplikasi ini tetap berarti access token perlu di-refresh, bukan larangan
    // hak akses.
    if ([401,403].includes(error.status)) {
      error.status = 401;
      error.message = 'Sesi perlu diperbarui';
    }
    throw error;
  }
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
    permissions: effectivePermissions(profile), authenticatedUser,
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
    permissions: effectivePermissions(profile)
  };
}

function requireAnyPermission(session, permissions) {
  if (!session) { const error = new Error('Sesi tidak valid'); error.status = 401; throw error; }
  if (!permissions.some((permission)=>session.permissions.includes(permission))) {
    const error = new Error('Anda tidak memiliki hak untuk tindakan ini'); error.status = 403; throw error;
  }
}

function groupRows(rows,keyOf) {
  const grouped=new Map();
  for(const row of rows){
    const key=keyOf(row);
    if(!grouped.has(key))grouped.set(key,[]);
    grouped.get(key).push(row);
  }
  return grouped;
}

async function loadCatalog(tenantId, locationId, outletId = null) {
  const tenant = encodeURIComponent(tenantId);
  const [products, units, rules, balances, overrides, families, familyBarcodes, variantOptions] = await Promise.all([
    restAll('products', `tenant_id=eq.${tenant}&active=eq.true&select=*&order=name`),
    restAll('product_units', `tenant_id=eq.${tenant}&select=*`),
    restAll('price_rules', `tenant_id=eq.${tenant}&select=*`),
    locationId ? restAll('stock_balances', `tenant_id=eq.${tenant}&location_id=eq.${encodeURIComponent(locationId)}&select=*`) : Promise.resolve([]),
    outletId ? restAll('outlet_price_overrides', `tenant_id=eq.${tenant}&outlet_id=eq.${encodeURIComponent(outletId)}&active=eq.true&select=*`).catch(()=>[]) : Promise.resolve([]),
    restAll('product_families',`tenant_id=eq.${tenant}&active=eq.true&select=*`).catch(()=>[]),
    restAll('product_family_barcodes',`tenant_id=eq.${tenant}&select=*`).catch(()=>[]),
    restAll('product_variant_options',`tenant_id=eq.${tenant}&select=*`).catch(()=>[])
  ]);
  const unitsByProduct=groupRows(units,(item)=>item.product_id);
  const rulesByProduct=groupRows(rules,(item)=>item.product_id);
  const balancesByProduct=new Map(balances.map((item)=>[item.product_id,item]));
  const overridesByProduct=groupRows(overrides,(item)=>item.product_id);
  const familyById=new Map(families.map((item)=>[item.id,item]));
  const barcodesByFamily=groupRows(familyBarcodes,(item)=>item.family_id);
  const optionsByProduct=groupRows(variantOptions,(item)=>item.product_id);
  return products.map((product) => ({
    id: product.id, sku: product.sku, name: product.name, category: product.category, brand: product.brand, imageUrl:product.image_url, active: product.active,legacyCode:product.legacy_code??null,
    variantGroup: product.variant_group, variantName: product.variant_name, minimumStock: Number(product.minimum_stock ?? 0), trackExpiry: Boolean(product.track_expiry), trackStock: product.track_stock !== false,
    familyId:product.family_id??null,familyCode:familyById.get(product.family_id)?.code??null,familyName:familyById.get(product.family_id)?.name??product.variant_group??null,
    familyBarcodes:(barcodesByFamily.get(product.family_id)??[]).map((item)=>item.barcode),
    variantOptions:(optionsByProduct.get(product.id)??[]).map((item)=>({name:item.option_name,value:item.option_value,position:Number(item.position??1)})).sort((a,b)=>a.position-b.position||a.name.localeCompare(b.name,'id')),
    stockBase: Number(balancesByProduct.get(product.id)?.quantity ?? 0),
    units: (unitsByProduct.get(product.id)??[]).map((unit) => ({ id: unit.id, name: unit.name, factor: Number(unit.factor_to_base), barcode: unit.barcode })).sort((a,b)=>a.factor-b.factor),
    priceRules: [
      ...(rulesByProduct.get(product.id)??[]).map((rule) => ({ id: rule.id, customerGroupId: rule.customer_group_id, minBaseQty: Number(rule.min_base_qty), unitPriceBase: Number(rule.unit_price_base), priority: rule.priority })),
      ...(overridesByProduct.get(product.id)??[]).map((rule) => ({ id: rule.id, customerGroupId: rule.customer_group_id, minBaseQty: Number(rule.min_base_qty), unitPriceBase: Number(rule.unit_price_base), priority: 100000 }))
    ]
  }));
}

async function loadQuoteProducts(tenantId, productIds, locationId, outletId = null) {
  const ids=[...new Set((productIds??[]).map((id)=>String(id).trim()).filter(Boolean))];
  if(!ids.length)return[];
  const tenant=encodeURIComponent(tenantId),productsFilter=`product_id=${inFilter(ids)}`;
  const [products,units,rules,balances,overrides]=await Promise.all([
    rest('products',`tenant_id=eq.${tenant}&id=${inFilter(ids)}&active=eq.true&select=id,name,category,brand`),
    rest('product_units',`tenant_id=eq.${tenant}&${productsFilter}&select=id,product_id,name,factor_to_base,barcode`),
    rest('price_rules',`tenant_id=eq.${tenant}&${productsFilter}&select=id,product_id,customer_group_id,min_base_qty,unit_price_base,priority`),
    locationId?rest('stock_balances',`tenant_id=eq.${tenant}&location_id=eq.${encodeURIComponent(locationId)}&${productsFilter}&select=product_id,quantity`):Promise.resolve([]),
    outletId?rest('outlet_price_overrides',`tenant_id=eq.${tenant}&outlet_id=eq.${encodeURIComponent(outletId)}&active=eq.true&${productsFilter}&select=id,product_id,customer_group_id,min_base_qty,unit_price_base`).catch(()=>[]):Promise.resolve([])
  ]);
  const unitsByProduct=groupRows(units,(item)=>item.product_id);
  const rulesByProduct=groupRows(rules,(item)=>item.product_id);
  const balancesByProduct=new Map(balances.map((item)=>[item.product_id,item]));
  const overridesByProduct=groupRows(overrides,(item)=>item.product_id);
  return products.map((product)=>({
    id:product.id,name:product.name,category:product.category,brand:product.brand,
    stockBase:Number(balancesByProduct.get(product.id)?.quantity??0),
    units:(unitsByProduct.get(product.id)??[]).map((unit)=>({id:unit.id,name:unit.name,factor:Number(unit.factor_to_base),barcode:unit.barcode})),
    priceRules:[
      ...(rulesByProduct.get(product.id)??[]).map((rule)=>({id:rule.id,customerGroupId:rule.customer_group_id,minBaseQty:Number(rule.min_base_qty),unitPriceBase:Number(rule.unit_price_base),priority:rule.priority})),
      ...(overridesByProduct.get(product.id)??[]).map((rule)=>({id:rule.id,customerGroupId:rule.customer_group_id,minBaseQty:Number(rule.min_base_qty),unitPriceBase:Number(rule.unit_price_base),priority:100000}))
    ]
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

async function loadCustomerPriceGroups(tenantId) {
  const rows = await rest('customer_price_groups', `tenant_id=eq.${encodeURIComponent(tenantId)}&active=eq.true&select=id,name,is_default,active,sort_order&order=sort_order,name`);
  return rows.map((group) => ({
    id:group.id,name:group.name,isDefault:Boolean(group.is_default),
    active:group.active!==false,sortOrder:Number(group.sort_order??100)
  }));
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

async function loadManagedProducts(tenantId,{includeCost=false}={}) {
  const tenant=encodeURIComponent(tenantId);
  const [products,units,rules,balances,families,familyBarcodes,variantOptions]=await Promise.all([
    restAll('products',`tenant_id=eq.${tenant}&select=*&order=active.desc,name`),
    restAll('product_units',`tenant_id=eq.${tenant}&select=*`),
    restAll('price_rules',`tenant_id=eq.${tenant}&starts_at=is.null&ends_at=is.null&select=*`),
    restAll('stock_balances',`tenant_id=eq.${tenant}&select=product_id,quantity${includeCost?',avg_cost':''}`),
    restAll('product_families',`tenant_id=eq.${tenant}&select=*`).catch(()=>[]),
    restAll('product_family_barcodes',`tenant_id=eq.${tenant}&select=*`).catch(()=>[]),
    restAll('product_variant_options',`tenant_id=eq.${tenant}&select=*`).catch(()=>[])
  ]);
  const unitsByProduct=groupRows(units,(item)=>item.product_id);
  const rulesByProduct=groupRows(rules,(item)=>item.product_id);
  const balancesByProduct=groupRows(balances,(item)=>item.product_id);
  const familyById=new Map(families.map((item)=>[item.id,item]));
  const barcodesByFamily=groupRows(familyBarcodes,(item)=>item.family_id);
  const optionsByProduct=groupRows(variantOptions,(item)=>item.product_id);
  return products.map((product)=>{
    const productBalances=balancesByProduct.get(product.id)??[];
    const stockBase=productBalances.reduce((sum,balance)=>sum+Number(balance.quantity),0);
    const costQuantity=productBalances.reduce((sum,balance)=>sum+Math.max(0,Number(balance.quantity)),0);
    const weightedCost=costQuantity>0
      ? productBalances.reduce((sum,balance)=>sum+(Math.max(0,Number(balance.quantity))*Number(balance.avg_cost??0)),0)/costQuantity
      : Math.max(0,...productBalances.map((balance)=>Number(balance.avg_cost??0)));
    return {
      id:product.id,sku:product.sku,name:product.name,category:product.category,brand:product.brand,imageUrl:product.image_url,active:product.active,legacyCode:product.legacy_code??null,
      variantGroup:product.variant_group,variantName:product.variant_name,minimumStock:Number(product.minimum_stock??0),trackExpiry:Boolean(product.track_expiry),trackStock:product.track_stock!==false,
      familyId:product.family_id??null,familyCode:familyById.get(product.family_id)?.code??null,familyName:familyById.get(product.family_id)?.name??product.variant_group??null,
      familyBarcodes:(barcodesByFamily.get(product.family_id)??[]).map((item)=>item.barcode),
      variantOptions:(optionsByProduct.get(product.id)??[]).map((item)=>({name:item.option_name,value:item.option_value,position:Number(item.position??1)})).sort((a,b)=>a.position-b.position||a.name.localeCompare(b.name,'id')),
      stockBase,...(includeCost?{averageCost:Math.round(weightedCost*100)/100}:{}),
      units:(unitsByProduct.get(product.id)??[]).map((unit)=>({id:unit.id,name:unit.name,factor:Number(unit.factor_to_base),barcode:unit.barcode})).sort((a,b)=>a.factor-b.factor),
      priceRules:(rulesByProduct.get(product.id)??[]).map((rule)=>({id:rule.id,customerGroupId:rule.customer_group_id,minBaseQty:Number(rule.min_base_qty),unitPriceBase:Number(rule.unit_price_base),priority:rule.priority}))
    };
  });
}

function normalizeProductInput(input,id=null) {
  const units=Array.isArray(input.units)&&input.units.length?input.units:[{name:input.unitName||'pcs',factor:1,barcode:input.barcode||null}];
  const rawPrices=Array.isArray(input.prices)&&input.prices.length?input.prices:[
    {customerGroupId:'retail',unitPriceBase:input.retailPrice},
    ...(Number(input.wholesalePrice)>0?[{customerGroupId:'wholesale',unitPriceBase:input.wholesalePrice}]:[])
  ];
  const prices=rawPrices.map((price)=>({
    customerGroupId:String(price.customerGroupId??'').trim(),
    minBaseQty:Number(price.minBaseQty??1),
    unitPriceBase:Number(price.unitPriceBase)
  }));
  const retailPrice=prices.find((price)=>price.customerGroupId==='retail'&&price.minBaseQty===1)?.unitPriceBase;
  const normalized={
    id:id??input.id??null,sku:String(input.sku??'').trim().toUpperCase(),name:String(input.name??'').trim(),
    category:String(input.category??'').trim()||'Lainnya',brand:String(input.brand??'').trim(),
    imageUrl:String(input.imageUrl??'').trim(),
    variantGroup:String(input.variantGroup??'').trim(),variantName:String(input.variantName??'').trim(),
    minimumStock:Number(input.minimumStock??0),trackExpiry:Boolean(input.trackExpiry),trackStock:input.trackStock!==false,
    retailPrice:Number(retailPrice),wholesalePrice:Number(prices.find((price)=>price.customerGroupId==='wholesale')?.unitPriceBase??0),
    prices,
    units:units.map((unit)=>({id:unit.id??null,name:String(unit.name??'').trim(),factor:Number(unit.factor),barcode:String(unit.barcode??'').trim()}))
  };
  if(!normalized.trackStock){normalized.minimumStock=0;normalized.trackExpiry=false;}
  if(!normalized.sku||!normalized.name)throw Object.assign(new Error('SKU dan nama produk wajib diisi'),{status:400});
  if(!(normalized.retailPrice>0))throw Object.assign(new Error('Harga umum harus lebih dari nol'),{status:400});
  const priceTiers=new Set();
  for(const price of normalized.prices){
    if(!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(price.customerGroupId)||!Number.isInteger(price.minBaseQty)||price.minBaseQty<1||!(price.unitPriceBase>0))throw Object.assign(new Error('Tipe, minimal pembelian, dan nominal harga produk tidak valid'),{status:400});
    const tierKey=`${price.customerGroupId}:${price.minBaseQty}`;
    if(priceTiers.has(tierKey))throw Object.assign(new Error('Minimal pembelian pada tipe harga yang sama tercatat dua kali'),{status:400});
    priceTiers.add(tierKey);
  }
  if(!(normalized.minimumStock>=0))throw Object.assign(new Error('Batas stok minimum tidak valid'),{status:400});
  if(normalized.imageUrl){
    let imageUrl;
    try{imageUrl=new URL(normalized.imageUrl);}catch{throw Object.assign(new Error('URL foto produk tidak valid'),{status:400});}
    if(!['http:','https:'].includes(imageUrl.protocol)||normalized.imageUrl.length>2000)throw Object.assign(new Error('URL foto produk harus memakai http atau https'),{status:400});
    normalized.imageUrl=imageUrl.href;
  }
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

async function assertNoSharedBarcodeConflict(tenantId,input){
  const barcodes=(input.units??[]).map((unit)=>String(unit.barcode??'').trim()).filter(Boolean);
  if(!barcodes.length)return;
  const shared=await restAll('product_family_barcodes',`tenant_id=eq.${tenantId}&barcode=${inFilter(barcodes)}&select=barcode`).catch(()=>[]);
  if(shared.length)throw Object.assign(new Error(`Barcode ${shared[0].barcode} adalah barcode bersama etalase dan tidak boleh dipakai langsung oleh SKU`),{status:409});
}

async function previewSafePricePolicy(tenantId,input) {
  const policy=normalizeSafePricePolicy(input);
  const [products,balances,groups]=await Promise.all([
    loadManagedProducts(tenantId),
    rest('stock_balances',`tenant_id=eq.${encodeURIComponent(tenantId)}&select=product_id,avg_cost`),
    loadCustomerPriceGroups(tenantId)
  ]);
  const validGroups=new Set(groups.map((group)=>group.id));
  for(const rule of policy.rules)if(!validGroups.has(rule.customerGroupId)){
    const error=new Error(`Tipe pelanggan ${rule.customerGroupId} tidak aktif`);error.status=400;throw error;
  }
  const rows=products.filter((product)=>product.active
    &&(!policy.category||product.category===policy.category)
    &&(!policy.brand||product.brand===policy.brand)
  ).map((product)=>{
    const retailPrice=product.priceRules.find((rule)=>rule.customerGroupId==='retail'&&rule.minBaseQty===1)?.unitPriceBase??0;
    const productCosts=balances.filter((balance)=>balance.product_id===product.id).map((balance)=>Number(balance.avg_cost??0));
    const cost=Math.max(0,...productCosts);
    const evaluation=evaluateSafePricePolicy({retailPrice,cost,costKnown:productCosts.some((value)=>value>0),rules:policy.rules,minProfit:policy.minProfit});
    return {productId:product.id,sku:product.sku,name:product.name,category:product.category,brand:product.brand,...evaluation};
  });
  return {
    policy,rows,
    summary:{
      products:rows.length,
      fullySafe:rows.filter((row)=>row.safeCount===policy.rules.length).length,
      partiallySafe:rows.filter((row)=>row.safeCount>0&&row.safeCount<policy.rules.length).length,
      rejected:rows.filter((row)=>row.safeCount===0).length,
      recommendations:rows.filter((row)=>row.recommendedIncrease>0).length
    }
  };
}

async function loadPromotions(tenantId, outletId = null) {
  const tenant = encodeURIComponent(tenantId);
  const [promotions, versions, assignments] = await Promise.all([
    rest('promotions', `tenant_id=eq.${tenant}&select=*`),
    rest('promotion_versions', `tenant_id=eq.${tenant}&status=eq.PUBLISHED&select=*&order=priority.desc`),
    outletId ? rest('promotion_outlets', `tenant_id=eq.${tenant}&select=promotion_version_id,outlet_id`).catch(()=>[]) : Promise.resolve([])
  ]);
  const assignedVersions = new Set(assignments.map((item)=>item.promotion_version_id));
  return versions.filter((version)=>
    (version.usage_limit_total==null||Number(version.usage_count??0)<Number(version.usage_limit_total))
    && (!assignedVersions.has(version.id)||assignments.some((item)=>item.promotion_version_id===version.id&&item.outlet_id===outletId))
  ).map((version) => {
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
  const receiptLayout = {
    headerAlignment:'center',footerAlignment:'center',titleSize:'large',
    density:'normal',separator:'dashed',logoSize:64,customHeader:'',customFooter:'',contactLabel:'Tel.',
    showLogo:true,showBusinessName:true,showOutletName:true,showAddress:true,
    showPhone:true,showDate:true,showReceiptNumber:true,showCashier:true,
    showCustomer:true,showPriceType:true,showPaymentDetail:true,
    showTransactionNote:true,showLoyaltyPoints:true,
    ...(row.receipt_layout_json && typeof row.receipt_layout_json==='object' ? row.receipt_layout_json : {})
  };
  return {
    id: row.id ?? null, name: row.name ?? 'Kasir Nusa', legalName: row.legal_name ?? '',
    phone: row.phone ?? '', email: row.email ?? '', address: row.address ?? '', taxId: row.tax_id ?? '',
    currency: row.currency ?? 'IDR', receiptFooter: row.receipt_footer ?? 'Terima kasih telah berbelanja.',
    logoUrl: row.logo_url ?? '', receiptLayout,
    attendanceLatitude:row.attendance_latitude===null||row.attendance_latitude===undefined?null:Number(row.attendance_latitude),
    attendanceLongitude:row.attendance_longitude===null||row.attendance_longitude===undefined?null:Number(row.attendance_longitude),
    attendanceRadiusM:Number(row.attendance_radius_m??100)
  };
}

function normalizeReceiptLayout(input = {}) {
  const choice=(value,allowed,fallback)=>allowed.includes(value)?value:fallback;
  const boolean=(key,fallback=true)=>input[key]===undefined?fallback:Boolean(input[key]);
  const multiline=(value,limit)=>String(value??'').replace(/\r/g,'').split('\n')
    .map((line)=>line.trim().replace(/[ \t]+/g,' ')).filter(Boolean).join('\n').slice(0,limit);
  const customHeader=multiline(input.customHeader,200);
  const customFooter=multiline(input.customFooter,300);
  const contactLabel=String(input.contactLabel??'Tel.').trim().replace(/\s+/g,' ').slice(0,16)||'Tel.';
  return {
    headerAlignment:choice(input.headerAlignment,['left','center'],'center'),
    footerAlignment:choice(input.footerAlignment,['left','center'],'center'),
    titleSize:choice(input.titleSize,['normal','large'],'large'),
    density:choice(input.density,['compact','normal'],'normal'),
    separator:choice(input.separator,['dashed','double'],'dashed'),
    logoSize:Math.max(32,Math.min(96,Number(input.logoSize)||64)),customHeader,customFooter,contactLabel,
    showLogo:boolean('showLogo'),showBusinessName:boolean('showBusinessName'),
    showOutletName:boolean('showOutletName'),showAddress:boolean('showAddress'),
    showPhone:boolean('showPhone'),showDate:boolean('showDate'),
    showReceiptNumber:boolean('showReceiptNumber'),showCashier:boolean('showCashier'),
    showCustomer:boolean('showCustomer'),showPriceType:boolean('showPriceType'),
    showPaymentDetail:boolean('showPaymentDetail'),
    showTransactionNote:boolean('showTransactionNote'),
    showLoyaltyPoints:boolean('showLoyaltyPoints')
  };
}

function normalizeReceiptLogo(value) {
  const logo=String(value??'').trim();
  if(!logo)return '';
  if(logo.length>300000)throw Object.assign(new Error('Logo terlalu besar; pilih gambar di bawah 300 KB'),{status:400});
  if(/^https?:\/\/\S+$/i.test(logo)||/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(logo))return logo;
  throw Object.assign(new Error('Logo harus berupa gambar PNG, JPEG, WebP, atau URL http/https'),{status:400});
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
  const [items,activeApprovals] = await Promise.all([
    rest('purchase_order_items', `tenant_id=eq.${tenant}&order_id=in.(${orderIds})&select=*&order=product_name`),
    rest('restock_approval_requests', `tenant_id=eq.${tenant}&status=in.(PENDING,REVISION_REQUIRED,APPROVED)&select=id,status,document_no,items_json,requester_id,requested_at&order=requested_at.desc`)
  ]);
  const approvalByOrder=new Map();
  for(const approval of activeApprovals){
    const purchaseOrderId=approval.items_json?.find?.((item)=>item?.purchaseOrderId)?.purchaseOrderId??null;
    if(purchaseOrderId&&!approvalByOrder.has(purchaseOrderId))approvalByOrder.set(purchaseOrderId,{
      id:approval.id,status:approval.status,documentNo:approval.document_no,requesterId:approval.requester_id,requestedAt:approval.requested_at
    });
  }
  const today = new Date().toISOString().slice(0, 10);
  return orders.map((order) => {
    const mappedItems = items.filter((item) => item.order_id === order.id).map((item) => ({
      ...item, ordered_qty: Number(item.ordered_qty), received_qty: Number(item.received_qty),
      remaining_qty: Number(item.ordered_qty) - Number(item.received_qty), unit_cost: Number(item.unit_cost),
      line_discount: Number(item.line_discount), line_total: Number(item.line_total),
      purchase_unit_factor:Number(item.purchase_unit_factor??1),ordered_purchase_qty:Number(item.ordered_purchase_qty??item.ordered_qty),
      purchase_unit_cost:Number(item.purchase_unit_cost??item.unit_cost)
    }));
    return {
    ...order, approval_required: Boolean(order.approval_required),receiving_approval:approvalByOrder.get(order.id)??null,
    subtotal: Number(order.subtotal), discount_amount: Number(order.discount_amount), tax_amount: Number(order.tax_amount),
    other_cost: Number(order.other_cost), grand_total: Number(order.grand_total),
    outstanding_qty: mappedItems.reduce((sum, item) => sum + item.remaining_qty, 0),
    overdue: Boolean(order.expected_on && order.expected_on < today && ['APPROVED','PARTIALLY_RECEIVED'].includes(order.status)),
    items: mappedItems
  }});
}

async function restockNeedsPriceApproval(tenantId,items=[]){
  const productIds=[...new Set(items.map((item)=>String(item.productId??'').trim()).filter((id)=>/^[0-9a-f-]{36}$/i.test(id)))];
  if(productIds.length!==items.length)return true;
  if(!productIds.length)return false;
  const rows=await restAll('purchase_receipt_items',`tenant_id=eq.${encodeURIComponent(tenantId)}&product_id=in.(${productIds.join(',')})&select=product_id,unit_cost,received_at,id&order=received_at.desc,id.desc`);
  const latest=new Map();for(const row of rows)if(!latest.has(row.product_id))latest.set(row.product_id,Number(row.unit_cost));
  return items.some((item)=>!latest.has(item.productId)||latest.get(item.productId)!==Number(item.unitCost));
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
    customer: customers[0] ?? null, cashierName: sale.source_cashier || cashiers[0]?.display_name || 'Kasir',
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

async function loadPosSales(context, query = '', { outletIds = [context.outlet.id], from = null, to = null, limit = 50, saleId = null } = {}) {
  const broadPeriod = from && to
    ? `&occurred_at=gte.${encodeURIComponent(`${shiftIsoDate(from,-1)}T00:00:00Z`)}&occurred_at=lt.${encodeURIComponent(`${shiftIsoDate(to,2)}T00:00:00Z`)}`
    : '';
  const requestedLimit=Math.min(20000,Math.max(1,Number(limit)||50));
  let sales=[];
  for(let offset=0;offset<requestedLimit;offset+=1000){
    const pageLimit=Math.min(1000,requestedLimit-offset);
    const page=await rest('sales', `tenant_id=eq.${context.tenantId}&outlet_id=${inFilter(outletIds)}${saleId?`&id=eq.${encodeURIComponent(saleId)}`:''}&status=in.(COMPLETED,VOIDED)${broadPeriod}&select=*&order=occurred_at.desc&limit=${pageLimit}&offset=${offset}`);
    sales.push(...page);
    if(page.length<pageLimit)break;
  }
  if (from && to) {
    const timezone = context.outlet.timezone ?? 'Asia/Makassar';
    sales = sales.filter((sale) => {
      const date = todayInTimeZone(new Date(sale.occurred_at), timezone);
      return date >= from && date <= to;
    });
  }
  if (!sales.length) return [];
  const saleIds = sales.map((sale) => sale.id);
  const customerIds = [...new Set(sales.map((sale) => sale.customer_id).filter(Boolean))];
  const cashierIds = [...new Set(sales.map((sale) => sale.cashier_id).filter(Boolean))];
  const byChunks=async(table,column,ids,tail)=>(await Promise.all(
    Array.from({length:Math.ceil(ids.length/80)},(_,index)=>ids.slice(index*80,index*80+80))
      .map((chunk)=>rest(table,`tenant_id=eq.${context.tenantId}&${column}=${inFilter(chunk)}&${tail}`))
  )).flat();
  const [items,payments,customers,cashiers,pointEntries] = await Promise.all([
    byChunks('sale_items','sale_id',saleIds,'select=*&order=id'),
    byChunks('payments','sale_id',saleIds,'select=*&order=created_at'),
    customerIds.length ? byChunks('customers','id',customerIds,'select=id,name,phone,notes,group_id,loyalty_points,tier_id') : [],
    cashierIds.length ? byChunks('profiles','user_id',cashierIds,'select=user_id,display_name') : [],
    byChunks('customer_point_entries','sale_id',saleIds,'select=sale_id,points,balance_after,entry_type,occurred_at&order=occurred_at')
  ]);
  let customerReturns=[];let customerReturnItems=[];
  try{
    customerReturns=await byChunks('customer_returns','sale_id',saleIds,'status=eq.COMPLETED&select=*&order=occurred_at');
    const returnIds=customerReturns.map((returned)=>returned.id);
    if(returnIds.length)customerReturnItems=await byChunks('customer_return_items','return_id',returnIds,'select=*');
  }catch{}
  let issuedVouchers=[];
  try{issuedVouchers=await byChunks('vouchers','source_sale_id',saleIds,'source=eq.RECEIPT&select=*');}catch{}
  const adjustmentIds=[...new Set(items.flatMap((item)=>
    (item.promotion_snapshot??[])
      .filter((promotion)=>promotion.manual&&promotion.id)
      .map((promotion)=>promotion.id)
  ))];
  const adjustments=adjustmentIds.length
    ? await byChunks('sale_adjustment_authorizations','id',adjustmentIds,'select=id,adjustment_json,discount_amount')
    : [];
  const normalized = String(query ?? '').trim().toLowerCase();
  return sales.map((sale) => {
    const customer = customers.find((item) => item.id === sale.customer_id) ?? null;
    const pointEntry=pointEntries.find((item)=>item.sale_id===sale.id&&item.entry_type==='EARN');
    const reconstructedPointBalance=sale.source_system==='KASPIN'&&sale.source_payload?.pointsReconstructed===true
      ?Number(sale.source_payload.pointsBalanceAfter):null;
    const cashier = sale.source_cashier || cashiers.find((item) => item.user_id === sale.cashier_id)?.display_name || 'Kasir';
    const saleReturns=customerReturns.filter((returned)=>returned.sale_id===sale.id);
    const saleReturnIds=new Set(saleReturns.map((returned)=>returned.id));
    const saleReturnItems=customerReturnItems.filter((item)=>saleReturnIds.has(item.return_id));
    const legacyReturnedByProduct=new Map();
    for(const returned of saleReturnItems){
      if(!returned.sale_item_id)legacyReturnedByProduct.set(returned.product_id,(legacyReturnedByProduct.get(returned.product_id)??0)+Number(returned.base_qty));
    }
    const lines = items.filter((item) => item.sale_id === sale.id).map((item) => {
      const baseQty=Number(item.base_qty),qty=Number(item.pricing_snapshot?.qty ?? item.base_qty);
      const directReturned=saleReturnItems.filter((returned)=>returned.sale_item_id===item.id).reduce((sum,returned)=>sum+Number(returned.base_qty),0);
      const legacyAvailable=legacyReturnedByProduct.get(item.product_id)??0;
      const legacyUsed=Math.min(Math.max(0,baseQty-directReturned),legacyAvailable);
      legacyReturnedByProduct.set(item.product_id,Math.max(0,legacyAvailable-legacyUsed));
      const returnedBaseQty=directReturned+legacyUsed;
      const returnedQty=baseQty?returnedBaseQty*(qty/baseQty):0;
      const returnedTotal=baseQty?Number(item.total)*(returnedBaseQty/baseQty):0;
      return {
        saleItemId:item.id,productId:item.product_id,productName:item.product_name,
        qty,unitName:item.pricing_snapshot?.unitName ?? 'pcs',baseQty,
        returnedBaseQty,returnedQty,returnedTotal,
        gross:Number(item.gross),discount:Number(item.discount),total:Number(item.total),
        promotions:item.promotion_snapshot ?? []
      };
    });
    const legacyLines=Array.isArray(sale.source_payload?.legacyLines)?sale.source_payload.legacyLines:[];
    legacyLines.forEach((line,index)=>{
      const qty=Math.max(0,Number(line.quantity??0)),gross=Math.max(0,Number(line.lineGross??0));
      lines.push({saleItemId:`legacy-${sale.id}-${index}`,productId:null,
        productName:String(line.productName??line.productCode??'Produk lama'),qty,unitName:'pcs',baseQty:qty,
        returnedBaseQty:0,returnedQty:0,returnedTotal:0,gross,discount:0,total:gross,promotions:[],
        legacy:true,productCode:String(line.productCode??'')});
    });
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
    const issued=issuedVouchers.find((voucher)=>voucher.source_sale_id===sale.id);
    const returnTotal=saleReturns.reduce((sum,returned)=>sum+Number(returned.total),0);
    const returnCost=saleReturnItems.reduce((sum,item)=>sum+Number(item.base_qty)*Number(item.unit_cost??0),0);
    const returnedBaseQty=lines.reduce((sum,line)=>sum+line.returnedBaseQty,0);
    const soldBaseQty=lines.reduce((sum,line)=>sum+line.baseQty,0);
    const returnStatus=!saleReturns.length?'NONE':returnedBaseQty>=soldBaseQty?'FULLY_RETURNED':'PARTIALLY_RETURNED';
    const netTotal=sale.status==='VOIDED'?0:Math.max(0,Number(sale.grand_total)-returnTotal);
    const netCost=sale.status==='VOIDED'?0:Math.max(0,Number(sale.cost_total??0)-returnCost);
    return {
      id:sale.id,receiptNo:sale.receipt_no,status:sale.status,occurredAt:sale.occurred_at,cashierId:sale.cashier_id,
      cashier,outletName:context.outlets.find((outlet)=>outlet.id===sale.outlet_id)?.name??context.outlet.name,customer,
      customerGroupId:sale.customer_group_id??customer?.group_id??'retail',notes:sale.notes ?? '',
      sourceSystem:sale.source_system??'NUSA',pointsEarned:Number(sale.points_earned??pointEntry?.points??0),
      pointsBalance:reconstructedPointBalance!=null
        ?reconstructedPointBalance
        :pointEntry?Number(pointEntry.balance_after):customer?Number(customer.loyalty_points??0):null,
      pointsBalanceIsCurrent:reconstructedPointBalance==null&&!pointEntry&&Boolean(customer),
      creditAmount:Number(sale.credit_amount??0),paidCreditAmount:Number(sale.paid_credit_amount??0),
      voidReason:sale.void_reason ?? '',voidedAt:sale.voided_at ?? null,
      returnStatus,returnTotal,returnCost,netTotal,netCost,grossProfit:netTotal-netCost,
      returns:saleReturns.map((returned)=>({id:returned.id,returnNo:returned.return_no,reason:returned.reason,
        total:Number(returned.total),refundMethod:returned.refund_method,occurredAt:returned.occurred_at})),
      quote:{
        lines,subtotal:Number(sale.subtotal),discountTotal:Number(sale.discount_total),
        grandTotal:Number(sale.grand_total),...(manualAdjustment?{manualAdjustment}:{})
      },
      issuedVoucher:issued?{id:issued.id,code:issued.code,name:issued.name,discountType:issued.discount_type,
        discountValue:Number(issued.discount_value),maxDiscount:issued.max_discount==null?null:Number(issued.max_discount),
        minPurchase:Number(issued.min_purchase),startsAt:issued.starts_at,endsAt:issued.ends_at,active:issued.active}:null,
      payments:payments.filter((item) => item.sale_id === sale.id).map((item) => ({
        method:item.method,amount:Number(item.amount),tendered:item.tendered_amount == null ? null : Number(item.tendered_amount),
        reference:item.reference ?? ''
      }))
    };
  }).filter((sale) => !normalized || `${sale.receiptNo} ${sale.cashier} ${sale.customer?.name ?? ''} ${sale.customer?.phone ?? ''}`.toLowerCase().includes(normalized));
}

const canonicalReportPayment=(value)=>{
  const method=String(value??'').trim().toUpperCase();
  return ['TUNAI','CASH'].includes(method)?'CASH':method;
};

function saleMatchesReportFilter(sale,{staffId='',paymentState='ALL',paymentMethods=[]}={}){
  const payments=sale.payments??[];
  const hasCredit=payments.some((payment)=>canonicalReportPayment(payment.method)==='CREDIT');
  const classification=payments.length>1?'MULTIPAYMENT':canonicalReportPayment(payments[0]?.method);
  if(staffId&&sale.cashierId!==staffId)return false;
  if(paymentState==='PAID'&&hasCredit)return false;
  if(paymentState==='CREDIT'&&!hasCredit)return false;
  return new Set(paymentMethods).has(classification);
}

function saleSettlementRatio(sale){
  const nonCreditPaid=(sale.payments??[]).filter((payment)=>canonicalReportPayment(payment.method)!=='CREDIT').reduce((sum,payment)=>sum+Number(payment.amount??0),0);
  const settledAmount=nonCreditPaid+Number(sale.paidCreditAmount??0);
  return Number(sale.quote?.grandTotal)>0?Math.min(1,Math.max(0,settledAmount/Number(sale.quote.grandTotal))):1;
}

export function filteredSalesReport(sales,{timezone,staffId='',paymentState='ALL',paymentMethods=[],includeCreditProfit=true,includeCreditRevenue=false}={}){
  const staff=[...new Map(sales.filter((sale)=>sale.cashierId).map((sale)=>[sale.cashierId,{id:sale.cashierId,name:sale.cashier}])).values()]
    .sort((a,b)=>a.name.localeCompare(b.name,'id'));
  const selected=sales.filter((sale)=>saleMatchesReportFilter(sale,{staffId,paymentState,paymentMethods}));
  const daily=new Map();
  const metrics={netSales:0,grossProfit:0,returnTotal:0,transactionCount:0,activityCount:0,voidedCount:0};
  for(const sale of selected){
    const date=todayInTimeZone(new Date(sale.occurredAt),timezone);
    const row=daily.get(date)??{date,grossSales:0,returns:0,netSales:0,grossProfit:0,transactionCount:0,activityCount:0,voidedCount:0,returnCount:0};
    row.activityCount+=1;metrics.activityCount+=1;
    if(sale.status==='VOIDED'){
      row.voidedCount+=1;metrics.voidedCount+=1;daily.set(date,row);continue;
    }
    const total=Math.max(0,Number(sale.netTotal??0));
    const cost=Math.max(0,Number(sale.netCost??0));
    const paidRatio=saleSettlementRatio(sale);
    const revenue=includeCreditRevenue?total:total*paidRatio;
    const profit=includeCreditProfit?total-cost:(total-cost)*paidRatio;
    row.grossSales+=Number(sale.quote?.grandTotal??0);row.returns+=Number(sale.returnTotal??0);
    row.netSales+=revenue;row.grossProfit+=profit;row.transactionCount+=1;
    if(Number(sale.returnTotal)>0)row.returnCount+=1;
    daily.set(date,row);
    metrics.netSales+=revenue;metrics.grossProfit+=profit;metrics.returnTotal+=Number(sale.returnTotal??0);metrics.transactionCount+=1;
  }
  metrics.grossMarginPercent=metrics.netSales?metrics.grossProfit/metrics.netSales*100:0;
  return{metrics,daily:[...daily.values()].sort((a,b)=>a.date.localeCompare(b.date)),staff,matchedSales:selected.length};
}

async function loadSalesReportSource(context,{outletIds,from,to,limit=10000}){
  const broadPeriod=`&occurred_at=gte.${encodeURIComponent(`${shiftIsoDate(from,-1)}T00:00:00Z`)}&occurred_at=lt.${encodeURIComponent(`${shiftIsoDate(to,2)}T00:00:00Z`)}`;
  let sales=[];
  for(let offset=0;offset<limit;offset+=1000){
    const pageLimit=Math.min(1000,limit-offset);
    const page=await rest('sales',`tenant_id=eq.${context.tenantId}&outlet_id=${inFilter(outletIds)}&status=in.(COMPLETED,VOIDED)${broadPeriod}&select=id,cashier_id,grand_total,cost_total,credit_amount,paid_credit_amount,status,occurred_at&order=occurred_at.desc&limit=${pageLimit}&offset=${offset}`);
    sales.push(...page);if(page.length<pageLimit)break;
  }
  const timezone=context.outlet.timezone??'Asia/Makassar';
  sales=sales.filter((sale)=>{const date=todayInTimeZone(new Date(sale.occurred_at),timezone);return date>=from&&date<=to;});
  if(!sales.length)return[];
  const saleIds=sales.map((sale)=>sale.id);
  const byChunks=async(table,column,ids,tail)=>(await Promise.all(
    Array.from({length:Math.ceil(ids.length/80)},(_,index)=>ids.slice(index*80,index*80+80))
      .map((chunk)=>rest(table,`tenant_id=eq.${context.tenantId}&${column}=${inFilter(chunk)}&${tail}`))
  )).flat();
  const [payments,returns,cashiers]=await Promise.all([
    byChunks('payments','sale_id',saleIds,'select=sale_id,method,amount'),
    byChunks('customer_returns','sale_id',saleIds,'status=eq.COMPLETED&select=id,sale_id,total'),
    byChunks('profiles','user_id',[...new Set(sales.map((sale)=>sale.cashier_id).filter(Boolean))],'select=user_id,display_name')
  ]);
  const returnItems=returns.length?await byChunks('customer_return_items','return_id',returns.map((item)=>item.id),'select=return_id,base_qty,unit_cost'):[];
  const paymentsBySale=groupRows(payments,(item)=>item.sale_id);
  const returnsBySale=groupRows(returns,(item)=>item.sale_id);
  const returnItemsByReturn=groupRows(returnItems,(item)=>item.return_id);
  const cashierById=new Map(cashiers.map((item)=>[item.user_id,item]));
  return sales.map((sale)=>{
    const ownReturns=returnsBySale.get(sale.id)??[];
    const returnTotal=ownReturns.reduce((sum,item)=>sum+Number(item.total),0);
    const returnCost=ownReturns.reduce((sum,returned)=>sum+(returnItemsByReturn.get(returned.id)??[])
      .reduce((subtotal,item)=>subtotal+Number(item.base_qty)*Number(item.unit_cost??0),0),0);
    const netTotal=sale.status==='VOIDED'?0:Math.max(0,Number(sale.grand_total)-returnTotal);
    const netCost=sale.status==='VOIDED'?0:Math.max(0,Number(sale.cost_total)-returnCost);
    return{id:sale.id,status:sale.status,occurredAt:sale.occurred_at,cashierId:sale.cashier_id,
      cashier:cashierById.get(sale.cashier_id)?.display_name??'Kasir',
      creditAmount:Number(sale.credit_amount??0),paidCreditAmount:Number(sale.paid_credit_amount??0),
      netTotal,netCost,grossProfit:netTotal-netCost,returnTotal,
      quote:{grandTotal:Number(sale.grand_total)},
      payments:(paymentsBySale.get(sale.id)??[]).map((item)=>({method:item.method,amount:Number(item.amount)}))};
  });
}

export function buildSalesItemAnalytics(sales,items,products,returnItems,balances,options={}){
  const selected=sales.filter((sale)=>sale.status!=='VOIDED'&&saleMatchesReportFilter(sale,options));
  const selectedIds=new Set(selected.map((sale)=>sale.id)),grouped=new Map();
  const productMap=new Map(products.map((product)=>[product.id,product]));
  const stockMap=balances.reduce((map,row)=>map.set(row.product_id,(map.get(row.product_id)??0)+Number(row.quantity)),new Map());
  const ensure=(productId,name='Produk')=>{
    const product=productMap.get(productId)??{};
    if(!grouped.has(productId))grouped.set(productId,{productId,sku:product.sku??'',productName:product.name??name,
      category:product.category??'Lainnya',imageUrl:product.image_url??null,qtySold:0,netRevenue:0,grossProfit:0,
      addonTransactions:0,currentStock:stockMap.get(productId)??0});
    return grouped.get(productId);
  };
  for(const sale of selected){
    const own=items.filter((item)=>item.sale_id===sale.id),isAddonSale=new Set(own.map((item)=>item.product_id)).size>1;
    const revenueFactor=options.includeCreditRevenue?1:saleSettlementRatio(sale);
    const profitFactor=options.includeCreditProfit?1:saleSettlementRatio(sale);
    for(const item of own){
      const row=ensure(item.product_id,item.product_name);
      row.qtySold+=Number(item.base_qty);row.netRevenue+=Number(item.total)*revenueFactor;
      row.grossProfit+=(Number(item.total)-Number(item.cost_total))*profitFactor;
      if(isAddonSale)row.addonTransactions+=1;
    }
  }
  for(const returned of returnItems.filter((item)=>selectedIds.has(item.sale_id))){
    const sale=selected.find((item)=>item.id===returned.sale_id),row=ensure(returned.product_id);
    const revenueFactor=options.includeCreditRevenue?1:saleSettlementRatio(sale);
    const profitFactor=options.includeCreditProfit?1:saleSettlementRatio(sale);
    row.qtySold-=Number(returned.base_qty);row.netRevenue-=Number(returned.line_total)*revenueFactor;
    row.grossProfit-=(Number(returned.line_total)-Number(returned.base_qty)*Number(returned.unit_cost??0))*profitFactor;
  }
  const rows=[...grouped.values()].filter((row)=>row.qtySold||row.netRevenue||row.grossProfit);
  const categories=[...rows.reduce((map,row)=>{
    const current=map.get(row.category)??{category:row.category,qtySold:0,netRevenue:0,grossProfit:0,productCount:0};
    current.qtySold+=row.qtySold;current.netRevenue+=row.netRevenue;current.grossProfit+=row.grossProfit;current.productCount+=1;
    map.set(row.category,current);return map;
  },new Map()).values()];
  return{products:rows,categories,addons:rows.filter((row)=>row.addonTransactions>0),
    dashboard:rows.reduce((sum,row)=>{sum.qtySold+=row.qtySold;sum.netRevenue+=row.netRevenue;sum.grossProfit+=row.grossProfit;return sum;},{qtySold:0,netRevenue:0,grossProfit:0})};
}

export function buildStockFlowEntries(ledger,products){
  const productMap=new Map(products.map((product)=>[product.id,product]));
  return ledger.map((item)=>{
    const product=productMap.get(item.product_id)??{},delta=Number(item.delta);
    return{
      id:item.id,productId:item.product_id,sku:product.sku??'',productName:product.name??'Produk',
      category:product.category??'Lainnya',imageUrl:product.image_url??null,
      stockIn:delta>0?delta:0,stockOut:delta<0?Math.abs(delta):0,
      netFlow:delta,eventType:item.event_type,referenceId:item.reference_id,
      occurredAt:item.occurred_at
    };
  });
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

function importBoolean(value){
  if(typeof value==='boolean')return value;
  const normalized=String(value??'').trim().toLowerCase();
  if(!normalized)return false;
  if(['ya','yes','y','true','1','aktif'].includes(normalized))return true;
  if(['tidak','no','n','false','0','nonaktif'].includes(normalized))return false;
  return null;
}

function importStockFlag(value){
  if(value===undefined)return true;
  if(value===true||value===1||String(value).trim()==='1')return true;
  if(value===false||value===0||String(value).trim()==='0')return false;
  return null;
}

function normalizeImportRows(kind, rawRows) {
  const rows = [], errors = [], seenCodes = new Set(), seenBarcodes = new Set();
  const addError = (row, field, message) => errors.push({ row, field, message });
  if (!Array.isArray(rawRows) || !rawRows.length) return { rows, errors: [{ row: 0, field: 'file', message: 'File tidak memiliki data' }] };
  if (rawRows.length > 10000) return { rows, errors: [{ row: 0, field: 'file', message: 'Maksimal 10.000 baris per file' }] };

  rawRows.forEach((raw, index) => {
    const rowNo = index + 2;
    if (kind === 'PRODUCTS') {
      const row = {
        sku: String(raw.sku ?? '').trim().toUpperCase(), name: String(raw.name ?? '').trim(),legacyCode:String(raw.legacyCode??'').trim(),
        category: String(raw.category ?? '').trim() || 'Lainnya', brand: String(raw.brand ?? '').trim(),
        baseUnit: String(raw.baseUnit ?? '').trim() || 'pcs', baseBarcode: String(raw.baseBarcode ?? '').trim(),
        retailPrice: importNumber(raw.retailPrice), wholesalePrice: importNumber(raw.wholesalePrice),
        tierQty: importNumber(raw.tierQty), tierPrice: importNumber(raw.tierPrice),
        bulkUnit: String(raw.bulkUnit ?? '').trim(), bulkFactor: importNumber(raw.bulkFactor),
        bulkBarcode: String(raw.bulkBarcode ?? '').trim(), openingQty: importNumber(raw.openingQty),
        openingCost: importNumber(raw.openingCost), batchNo: String(raw.batchNo ?? '').trim(),
        expiresOn: String(raw.expiresOn ?? '').trim(), minimumStock: importNumber(raw.minimumStock) ?? 0,
        trackExpiry: importBoolean(raw.trackExpiry), trackStock: importStockFlag(raw.trackStock)
      };
      if (!row.name) addError(rowNo, 'name', 'Nama produk wajib diisi');
      if (!(row.retailPrice > 0)) addError(rowNo, 'retailPrice', 'Harga ecer harus lebih dari nol');
      if (row.sku && seenCodes.has(row.sku)) addError(rowNo, 'sku', `SKU ${row.sku} muncul lebih dari sekali`);
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
      if (!(row.minimumStock >= 0)) addError(rowNo, 'minimumStock', 'Stok minimum tidak valid');
      if (row.trackExpiry === null) addError(rowNo, 'trackExpiry', 'Pantau EXP harus YA atau TIDAK');
      if (row.trackStock === null) addError(rowNo, 'trackStock', 'Aturan stok harus 0 atau 1');
      if (row.trackStock === false && ((row.openingQty ?? 0) > 0 || row.minimumStock > 0)) addError(rowNo, 'trackStock', 'Barang tanpa stok harus memakai stok awal dan stok minimum 0');
      rows.push(row);
      return;
    }
    if(kind==='PRODUCT_FAMILIES'){
      const row={familyCode:String(raw.familyCode??'').trim().toUpperCase(),familyName:String(raw.familyName??'').trim(),sharedBarcode:String(raw.sharedBarcode??'').trim()};
      if(!row.familyCode)addError(rowNo,'familyCode','Kode etalase wajib diisi');
      if(!row.familyName)addError(rowNo,'familyName','Nama etalase wajib diisi');
      if(row.familyCode&&!/^[A-Z0-9][A-Z0-9-]{1,49}$/.test(row.familyCode))addError(rowNo,'familyCode','Kode etalase hanya boleh memakai huruf, angka, dan tanda hubung');
      if(seenCodes.has(row.familyCode))addError(rowNo,'familyCode',`Kode etalase ${row.familyCode} muncul lebih dari sekali`);
      if(row.sharedBarcode&&seenBarcodes.has(row.sharedBarcode))addError(rowNo,'sharedBarcode',`Barcode bersama ${row.sharedBarcode} muncul lebih dari sekali`);
      if(row.familyCode)seenCodes.add(row.familyCode);if(row.sharedBarcode)seenBarcodes.add(row.sharedBarcode);
      rows.push(row);return;
    }
    if(kind==='PRODUCT_UNITS'){
      const row={sku:String(raw.sku??'').trim().toUpperCase(),unitName:String(raw.unitName??'').trim(),factor:importNumber(raw.factor),barcode:String(raw.barcode??'').trim(),unitPriceTotal:importNumber(raw.unitPriceTotal)};
      const key=`${row.sku}:${row.unitName.toLowerCase()}`;
      if(!row.sku)addError(rowNo,'sku','SKU wajib diisi');
      if(!row.unitName)addError(rowNo,'unitName','Nama satuan wajib diisi');
      if(!(row.factor>0))addError(rowNo,'factor','Isi satuan dasar harus lebih dari nol');
      if(row.unitPriceTotal!==null&&!(row.unitPriceTotal>0))addError(rowNo,'unitPriceTotal','Harga satuan harus lebih dari nol');
      if(seenCodes.has(key))addError(rowNo,'unitName',`Satuan ${row.unitName} untuk SKU ${row.sku} muncul lebih dari sekali`);
      seenCodes.add(key);
      if(row.barcode&&seenBarcodes.has(row.barcode))addError(rowNo,'barcode',`Barcode ${row.barcode} muncul lebih dari sekali`);
      if(row.barcode)seenBarcodes.add(row.barcode);
      rows.push(row);return;
    }
    if(kind==='PRODUCT_VARIANTS'){
      const row={sku:String(raw.sku??'').trim().toUpperCase(),familyCode:String(raw.familyCode??'').trim().toUpperCase(),variantGroup:String(raw.variantGroup??'').trim(),variantName:String(raw.variantName??'').trim()};
      if(!row.sku)addError(rowNo,'sku','SKU wajib diisi');
      if(!row.familyCode)addError(rowNo,'familyCode','Kode etalase wajib diisi');
      if(!row.variantGroup)addError(rowNo,'variantGroup','Kelompok varian wajib diisi');
      if(!row.variantName)addError(rowNo,'variantName','Nama varian wajib diisi');
      if(seenCodes.has(row.sku))addError(rowNo,'sku',`SKU ${row.sku} muncul lebih dari sekali`);
      seenCodes.add(row.sku);rows.push(row);return;
    }
    if(kind==='PRODUCT_OPTIONS'){
      const row={sku:String(raw.sku??'').trim().toUpperCase(),optionName:String(raw.optionName??'').trim(),optionValue:String(raw.optionValue??'').trim(),position:importNumber(raw.position)??1};
      const key=`${row.sku}:${row.optionName.toLowerCase()}`;
      if(!row.sku)addError(rowNo,'sku','SKU wajib diisi');
      if(!row.optionName)addError(rowNo,'optionName','Nama opsi wajib diisi');
      if(!row.optionValue)addError(rowNo,'optionValue','Nilai opsi wajib diisi');
      if(!(row.position>=1&&row.position<=99))addError(rowNo,'position','Urutan harus 1 sampai 99');
      if(seenCodes.has(key))addError(rowNo,'optionName',`Opsi ${row.optionName} untuk SKU ${row.sku} muncul lebih dari sekali`);
      seenCodes.add(key);rows.push(row);return;
    }
    if(kind==='PRODUCT_PRICES'){
      const row={sku:String(raw.sku??'').trim().toUpperCase(),customerGroup:String(raw.customerGroup??'').trim(),minQty:importNumber(raw.minQty),unitPrice:importNumber(raw.unitPrice)};
      const key=`${row.sku}:${row.customerGroup.toLowerCase()}:${row.minQty}`;
      if(!row.sku)addError(rowNo,'sku','SKU wajib diisi');
      if(!row.customerGroup)addError(rowNo,'customerGroup','Tipe pelanggan wajib diisi');
      if(!(row.minQty>0))addError(rowNo,'minQty','Minimal pembelian harus lebih dari nol');
      if(!(row.unitPrice>0))addError(rowNo,'unitPrice','Harga harus lebih dari nol');
      if(seenCodes.has(key))addError(rowNo,'minQty',`Tingkat harga yang sama untuk SKU ${row.sku} muncul lebih dari sekali`);
      seenCodes.add(key);rows.push(row);return;
    }
    const row = { code: String(raw.code ?? '').trim().toUpperCase(), name: String(raw.name ?? '').trim(), phone: String(raw.phone ?? '').trim() };
    if (!row.code) addError(rowNo, 'code', 'Kode wajib diisi');
    if (!row.name) addError(rowNo, 'name', 'Nama wajib diisi');
    if (seenCodes.has(row.code)) addError(rowNo, 'code', `Kode ${row.code} muncul lebih dari sekali`);
    if (row.code) seenCodes.add(row.code);
    if (kind === 'CUSTOMERS') {
      const group = String(raw.groupId ?? 'retail').trim().toLowerCase();
      row.groupId = ['retail','ecer','eceran','umum'].includes(group) ? 'retail' : ['wholesale','grosir'].includes(group) ? 'wholesale' : group;
      if(!row.groupId)addError(rowNo,'groupId','Tipe pelanggan wajib diisi');
      row.email=String(raw.email??'').trim().toLowerCase();
      row.address=String(raw.address??'').trim();
      const loyaltyPoints=importNumber(raw.loyaltyPoints);
      row.loyaltyPoints=Number.isFinite(loyaltyPoints)?Math.max(0,Math.floor(loyaltyPoints)):0;
    } else row.address = String(raw.address ?? '').trim();
    rows.push(row);
  });
  return { rows, errors };
}

function normalizeKaspinCustomerGroups(value){
  const definitions=Array.isArray(value)?value:[];
  const groups=new Map();
  for(const definition of definitions){
    const name=String(typeof definition==='string'?definition:definition?.name??'').trim().replace(/\s+/g,' ');
    if(name.length<2||name.length>50)continue;
    const lower=name.toLocaleLowerCase('id');
    const id=['retail','ecer','eceran','umum'].includes(lower)?'retail':['wholesale','grosir'].includes(lower)?'wholesale':lower==='member'?'member':lower.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
    if(!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(id))continue;
    const canonicalName=id==='retail'?'Eceran':id==='wholesale'?'Grosir':id==='member'?'Member':name;
    if(!groups.has(id))groups.set(id,{id,name:canonicalName,inputName:name});
  }
  return [...groups.values()];
}

async function ensureKaspinCustomerGroups(context,definitions){
  const requested=normalizeKaspinCustomerGroups(definitions);
  if(!requested.length)return [];
  const existing=await rest('customer_price_groups',`tenant_id=eq.${encodeURIComponent(context.tenantId)}&select=id,name,active,sort_order`);
  const byId=new Map(existing.map((group)=>[String(group.id).toLowerCase(),group]));
  const byName=new Map(existing.map((group)=>[String(group.name).toLocaleLowerCase('id'),group]));
  let sortOrder=Math.max(0,...existing.map((group)=>Number(group.sort_order??0)));
  for(const group of requested){
    const found=byId.get(group.id)??byName.get(group.name.toLocaleLowerCase('id'))??byName.get(group.inputName.toLocaleLowerCase('id'));
    if(found){
      if(found.active===false)await rest('customer_price_groups',`tenant_id=eq.${encodeURIComponent(context.tenantId)}&id=eq.${encodeURIComponent(found.id)}`,{method:'PATCH',prefer:'return=minimal',body:{active:true}});
      continue;
    }
    sortOrder+=10;
    const created=await rest('customer_price_groups','',{method:'POST',prefer:'return=representation',body:{tenant_id:context.tenantId,id:group.id,name:group.name,is_default:group.id==='retail',active:true,sort_order:sortOrder}});
    const row=created[0]??{...group,active:true,sort_order:sortOrder};byId.set(String(row.id).toLowerCase(),row);byName.set(String(row.name).toLocaleLowerCase('id'),row);
  }
  return requested;
}

async function reconcileKaspinCustomerHistory(context,session){
  let reconciliation=null,pointReconstruction=null;
  try{
    reconciliation=await rpc('reconcile_kaspin_customer_sales_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id
    });
  }catch(error){
    if(!/reconcile_kaspin_customer_sales_v1|schema cache|function|PGRST202/i.test(error.message))throw error;
  }
  try{
    pointReconstruction=await rpc('reconstruct_kaspin_points_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id
    });
  }catch(error){
    if(!/reconstruct_kaspin_points_v1|schema cache|function|PGRST202/i.test(error.message))throw error;
  }
  return {reconciliation,pointReconstruction};
}

function kaspinProductResolver(products,units){
  const byId=new Map(products.map((product)=>[product.id,product]));
  const direct=new Map(products.map((product)=>[String(product.sku).trim().toUpperCase(),product]));
  units.forEach((unit)=>{if(unit.barcode&&byId.has(unit.product_id))direct.set(String(unit.barcode).trim().toUpperCase(),byId.get(unit.product_id));});
  const legacy=new Map();
  products.forEach((product)=>{const code=String(product.legacy_code??'').trim().toUpperCase();if(!code)return;if(!legacy.has(code))legacy.set(code,[]);legacy.get(code).push(product);});
  const cleanName=(value)=>String(value??'').toLocaleLowerCase('id').normalize('NFKD').replace(/[^a-z0-9]+/g,' ').trim();
  return(code,name)=>{
    const key=String(code??'').trim().toUpperCase();
    if(direct.has(key))return direct.get(key);
    const candidates=legacy.get(key)??[];
    if(candidates.length===1)return candidates[0];
    const wanted=cleanName(name);
    if(!wanted)return null;
    const exact=candidates.filter((product)=>cleanName(product.name)===wanted);
    if(exact.length===1)return exact[0];
    const close=candidates.filter((product)=>{const candidate=cleanName(product.name);return candidate.includes(wanted)||wanted.includes(candidate);});
    return close.length===1?close[0]:null;
  };
}

async function previewKaspinFifo(context,input){
  const errors=[],warnings=[],locationId=input.locationId||null;
  if(!context.locationIds.includes(locationId))errors.push({row:0,field:'locationId',message:'Pilih lokasi stok yang benar'});
  const rawRows=Array.isArray(input.rows)?input.rows:[],rawCapital=Array.isArray(input.capitalRows)?input.capitalRows:[];
  if(!rawRows.length)errors.push({row:0,field:'file',message:'File pembelian tidak memiliki baris yang dapat dibaca'});
  if(!rawCapital.length)errors.push({row:0,field:'capitalFile',message:'File Laporan Modal tidak memiliki baris yang dapat dibaca'});
  if(rawRows.length>10000||rawCapital.length>10000)errors.push({row:0,field:'file',message:'Maksimal 10.000 baris per file'});

  const [products,units,balances]=await Promise.all([
    restAll('products',`tenant_id=eq.${context.tenantId}&select=id,sku,name,legacy_code`),
    restAll('product_units',`tenant_id=eq.${context.tenantId}&barcode=not.is.null&select=product_id,barcode`),
    locationId?restAll('stock_balances',`tenant_id=eq.${context.tenantId}&location_id=eq.${locationId}&select=product_id,quantity,avg_cost`):Promise.resolve([])
  ]);
  const resolveProduct=kaspinProductResolver(products,units);
  const balanceByProduct=new Map(balances.map((balance)=>[balance.product_id,balance]));
  const rows=[];
  rawRows.forEach((raw,index)=>{
    const productCode=String(raw.productCode??'').trim().toUpperCase(),product=resolveProduct(productCode,raw.productName);
    const quantity=importNumber(raw.quantity),unitCost=importNumber(raw.unitCost),occurredAt=new Date(raw.occurredAt);
    if(!product){warnings.push({row:index+2,message:`Pembelian ${raw.productName||productCode||'-'} dilewati karena kode ${productCode||'-'} belum ada di Nusa POS`});return;}
    if(!String(raw.transactionCode??'').trim()||!(quantity>0)||!(unitCost>=0)||Number.isNaN(occurredAt.getTime())){
      warnings.push({row:index+2,message:`Baris pembelian ${productCode} dilewati karena transaksi, tanggal, jumlah, atau modal tidak valid`});return;
    }
    rows.push({
      transactionCode:String(raw.transactionCode).trim(),occurredAt:occurredAt.toISOString(),
      productId:product.id,productCode,productName:product.name,quantity,unitCost,
      supplierName:String(raw.supplierName??'Supplier Kaspin').trim()||'Supplier Kaspin',
      cashier:String(raw.cashier??'').trim(),paymentType:String(raw.paymentType??'').trim(),paymentMethod:String(raw.paymentMethod??'').trim()
    });
  });
  const capitalByProduct=new Map();
  rawCapital.forEach((raw,index)=>{
    const productCode=String(raw.productCode??'').trim().toUpperCase(),product=resolveProduct(productCode,raw.productName);
    const stock=importNumber(raw.stock),remainingCapital=importNumber(raw.remainingCapital);
    if(!product){warnings.push({row:index+2,message:`Modal ${raw.productName||productCode||'-'} dilewati karena kode ${productCode||'-'} belum ada di Nusa POS`});return;}
    if(!(stock>=0)||!(remainingCapital>=0)){warnings.push({row:index+2,message:`Modal ${productCode} dilewati karena stok atau sisa modal tidak valid`});return;}
    const balance=balanceByProduct.get(product.id),currentStock=Number(balance?.quantity??0);
    if(Math.abs(currentStock-stock)>0.000001)warnings.push({row:index+2,message:`Stok ${product.name} di laporan ${stock}, sedangkan di Nusa ${currentStock}; jumlah Nusa dipertahankan`});
    capitalByProduct.set(product.id,{productId:product.id,productCode,productName:product.name,stock,remainingCapital,currentStock});
  });
  const capitalRows=[...capitalByProduct.values()];
  if(!rows.length)errors.push({row:0,field:'file',message:'Tidak ada pembelian yang cocok dengan produk Nusa POS'});
  const receiptCount=new Set(rows.map((row)=>row.transactionCode)).size;
  const productCount=new Set([...rows.map((row)=>row.productId),...capitalRows.map((row)=>row.productId)]).size;
  return {
    valid:errors.length===0,kind:'KASPIN_FIFO',mode:'MIXED',locationId,rows,capitalRows,errors,warnings,
    summary:{total:rows.length,create:receiptCount,update:productCount,error:errors.length}
  };
}

async function previewKaspinSales(context,input){
  const errors=[],warnings=[],rawRows=Array.isArray(input.rows)?input.rows:[],rawReceipts=Array.isArray(input.receipts)?input.receipts:[];
  if(!rawRows.length)errors.push({row:0,field:'file',message:'File penjualan tidak memiliki baris yang dapat dibaca'});
  if(rawRows.length+rawReceipts.length>12000)errors.push({row:0,field:'file',message:'Maksimal 12.000 baris dan struk per paket'});
  const [products,units]=await Promise.all([
    restAll('products',`tenant_id=eq.${context.tenantId}&select=id,sku,name,legacy_code`),
    restAll('product_units',`tenant_id=eq.${context.tenantId}&barcode=not.is.null&select=product_id,barcode`)
  ]);
  const resolveProduct=kaspinProductResolver(products,units);

  const receiptMap=new Map();
  const receiptSources=rawReceipts.length?rawReceipts:[...new Map(rawRows.map((row)=>[String(row.transactionCode??'').trim(),row])).values()];
  receiptSources.forEach((raw,index)=>{
    const transactionCode=String(raw.transactionCode??'').trim(),occurredAt=new Date(raw.occurredAt);
    const grandTotal=importNumber(raw.grandTotal),profit=importNumber(raw.profit);
    if(!transactionCode||!(grandTotal>=0)||Number.isNaN(occurredAt.getTime())){
      warnings.push({row:index+2,message:`Aktivitas ${transactionCode||'-'} dilewati karena tanggal atau total tidak valid`});return;
    }
    receiptMap.set(transactionCode,{
      receiptOnly:true,transactionCode,occurredAt:occurredAt.toISOString(),grandTotal,
      profit:profit==null?null:profit,tendered:Math.max(0,importNumber(raw.tendered)??grandTotal),
      change:Math.max(0,importNumber(raw.change)??0),transactionDiscount:Math.max(0,importNumber(raw.transactionDiscount)??0),
      cashier:String(raw.cashier??'').trim(),paymentType:String(raw.paymentType??'').trim(),
      paymentMethod:String(raw.paymentMethod??'').trim()||'Cash',customerEmail:String(raw.customerEmail??'').trim(),
      customerName:String(raw.customerName??'').trim(),note:String(raw.note??'').trim(),
      status:String(raw.status??'').toUpperCase()==='VOIDED'||grandTotal===0?'VOIDED':'COMPLETED',
      voidReason:String(raw.returnReason??raw.voidReason??'').trim()||(grandTotal===0?'Transaksi Rp0 dari riwayat Kasir Pintar':''),
      legacyLines:[]
    });
  });
  rawRows.filter((row)=>row.receiptOnly&&Array.isArray(row.legacyLines)).forEach((row)=>{
    const receipt=receiptMap.get(String(row.transactionCode??'').trim());
    if(receipt)receipt.legacyLines=row.legacyLines.map((line)=>({...line}));
  });
  const candidateRows=[];
  rawRows.forEach((raw,index)=>{
    if(raw.receiptOnly)return;
    const transactionCode=String(raw.transactionCode??'').trim();
    const productCode=String(raw.productCode??'').trim().toUpperCase(),product=resolveProduct(productCode,raw.productName);
    const quantity=importNumber(raw.quantity),unitCost=importNumber(raw.unitCost),unitPrice=importNumber(raw.unitPrice);
    const lineGross=importNumber(raw.lineGross),grandTotal=importNumber(raw.grandTotal),occurredAt=new Date(raw.occurredAt);
    if(!transactionCode||!product||!(quantity>0)||!(unitCost>=0)||!(unitPrice>=0)||!(lineGross>=0)||!(grandTotal>=0)||Number.isNaN(occurredAt.getTime())){
      const receipt=receiptMap.get(transactionCode);
      if(receipt)receipt.legacyLines.push({productCode,productName:String(raw.productName??'Produk lama').trim()||'Produk lama',quantity,unitCost,unitPrice,lineGross});
      warnings.push({row:index+2,message:`Detail ${raw.productName||productCode||'-'} pada struk ${transactionCode||'-'} disimpan sebagai arsip karena produknya belum cocok atau datanya tidak valid`});
      return;
    }
    candidateRows.push({
      transactionCode,occurredAt:occurredAt.toISOString(),productId:product.id,productCode,
      productName:product.name,quantity,unitCost,unitPrice,lineGross,
      lineDiscount:Math.max(0,importNumber(raw.lineDiscount)??0),grandTotal,
      profit:importNumber(raw.profit),tendered:Math.max(0,importNumber(raw.tendered)??grandTotal),
      change:Math.max(0,importNumber(raw.change)??0),
      transactionDiscount:Math.max(0,importNumber(raw.transactionDiscount)??0),
      cashier:String(raw.cashier??'').trim(),paymentType:String(raw.paymentType??'').trim(),
      paymentMethod:String(raw.paymentMethod??'').trim()||'Cash',
      customerEmail:String(raw.customerEmail??'').trim(),customerName:String(raw.customerName??'').trim(),
      note:String(raw.note??'').trim()
    });
  });
  const rows=[...receiptMap.values(),...candidateRows];
  const transactionCount=receiptMap.size;
  if(!rows.length)errors.push({row:0,field:'file',message:'Tidak ada aktivitas penjualan yang dapat dimigrasikan'});
  return {
    valid:errors.length===0,kind:'KASPIN_SALES',mode:'MIXED',outletId:context.outlet.id,
    rows,errors,warnings,
    summary:{total:rows.length,create:transactionCount,update:0,error:errors.length,
      completed:[...receiptMap.values()].filter((row)=>row.status==='COMPLETED').length,
      voided:[...receiptMap.values()].filter((row)=>row.status==='VOIDED').length,
      archivedLines:[...receiptMap.values()].reduce((sum,row)=>sum+row.legacyLines.length,0)}
  };
}

async function previewImport(context, input) {
  const kind = String(input.kind ?? '').toUpperCase();
  if(kind==='KASPIN_FIFO')return previewKaspinFifo(context,input);
  if(kind==='KASPIN_SALES')return previewKaspinSales(context,input);
  const mode=['CREATE_ONLY','UPDATE_ONLY'].includes(String(input.mode??'').toUpperCase())?String(input.mode).toUpperCase():'MIXED';
  const supported=['PRODUCTS','PRODUCT_FAMILIES','PRODUCT_UNITS','PRODUCT_VARIANTS','PRODUCT_OPTIONS','PRODUCT_PRICES','CUSTOMERS','SUPPLIERS'];
  if (!supported.includes(kind)) return { valid: false, kind, rows: [], errors: [{ row: 0, field: 'kind', message: 'Jenis impor tidak valid' }] };
  const normalized = normalizeImportRows(kind, input.rows);
  const locationId = input.locationId || null;
  if(kind==='PRODUCT_FAMILIES'){
    const [families,unitBarcodes,familyBarcodes]=await Promise.all([
      restAll('product_families',`tenant_id=eq.${context.tenantId}&select=id,code,name`),
      restAll('product_units',`tenant_id=eq.${context.tenantId}&barcode=not.is.null&select=barcode`),
      restAll('product_family_barcodes',`tenant_id=eq.${context.tenantId}&select=family_id,barcode`)
    ]);
    const existing=new Map(families.map((row)=>[String(row.code).toUpperCase(),row]));
    const unitCodes=new Set(unitBarcodes.map((row)=>String(row.barcode)));
    const ownerByBarcode=new Map(familyBarcodes.map((row)=>[String(row.barcode),row.family_id]));
    normalized.rows.forEach((row,index)=>{
      if(row.sharedBarcode&&unitCodes.has(row.sharedBarcode))normalized.errors.push({row:index+2,field:'sharedBarcode',message:'Barcode bersama sudah dipakai langsung oleh satu SKU'});
      const owner=ownerByBarcode.get(row.sharedBarcode),family=existing.get(row.familyCode);
      if(row.sharedBarcode&&owner&&owner!==family?.id)normalized.errors.push({row:index+2,field:'sharedBarcode',message:'Barcode bersama sudah dipakai etalase lain'});
    });
    return {valid:normalized.errors.length===0,kind,mode,rows:normalized.rows,errors:normalized.errors,summary:{total:normalized.rows.length,create:normalized.rows.filter((row)=>!existing.has(row.familyCode)).length,update:normalized.rows.filter((row)=>existing.has(row.familyCode)).length,error:normalized.errors.length}};
  }
  if(['PRODUCT_VARIANTS','PRODUCT_OPTIONS'].includes(kind)){
    const [products,families]=await Promise.all([
      restAll('products',`tenant_id=eq.${context.tenantId}&select=id,sku`),
      kind==='PRODUCT_VARIANTS'?restAll('product_families',`tenant_id=eq.${context.tenantId}&select=id,code,name`):Promise.resolve([])
    ]);
    const productCodes=new Set(products.map((row)=>String(row.sku).toUpperCase()));
    const familyByCode=new Map(families.map((row)=>[String(row.code).toUpperCase(),row]));
    const namesByInputCode=new Map();
    normalized.rows.forEach((row,index)=>{
      if(!productCodes.has(row.sku))normalized.errors.push({row:index+2,field:'sku',message:`SKU ${row.sku||'-'} belum ada. Import Barang utama terlebih dahulu`});
      if(kind==='PRODUCT_VARIANTS'){
        const previousName=namesByInputCode.get(row.familyCode),existing=familyByCode.get(row.familyCode);
        if(previousName&&previousName.toLocaleLowerCase('id')!==row.variantGroup.toLocaleLowerCase('id'))normalized.errors.push({row:index+2,field:'variantGroup',message:`Kode etalase ${row.familyCode} memakai lebih dari satu nama`});
        if(existing&&existing.name.toLocaleLowerCase('id')!==row.variantGroup.toLocaleLowerCase('id'))normalized.errors.push({row:index+2,field:'variantGroup',message:`Kode etalase ${row.familyCode} sudah bernama ${existing.name}`});
        namesByInputCode.set(row.familyCode,row.variantGroup);
      }
    });
    return {valid:normalized.errors.length===0,kind,mode,rows:normalized.rows,errors:normalized.errors,summary:{total:normalized.rows.length,create:kind==='PRODUCT_VARIANTS'?[...namesByInputCode.keys()].filter((code)=>!familyByCode.has(code)).length:0,update:normalized.rows.length,error:normalized.errors.length}};
  }
  if (kind === 'PRODUCTS' && normalized.rows.some((row) => row.openingQty !== null) && !context.locationIds.includes(locationId)) {
    normalized.errors.push({ row: 0, field: 'locationId', message: 'Pilih lokasi untuk stok awal' });
  }
  const productExtension=['PRODUCT_UNITS','PRODUCT_VARIANTS','PRODUCT_PRICES'].includes(kind);
  const table = kind === 'PRODUCTS'||productExtension ? 'products' : kind === 'CUSTOMERS' ? 'customers' : 'suppliers';
  const codeField = kind === 'PRODUCTS'||productExtension ? 'sku' : 'code';
  const existing = await restAll(table, `tenant_id=eq.${context.tenantId}&select=id,${codeField}`);
  const existingCodes = new Set(existing.map((row) => String(row[codeField]).toUpperCase()));
  if(kind==='CUSTOMERS'){
    const groups=await rest('customer_price_groups',`tenant_id=eq.${context.tenantId}&active=eq.true&select=id,name`);
    const groupByInput=new Map(groups.flatMap((group)=>[[String(group.id).toLowerCase(),group.id],[String(group.name).toLowerCase(),group.id]]));
    if(String(input.source??'').toUpperCase()==='KASPIN')normalizeKaspinCustomerGroups(input.customerGroups).forEach((group)=>{
      if(!groupByInput.has(group.id))groupByInput.set(group.id,group.id);
      if(!groupByInput.has(group.name.toLocaleLowerCase('id')))groupByInput.set(group.name.toLocaleLowerCase('id'),group.id);
      if(!groupByInput.has(group.inputName.toLocaleLowerCase('id')))groupByInput.set(group.inputName.toLocaleLowerCase('id'),group.id);
    });
    normalized.rows.forEach((row,index)=>{
      const groupId=groupByInput.get(String(row.groupId).toLowerCase());
      if(!groupId)normalized.errors.push({row:index+2,field:'groupId',message:`Tipe pelanggan ${row.groupId||'-'} belum dibuat atau tidak aktif`});
      else row.groupId=groupId;
    });
  }
  if (kind === 'PRODUCTS') {
    const [units,familyBarcodes] = await Promise.all([
      restAll('product_units', `tenant_id=eq.${context.tenantId}&barcode=not.is.null&select=product_id,barcode`),
      restAll('product_family_barcodes',`tenant_id=eq.${context.tenantId}&select=barcode`).catch(()=>[])
    ]);
    const sharedCodes=new Set(familyBarcodes.map((row)=>String(row.barcode)));
    const productCodeById = new Map(existing.map((row) => [row.id,String(row.sku).toUpperCase()]));
    const barcodeOwner = new Map(units.map((unit) => [unit.barcode,productCodeById.get(unit.product_id)]));
    normalized.rows.forEach((row,index) => {
      for (const [field,barcode] of [['baseBarcode',row.baseBarcode],['bulkBarcode',row.bulkBarcode]]) {
        const owner = barcodeOwner.get(barcode);
        if (barcode && owner && owner !== row.sku) normalized.errors.push({ row: index+2, field, message: `Barcode sudah digunakan SKU ${owner}` });
        if(barcode&&sharedCodes.has(barcode))normalized.errors.push({row:index+2,field,message:'Barcode adalah barcode bersama etalase dan tidak boleh dipakai langsung oleh SKU'});
      }
    });
    normalized.rows.forEach((row,index) => {
      if(row.openingQty!==null&&existingCodes.has(row.sku))normalized.errors.push({row:index+2,field:'openingQty',message:'Kosongkan stok awal saat mengedit barang; gunakan stok opname atau restok'});
      if(mode==='CREATE_ONLY'&&row.sku&&existingCodes.has(row.sku))normalized.errors.push({row:index+2,field:'sku',message:`SKU ${row.sku} sudah ada. Gunakan halaman Edit produk massal`});
      if(mode==='UPDATE_ONLY'&&!row.sku)normalized.errors.push({row:index+2,field:'sku',message:'SKU wajib diisi saat mengedit produk'});
      if(mode==='UPDATE_ONLY'&&row.sku&&!existingCodes.has(row.sku))normalized.errors.push({row:index+2,field:'sku',message:`SKU ${row.sku} belum ada. Gunakan halaman Import produk baru`});
    });
  }
  if(productExtension){
    normalized.rows.forEach((row,index)=>{
      if(!existingCodes.has(row.sku))normalized.errors.push({row:index+2,field:'sku',message:`SKU ${row.sku||'-'} belum ada. Import Barang utama terlebih dahulu`});
    });
    if(kind==='PRODUCT_UNITS'){
      const units=await restAll('product_units',`tenant_id=eq.${context.tenantId}&select=product_id,name,barcode,factor_to_base`);
      const skuByProduct=new Map(existing.map((product)=>[product.id,String(product.sku).toUpperCase()]));
      const barcodeOwner=new Map(units.filter((unit)=>unit.barcode).map((unit)=>[unit.barcode,skuByProduct.get(unit.product_id)]));
      normalized.rows.forEach((row,index)=>{
        const owner=barcodeOwner.get(row.barcode);
        if(row.barcode&&owner&&owner!==row.sku)normalized.errors.push({row:index+2,field:'barcode',message:`Barcode sudah digunakan SKU ${owner}`});
      });
      normalized.existingKeys=new Set(units.map((unit)=>`${skuByProduct.get(unit.product_id)}:${String(unit.name).toLowerCase()}`));
    }
    if(kind==='PRODUCT_PRICES'){
      const groups=await rest('customer_price_groups',`tenant_id=eq.${context.tenantId}&active=eq.true&select=id,name`);
      const groupByInput=new Map(groups.flatMap((group)=>[[String(group.id).toLowerCase(),group.id],[String(group.name).toLowerCase(),group.id]]));
      normalized.rows.forEach((row,index)=>{
        const groupId=groupByInput.get(row.customerGroup.toLowerCase());
        if(!groupId)normalized.errors.push({row:index+2,field:'customerGroup',message:`Tipe pelanggan ${row.customerGroup||'-'} belum dibuat atau tidak aktif`});
        else if(groupId==='retail')normalized.errors.push({row:index+2,field:'customerGroup',message:'Harga Umum diubah melalui file Barang, bukan file Harga Pelanggan'});
        else row.customerGroup=groupId;
      });
      const rules=await restAll('price_rules',`tenant_id=eq.${context.tenantId}&starts_at=is.null&ends_at=is.null&select=product_id,customer_group_id,min_base_qty`);
      const skuByProduct=new Map(existing.map((product)=>[product.id,String(product.sku).toUpperCase()]));
      normalized.existingKeys=new Set(rules.map((rule)=>`${skuByProduct.get(rule.product_id)}:${rule.customer_group_id}:${Number(rule.min_base_qty)}`));
    }
  }
  const extensionKey=(row)=>kind==='PRODUCT_UNITS'?`${row.sku}:${row.unitName.toLowerCase()}`:kind==='PRODUCT_PRICES'?`${row.sku}:${row.customerGroup}:${Number(row.minQty)}`:row.sku;
  const summary = {
    total: normalized.rows.length,
    create: productExtension?(kind==='PRODUCT_VARIANTS'?0:normalized.rows.filter((row)=>!normalized.existingKeys?.has(extensionKey(row))).length):normalized.rows.filter((row) => !existingCodes.has(String(row[codeField]).toUpperCase())).length,
    update: productExtension?(kind==='PRODUCT_VARIANTS'?normalized.rows.length:normalized.rows.filter((row)=>normalized.existingKeys?.has(extensionKey(row))).length):normalized.rows.filter((row) => existingCodes.has(String(row[codeField]).toUpperCase())).length,
    error: normalized.errors.length
  };
  return { valid: normalized.errors.length === 0, kind, mode, locationId, rows: normalized.rows, errors: normalized.errors, summary };
}

function backupChecksum(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function buildBackup(context, session) {
  let tables;
  try {
    tables = await rpc('export_tenant_backup_v1',{p_tenant_id:context.tenantId});
  } catch (error) {
    if(/export_tenant_backup_v1|schema cache|function|PGRST202/i.test(error.message)){
      throw Object.assign(new Error('Backup terpusat belum aktif. Jalankan migrasi backup Cloudflare terbaru.'),{status:503});
    }
    throw error;
  }
  if(!tables||Array.isArray(tables)||typeof tables!=='object'){
    throw Object.assign(new Error('Database mengembalikan backup yang tidak valid'),{status:502});
  }
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
  const productIds=(input.lines??[]).map((line)=>line.productId);
  const [products,promotions]=await Promise.all([
    loadQuoteProducts(context.tenantId,productIds,context.storeLocation?.id,context.outlet.id),
    loadPromotions(context.tenantId,context.outlet.id)
  ]);
  return quoteBasket({
    lines: input.lines,
    customerGroupId: input.customerGroupId,
    products,
    promotions,
    at: input.at ? new Date(input.at) : new Date()
  });
}

function restorePayload(snapshot) {
  return Object.fromEntries(RESTORE_TABLES.map((table)=>[
    table,Array.isArray(snapshot.tables?.[table])?snapshot.tables[table]:[]
  ]));
}

function restorePreview(snapshot) {
  const tables=restorePayload(snapshot);
  const groups={
    catalog:['products','product_units','price_rules','outlet_price_overrides'],
    transactions:['sales','sale_items','payments','shifts','cash_movements','customer_returns','supplier_returns'],
    inventory:['stock_balances','stock_ledger','inventory_batches','inventory_batch_movements','stock_transfers','stock_counts'],
    relations:['customers','suppliers','customer_account_entries','supplier_bills','supplier_payable_entries'],
    growth:['promotions','promotion_versions','vouchers','customer_point_entries','customer_tiers'],
    finance:['accounting_periods','journal_entries','journal_lines','outlet_expenses'],
    workforce:['employee_schedules','attendance_records','employee_targets','approval_requests']
  };
  const count=(names)=>names.reduce((sum,table)=>sum+tables[table].length,0);
  return {
    totalRows:Object.values(tables).reduce((sum,rows)=>sum+rows.length,0),
    groups:Object.fromEntries(Object.entries(groups).map(([name,names])=>[name,count(names)])),
    tableCounts:Object.fromEntries(Object.entries(tables).map(([table,rows])=>[table,rows.length]))
  };
}

async function requireRegisteredBackup(tenantId,snapshot) {
  const rows=await rest('backup_exports',
    `tenant_id=eq.${encodeURIComponent(tenantId)}&checksum_sha256=eq.${encodeURIComponent(snapshot.checksum)}&status=eq.COMPLETED&select=id&limit=1`);
  if(!rows[0])throw Object.assign(new Error('File ini belum tercatat sebagai backup resmi usaha ini'),{status:422});
}

function maskEmail(email) {
  const [name='',domain='']=String(email??'').split('@');
  if(!domain)return 'email Owner';
  return `${name.slice(0,2)}${'*'.repeat(Math.max(2,name.length-2))}@${domain}`;
}

async function resolveSaleCustomerGroup(context, input) {
  if (!input.customerId) return 'retail';
  const rows = await rest('customers', `tenant_id=eq.${encodeURIComponent(context.tenantId)}&id=eq.${encodeURIComponent(input.customerId)}&active=eq.true&select=group_id&limit=1`);
  if (!rows[0]) {
    const error = new Error('Pelanggan tidak ditemukan atau sudah nonaktif');
    error.status = 422;
    throw error;
  }
  return rows[0].group_id || 'retail';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeOptionalUuid(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  if (!UUID_PATTERN.test(normalized)) {
    const error = new Error(`${label} tidak valid. Muat ulang data lalu coba lagi.`);
    error.status = 422;
    throw error;
  }
  return normalized;
}

async function normalizeSaleCustomer(context, input) {
  const normalized = {
    ...input,
    customerId: normalizeOptionalUuid(input.customerId, 'Pelanggan'),
    shiftId: normalizeOptionalUuid(input.shiftId, 'Shift')
  };
  return { ...normalized, customerGroupId: await resolveSaleCustomerGroup(context, normalized) };
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
    return send(response, 200, { status: 'ok', version: '2.17.1-cloud', database: 'supabase', configured: Boolean(config.url && config.anon && config.service) });
  }

  if(request.method==='POST'&&route==='webhooks/midtrans'){
    let payload;
    try{payload=bodyOf(request);}catch{throw Object.assign(new Error('Payload webhook Midtrans bukan JSON yang valid'),{status:400});}
    const orderId=String(payload.order_id??'').trim(),statusCode=String(payload.status_code??''),grossAmount=String(payload.gross_amount??''),signature=String(payload.signature_key??'');
    if(!orderId||!statusCode||!grossAmount||!signature)throw Object.assign(new Error('Payload webhook Midtrans tidak lengkap'),{status:400});
    const rows=await rest('payment_gateway_intents',`provider=eq.MIDTRANS&order_id=eq.${encodeURIComponent(orderId)}&select=*&limit=1`);
    const intent=rows[0];
    if(!intent)throw Object.assign(new Error('Intent Midtrans tidak ditemukan'),{status:404});
    const config=await midtransAccount(intent.tenant_id,intent.environment);
    if(intent.gateway_account_id&&intent.gateway_account_id!==config.id)throw Object.assign(new Error('Akun Midtrans intent tidak cocok dengan tenant'),{status:409});
    const expected=createHash('sha512').update(`${orderId}${statusCode}${grossAmount}${config.serverKey}`).digest('hex');
    if(!safeSecretEqual(signature,expected))throw Object.assign(new Error('Signature webhook Midtrans tidak valid'),{status:401});
    const verified=await midtransRequest(config,`/v2/${encodeURIComponent(orderId)}/status`);
    const updated=await updateMidtransIntent(intent,verified,'WEBHOOK',true);
    return send(response,200,{received:true,environment:intent.environment,status:updated.status,operationalMutation:false});
  }

  if (request.method === 'POST' && route === 'register-owner') {
    const input = bodyOf(request);
    const ownerName = String(input.ownerName ?? '').trim().replace(/\s+/g, ' ');
    const businessName = String(input.businessName ?? '').trim().replace(/\s+/g, ' ');
    const email = String(input.email ?? '').trim().toLowerCase();
    const password = String(input.password ?? '');
    if (ownerName.length < 2 || ownerName.length > 100) {
      const error = new Error('Nama Owner harus berisi 2 sampai 100 karakter');
      error.status = 400;
      throw error;
    }
    if (businessName.length < 2 || businessName.length > 120) {
      const error = new Error('Nama usaha harus berisi 2 sampai 120 karakter');
      error.status = 400;
      throw error;
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const error = new Error('Alamat email Owner tidak valid');
      error.status = 400;
      throw error;
    }
    if (password.length < 8 || password.length > 128) {
      const error = new Error('Kata sandi harus berisi 8 sampai 128 karakter');
      error.status = 400;
      throw error;
    }
    const config = env();
    // Pulihkan akun yang identitas Auth-nya sudah terbentuk, tetapi pembuatan
    // profil/workspace sempat terputus (misalnya koneksi atau email bermasalah).
    let recoveredAuth=null;
    try {
      recoveredAuth=await passwordAuth(email,password);
    } catch(error) {
      if(![400,401,403].includes(error.status))throw error;
    }
    if(recoveredAuth?.user?.id){
      const existingProfile=await profileFor(recoveredAuth.user.id);
      if(existingProfile){
        const error=new Error('Email sudah terdaftar. Silakan masuk sebagai Owner.');error.status=409;throw error;
      }
      const profile=await provisionOwnerWorkspace(recoveredAuth.user,{ownerName,businessName,email});
      setRefreshCookie(response,recoveredAuth.refresh_token);
      return send(response,201,{...authPayload(recoveredAuth,profile),registered:true,recovered:true});
    }
    const existingUser=await adminAuthUserForEmail(email);
    if(existingUser){
      const existingProfile=await profileFor(existingUser.id);
      if(existingProfile){
        const error=new Error('Email sudah terdaftar. Silakan masuk sebagai Owner.');error.status=409;throw error;
      }
      if(!existingUser.email_confirmed_at){
        await supabase('/auth/v1/resend',{
          method:'POST',token:config.anon,body:{type:'signup',email}
        });
        return send(response,202,{
          registered:true,requiresEmailConfirmation:true,email,
          message:'Akun sudah dibuat tetapi email belum dikonfirmasi. Tautan konfirmasi terbaru telah dikirim ulang.'
        });
      }
      const error=new Error('Email sudah pernah didaftarkan. Gunakan kata sandi sebelumnya atau pilih Lupa kata sandi.');error.status=409;throw error;
    }
    let auth;
    try {
      auth=await supabase('/auth/v1/signup', {
        method: 'POST',
        token: config.anon,
        body: {email,password,data:{display_name:ownerName,business_name:businessName,registration_source:'NUSA_OWNER_SELF_REGISTRATION'}}
      });
    } catch (error) {
      if (/already (registered|been registered)|user.*exists/i.test(error.message)) {
        error.message = 'Email sudah terdaftar. Silakan masuk sebagai Owner.';
        error.status = 409;
      }
      throw error;
    }
    if(!auth.user?.id){
      const error=new Error('Identitas akun gagal dibuat. Coba kembali beberapa saat lagi.');error.status=502;throw error;
    }
    if(!auth.access_token||!auth.refresh_token){
      return send(response,202,{
        registered:true,requiresEmailConfirmation:true,email,
        message:'Akun berhasil dibuat. Periksa email dan tekan Konfirmasi akun sebelum masuk sebagai Owner.'
      });
    }
    const profile=await provisionOwnerWorkspace(auth.user,{ownerName,businessName,email});
    setRefreshCookie(response,auth.refresh_token);
    return send(response,201,{...authPayload(auth,profile),registered:true});
  }

  if(request.method==='POST'&&route==='forgot-password'){
    const input=bodyOf(request),email=String(input.email??'').trim().toLowerCase();
    if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
      const error=new Error('Alamat email tidak valid');error.status=400;throw error;
    }
    const redirectTo=encodeURIComponent(`${process.env.PUBLIC_APP_URL??'https://kasir-nusa-pos.vercel.app'}/?password-recovery=1`);
    try{
      await supabase(`/auth/v1/recover?redirect_to=${redirectTo}`,{method:'POST',token:env().anon,body:{email}});
    }catch(error){
      if(/smtp|email.*(send|rate|authorized)|rate limit/i.test(`${error.message} ${JSON.stringify(error.details??{})}`)){
        error.message='Email pemulihan belum dapat dikirim. Periksa pengaturan SMTP Supabase atau tunggu batas pengiriman pulih.';
        error.status=503;
      }
      throw error;
    }
    return send(response,200,{message:'Jika email terdaftar, tautan pemulihan telah dikirim. Periksa juga folder Spam.'});
  }

  if(request.method==='POST'&&route==='reset-password'){
    const input=bodyOf(request),accessToken=String(input.accessToken??'').trim(),password=String(input.password??'');
    if(password.length<8||password.length>128){const error=new Error('Kata sandi harus berisi 8 sampai 128 karakter');error.status=400;throw error;}
    if(!accessToken){const error=new Error('Tautan pemulihan tidak valid atau sudah kedaluwarsa');error.status=401;throw error;}
    try{
      await supabase('/auth/v1/user',{token:accessToken});
      await supabase('/auth/v1/user',{method:'PUT',token:accessToken,body:{password}});
    }catch(error){
      if([400,401,403].includes(error.status)){error.message='Tautan pemulihan tidak valid atau sudah kedaluwarsa';error.status=401;}
      throw error;
    }
    return send(response,200,{updated:true});
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
    if(!profile&&portal==='OWNER'){
      const registration=ownerRegistrationMetadata(auth.user);
      if(registration.ownerName.length>=2&&registration.businessName.length>=2&&registration.email){
        profile=await provisionOwnerWorkspace(auth.user,registration);
      }
    }
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
    await rest('audit_logs','',{method:'POST',body:{
      tenant_id:profile.tenant_id,actor_id:auth.user.id,action:'ACCOUNT_LOGIN',
      entity_type:'profile',entity_id:auth.user.id,
      details_json:{portal}
    }}).catch(()=>{});
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

  if(request.method==='GET'&&route==='notifications'){
    const limit=Math.min(100,Math.max(10,Number(queryValue(request,'limit'))||40));
    const rows=await rest('app_notifications',
      `tenant_id=eq.${context.tenantId}&recipient_user_id=eq.${session.authUser.id}&select=*&order=created_at.desc&limit=${limit}`);
    const unread=await rest('app_notifications',
      `tenant_id=eq.${context.tenantId}&recipient_user_id=eq.${session.authUser.id}&read_at=is.null&select=id&limit=1000`);
    return send(response,200,{unreadCount:unread.length,notifications:rows.map((row)=>({
      id:row.id,type:row.type,severity:row.severity,title:row.title,message:row.message,
      entityType:row.entity_type,entityId:row.entity_id,actionPage:row.action_page,
      data:row.data_json??{},readAt:row.read_at,createdAt:row.created_at
    }))});
  }

  if(request.method==='POST'&&route==='notifications/read'){
    const input=bodyOf(request),now=new Date().toISOString();
    const ids=Array.isArray(input.ids)?[...new Set(input.ids.map(String).filter((id)=>/^[0-9a-f-]{36}$/i.test(id)))].slice(0,100):[];
    let query=`tenant_id=eq.${context.tenantId}&recipient_user_id=eq.${session.authUser.id}&read_at=is.null`;
    if(!input.all){
      if(!ids.length)throw Object.assign(new Error('Pilih notifikasi yang akan ditandai sudah dibaca'),{status:400});
      query+=`&id=in.(${ids.join(',')})`;
    }
    await rest('app_notifications',query,{method:'PATCH',body:{read_at:now}});
    return send(response,200,{success:true,readAt:now});
  }

  if(request.method==='GET'&&route==='notifications/push-config'){
    requireTenantOwner(session);
    const config=env();
    const subscriptions=await rest('web_push_subscriptions',
      `tenant_id=eq.${context.tenantId}&user_id=eq.${session.authUser.id}&active=eq.true&select=id,endpoint,device_label,updated_at&limit=20`);
    return send(response,200,{
      configured:Boolean(config.webPushPublicKey&&config.webPushPrivateKey),
      publicKey:config.webPushPublicKey||null,subscriptions:subscriptions.length
    });
  }

  if(request.method==='POST'&&route==='notifications/push-subscriptions'){
    requireTenantOwner(session);
    const input=bodyOf(request),endpoint=String(input.endpoint??'').trim();
    let endpointUrl;
    try{endpointUrl=new URL(endpoint);}catch{throw Object.assign(new Error('Alamat langganan notifikasi tidak valid'),{status:400});}
    if(endpointUrl.protocol!=='https:'||endpoint.length>2048||['localhost','127.0.0.1','::1'].includes(endpointUrl.hostname)){
      throw Object.assign(new Error('Alamat langganan notifikasi tidak aman'),{status:400});
    }
    const p256dh=String(input.keys?.p256dh??''),authKey=String(input.keys?.auth??'');
    if(!p256dh||!authKey||p256dh.length>256||authKey.length>256){
      throw Object.assign(new Error('Kunci perangkat notifikasi tidak lengkap'),{status:400});
    }
    await rest('web_push_subscriptions','on_conflict=endpoint',{
      method:'POST',prefer:'resolution=merge-duplicates,return=minimal',body:{
        tenant_id:context.tenantId,user_id:session.authUser.id,endpoint,p256dh,auth_key:authKey,
        expiration_time:input.expirationTime??null,user_agent:String(request.headers['user-agent']??'').slice(0,300),
        device_label:String(input.deviceLabel??'Perangkat Owner').trim().slice(0,80),active:true,failure_count:0,
        updated_at:new Date().toISOString()
      }
    });
    return send(response,201,{success:true});
  }

  if(request.method==='DELETE'&&route==='notifications/push-subscriptions'){
    requireTenantOwner(session);
    const endpoint=String(bodyOf(request).endpoint??'').trim();
    if(!endpoint)throw Object.assign(new Error('Perangkat notifikasi tidak ditemukan'),{status:400});
    await rest('web_push_subscriptions',
      `tenant_id=eq.${context.tenantId}&user_id=eq.${session.authUser.id}&endpoint=eq.${encodeURIComponent(endpoint)}`,
      {method:'PATCH',body:{active:false,updated_at:new Date().toISOString()}});
    return send(response,200,{success:true});
  }

  if(request.method==='POST'&&route==='notifications/test'){
    requireTenantOwner(session);
    await notifyTenantOwners(context.tenantId,{
      type:'SYSTEM',severity:'SUCCESS',title:'Notifikasi Nusa aktif',
      message:`Perangkat Owner ${session.profile.display_name} siap menerima kabar penting.`,
      entityType:'profile',entityId:session.authUser.id,actionPage:'pos',
      dedupeKey:`push-test:${session.authUser.id}:${Date.now()}`
    },request.waitUntil);
    return send(response,201,{success:true});
  }

  if (request.method === 'GET' && route === 'platform/infrastructure') {
    requirePlatformAdmin(session);
    const [databaseResult,storageResult,cloudflareResult]=await Promise.allSettled([
      rpc('platform_infrastructure_snapshot_v1',{}),rpc('platform_storage_snapshot_v1',{}),loadCloudflareInfrastructure()
    ]);
    const storageLimit=env().supabaseStorageLimitBytes;
    const storageSnapshot=storageResult.status==='fulfilled'?storageResult.value:null;
    const storageUsed=Number(storageSnapshot?.totalBytes??0);
    return send(response,200,{
      generatedAt:new Date().toISOString(),
      database:databaseResult.status==='fulfilled'
        ?{available:true,...databaseResult.value}
        :{available:false,message:databaseResult.reason?.message??'Metrik database belum tersedia'},
      storage:storageSnapshot
        ?{available:true,...storageSnapshot,limitBytes:storageLimit,remainingBytes:Math.max(0,storageLimit-storageUsed),usedPercent:storageLimit?storageUsed*100/storageLimit:0}
        :{available:false,message:storageResult.reason?.message??'Metrik penyimpanan file belum tersedia'},
      cloudflare:cloudflareResult.status==='fulfilled'
        ?cloudflareResult.value
        :{configured:true,available:false,message:cloudflareResult.reason?.message??'Metrik Cloudflare belum tersedia'}
    });
  }

  if(request.method==='GET'&&route==='payment-gateways/midtrans/sandbox'){
    requireTenantOwner(session);
    let account=null,configurationError=null;
    try{account=await midtransAccount(context.tenantId,'SANDBOX',{required:false});}catch(error){configurationError=error.message;}
    let intents=[];
    try{
      intents=await rest('payment_gateway_intents',`tenant_id=eq.${context.tenantId}&provider=eq.MIDTRANS&environment=eq.SANDBOX&select=*&order=created_at.desc&limit=20`);
    }catch(error){
      if(!/payment_gateway_intents/i.test(`${error.message} ${JSON.stringify(error.details??{})}`))throw error;
    }
    return send(response,200,{configured:Boolean(account),credentialStorageConfigured:Boolean(env().paymentCredentialsMasterKey),configurationError,merchantId:account?.merchant_id??null,verifiedAt:account?.verified_at??null,accountStatus:account?.status??'DISCONNECTED',environment:'SANDBOX',operationalMutation:false,intents:intents.map((item)=>({id:item.id,orderId:item.order_id,transactionId:item.gateway_transaction_id,amount:Number(item.gross_amount),status:item.status,qrUrl:item.qr_url,expiresAt:item.expires_at,settledAt:item.settled_at,failureMessage:item.failure_message,createdAt:item.created_at,updatedAt:item.updated_at}))});
  }

  if(request.method==='PUT'&&route==='payment-gateways/midtrans/sandbox/credentials'){
    requireTenantOwner(session);
    const input=bodyOf(request),serverKey=String(input.serverKey??'').trim(),merchantId=String(input.merchantId??'').trim();
    if(!(serverKey.startsWith('SB-Mid-server-')||serverKey.startsWith('Mid-server-'))||serverKey.length<24||serverKey.length>300)throw Object.assign(new Error('Gunakan Server Key dari lingkungan Sandbox Midtrans'),{status:400});
    if(merchantId.length>100)throw Object.assign(new Error('Merchant ID terlalu panjang'),{status:400});
    const encrypted=await encryptPaymentCredential(serverKey);
    const saved=await rest('payment_gateway_accounts','on_conflict=tenant_id,provider,environment',{method:'POST',prefer:'resolution=merge-duplicates,return=representation',body:{tenant_id:context.tenantId,provider:'MIDTRANS',environment:'SANDBOX',status:'CONFIGURED',merchant_id:merchantId||null,server_key_ciphertext:encrypted.ciphertext,server_key_iv:encrypted.iv,encryption_key_version:encrypted.keyVersion,configured_by:session.authUser.id,verified_at:null,updated_at:new Date().toISOString()}});
    await rest('audit_logs','',{method:'POST',body:{tenant_id:context.tenantId,actor_id:session.authUser.id,action:'PAYMENT_GATEWAY_CONFIGURED',entity_type:'payment_gateway_account',entity_id:saved[0]?.id??null,details_json:{provider:'MIDTRANS',environment:'SANDBOX',merchantId:merchantId||null}}});
    return send(response,200,{configured:true,environment:'SANDBOX',merchantId:merchantId||null,accountStatus:'CONFIGURED',operationalMutation:false});
  }

  if(request.method==='DELETE'&&route==='payment-gateways/midtrans/sandbox/credentials'){
    requireTenantOwner(session);
    const rows=await rest('payment_gateway_accounts',`tenant_id=eq.${context.tenantId}&provider=eq.MIDTRANS&environment=eq.SANDBOX`,{method:'PATCH',prefer:'return=representation',body:{status:'DISABLED',server_key_ciphertext:null,server_key_iv:null,verified_at:null,configured_by:session.authUser.id,updated_at:new Date().toISOString()}});
    await rest('audit_logs','',{method:'POST',body:{tenant_id:context.tenantId,actor_id:session.authUser.id,action:'PAYMENT_GATEWAY_DISCONNECTED',entity_type:'payment_gateway_account',entity_id:rows[0]?.id??null,details_json:{provider:'MIDTRANS',environment:'SANDBOX'}}});
    return send(response,200,{configured:false,environment:'SANDBOX',operationalMutation:false});
  }

  if(request.method==='POST'&&route==='payment-gateways/midtrans/sandbox/intents'){
    requireTenantOwner(session);
    const config=await midtransAccount(context.tenantId,'SANDBOX');
    const input=bodyOf(request),amount=Number(input.amount);
    if(!Number.isSafeInteger(amount)||amount<1000||amount>10000000)throw Object.assign(new Error('Nominal simulasi harus bilangan bulat Rp1.000 sampai Rp10.000.000'),{status:400});
    const orderId=`NUSA-SBX-${Date.now().toString(36).toUpperCase()}-${randomBytes(6).toString('hex').toUpperCase()}`;
    const created=await rest('payment_gateway_intents','',{method:'POST',prefer:'return=representation',body:{tenant_id:context.tenantId,outlet_id:context.outlet?.id??null,cashier_id:session.authUser.id,gateway_account_id:config.id,provider:'MIDTRANS',environment:'SANDBOX',channel:'QRIS_DYNAMIC',order_id:orderId,gross_amount:amount,currency:'IDR',status:'CREATING'}});
    const intent={...created[0],tenant_id:context.tenantId,environment:'SANDBOX',order_id:orderId,gross_amount:amount};
    let diagnosticPayload={};
    try{
      const chargePayload=await midtransRequest(config,'/v2/charge',{method:'POST',body:{payment_type:'qris',transaction_details:{order_id:orderId,gross_amount:amount},item_details:[{id:'NUSA-SANDBOX',price:amount,quantity:1,name:'Simulasi QRIS Nusa POS'}],qris:{acquirer:'gopay'}}});
      diagnosticPayload=chargePayload;
      const payload=chargePayload;
      const updated=await updateMidtransIntent(intent,payload,'CHARGE');
      await rest('payment_gateway_accounts',`id=eq.${config.id}&tenant_id=eq.${context.tenantId}`,{method:'PATCH',body:{status:'VERIFIED',merchant_id:String(payload.merchant_id??config.merchant_id??'')||null,verified_at:new Date().toISOString(),updated_at:new Date().toISOString()}});
      return send(response,201,{intent:{id:updated.id,orderId:updated.order_id,transactionId:updated.gateway_transaction_id,amount:Number(updated.gross_amount),status:updated.status,qrUrl:updated.qr_url,expiresAt:updated.expires_at,createdAt:updated.created_at},environment:'SANDBOX',operationalMutation:false});
    }catch(error){
      const safePayload=Object.keys(error.details??{}).length?error.details:sanitizedMidtransPayload(diagnosticPayload);
      await rest('payment_gateway_intents',`id=eq.${intent.id}`,{method:'PATCH',body:{status:'ERROR',failure_code:'CHARGE_FAILED',failure_message:String(error.message).slice(0,500),last_gateway_payload:safePayload,updated_at:new Date().toISOString()}}).catch(()=>null);
      await recordMidtransEvent(intent.id,'SYSTEM',diagnosticPayload,`Charge gagal: ${String(error.message).slice(0,300)}`,null).catch(()=>null);
      throw error;
    }
  }

  if(request.method==='POST'&&/^payment-gateways\/midtrans\/sandbox\/intents\/[^/]+\/refresh$/.test(route)){
    requireTenantOwner(session);
    const intentId=route.split('/')[4];
    const rows=await rest('payment_gateway_intents',`tenant_id=eq.${context.tenantId}&id=eq.${encodeURIComponent(intentId)}&provider=eq.MIDTRANS&environment=eq.SANDBOX&select=*&limit=1`);
    const intent=rows[0];
    if(!intent)throw Object.assign(new Error('Intent Sandbox Midtrans tidak ditemukan'),{status:404});
    const config=await midtransAccount(context.tenantId,'SANDBOX');
    if(intent.gateway_account_id&&intent.gateway_account_id!==config.id)throw Object.assign(new Error('Intent dibuat oleh akun Midtrans tenant yang berbeda'),{status:409});
    const payload=await midtransRequest(config,`/v2/${encodeURIComponent(intent.order_id)}/status`);
    const updated=await updateMidtransIntent(intent,payload,'STATUS_CHECK',null,{identityVerifiedByLookup:true});
    return send(response,200,{intent:{id:updated.id,orderId:updated.order_id,transactionId:updated.gateway_transaction_id,amount:Number(updated.gross_amount),status:updated.status,qrUrl:updated.qr_url,expiresAt:updated.expires_at,settledAt:updated.settled_at,updatedAt:updated.updated_at},environment:'SANDBOX',operationalMutation:false});
  }

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
    const includeCatalog=queryValue(request,'catalog')!=='false';
    const [products, promotions, customerGroups, customers, suppliers, shifts, tenants, devices] = await Promise.all([
      includeCatalog?loadCatalog(context.tenantId, context.storeLocation?.id, context.outlet.id):Promise.resolve(null), loadPromotions(context.tenantId, context.outlet.id),
      loadCustomerPriceGroups(context.tenantId), loadCustomerAccounts(context.tenantId),
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
        platformAdmin: isPlatformAdmin(session),
        permissions: session.permissions
      },
      outlets: context.outlets, activeOutletId: context.outlet.id, locations: context.locations,
      business: businessPayload(tenants[0]), deviceSettings: devicePayload(devices[0], deviceId),
      customerGroups, customers, suppliers, ...(products?{products}:{}), promotions,
      currentShift: await shiftDetail(context.tenantId, shifts[0]), syncCursor: new Date().toISOString()
    });
  }

  if(request.method==='GET'&&route==='catalog'){
    return rawRpc(response,'load_pos_catalog_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,
      p_location_id:context.storeLocation?.id??null,p_outlet_id:context.outlet.id
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
    const current=input.logoUrl===undefined
      ?(await rest('tenants',`id=eq.${encodeURIComponent(context.tenantId)}&select=logo_url&limit=1`))[0]
      :null;
    const latitude=input.attendanceLatitude===''||input.attendanceLatitude===null||input.attendanceLatitude===undefined?null:Number(input.attendanceLatitude);
    const longitude=input.attendanceLongitude===''||input.attendanceLongitude===null||input.attendanceLongitude===undefined?null:Number(input.attendanceLongitude);
    if((latitude===null)!==(longitude===null)||latitude!==null&&(!Number.isFinite(latitude)||!Number.isFinite(longitude))){
      throw Object.assign(new Error('Koordinat lintang dan bujur harus diisi bersama'),{status:400});
    }
    const row = await rpc('save_business_settings_v2', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_name: input.name,
      p_legal_name: input.legalName ?? '', p_phone: input.phone ?? '', p_email: input.email ?? '',
      p_address: input.address ?? '', p_tax_id: input.taxId ?? '', p_receipt_footer: input.receiptFooter ?? '',
      p_logo_url: normalizeReceiptLogo(input.logoUrl??current?.logo_url??''),
      p_attendance_latitude:latitude,p_attendance_longitude:longitude,
      p_attendance_radius_m:Number(input.attendanceRadiusM??100)
    });
    return send(response, 200, { business: businessPayload(row) });
  }

  if (request.method === 'PUT' && route === 'settings/receipt') {
    requirePermission(session,'identity.manage');
    const input=bodyOf(request);
    const row=await rpc('save_receipt_layout_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,
      p_layout:normalizeReceiptLayout(input.layout),
      p_logo_url:normalizeReceiptLogo(input.logoUrl)
    });
    return send(response,200,{business:businessPayload(row)});
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
    requireAnyPermission(session, ['identity.manage','device.configure']);
    const input = bodyOf(request);
    const requestedDeviceId=String(input.id??'').trim();
    const currentDeviceId=String(request.headers['x-device-id']??'').trim();
    if(!/^[0-9a-f-]{36}$/i.test(requestedDeviceId)||requestedDeviceId!==currentDeviceId){
      throw Object.assign(new Error('Perangkat aktif tidak valid'),{status:400});
    }
    const managesIdentity=session.permissions.includes('identity.manage');
    const outletId=managesIdentity?input.outletId:context.outlet.id;
    if(!context.outlets.some((outlet)=>outlet.id===outletId)){
      throw Object.assign(new Error('Perangkat hanya dapat dipasang pada outlet yang dapat diakses'),{status:403});
    }
    const device = await rpc('save_pos_device_settings', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_device_id: requestedDeviceId,
      p_outlet_id: outletId, p_name: input.name, p_platform: input.platform ?? '',
      p_paper_width: Number(input.paperWidth ?? 80), p_auto_print: Boolean(input.autoPrint),
      p_receipt_copies: Number(input.receiptCopies ?? 1)
    });
    return send(response, 200, { device: devicePayload(device) });
  }

  if (request.method === 'GET' && route === 'users') {
    requirePermission(session, 'identity.manage_staff');
    const config = env();
    const [profiles, assignments, authPage] = await Promise.all([
      rest('profiles', `tenant_id=eq.${context.tenantId}&select=*&order=created_at`),
      rest('user_outlets', `tenant_id=eq.${context.tenantId}&select=*`),
      supabase('/auth/v1/admin/users?page=1&per_page=1000', { token: config.service })
    ]);
    const authUsers = authPage?.users ?? [];
    const visibleProfiles=session.profile.role==='ADMIN'
      ? profiles.filter((profile)=>!['OWNER','ADMIN'].includes(profile.role))
      : profiles;
    return send(response, 200, { users: visibleProfiles.map((profile) => ({
      id: profile.user_id, email: authUsers.find((user) => user.id === profile.user_id)?.email ?? null,
      displayName: profile.display_name, role: profile.role, active: profile.active, createdAt: profile.created_at,
      permissions:effectivePermissions(profile),customPermissions:profile.custom_permissions,
      outletIds: assignments.filter((item) => item.user_id === profile.user_id).map((item) => item.outlet_id)
    })), outlets: context.outlets });
  }

  if (request.method === 'GET' && /^users\/[^/]+\/activity$/.test(route)) {
    requirePermission(session, 'identity.manage_staff');
    const userId = route.split('/')[1];
    const target = await rest('profiles', `tenant_id=eq.${context.tenantId}&user_id=eq.${encodeURIComponent(userId)}&select=user_id,display_name,role&limit=1`);
    if (!target[0]) {
      const error = new Error('Staff tidak ditemukan');
      error.status = 404;
      throw error;
    }
    if(session.profile.role==='ADMIN'&&['OWNER','ADMIN'].includes(target[0].role)){
      throw Object.assign(new Error('Admin hanya dapat melihat aktivitas staff operasional'),{status:403});
    }
    const logs = await rest('audit_logs', `tenant_id=eq.${context.tenantId}&actor_id=eq.${encodeURIComponent(userId)}&select=id,action,entity_type,entity_id,details_json,occurred_at&order=occurred_at.desc&limit=100`);
    return send(response, 200, {
      staff:{id:target[0].user_id,displayName:target[0].display_name,role:target[0].role},
      logs:logs.map((item)=>({
        id:item.id,action:item.action,entityType:item.entity_type,entityId:item.entity_id,
        details:item.details_json??{},occurredAt:item.occurred_at
      }))
    });
  }

  if (request.method === 'POST' && route === 'users') {
    requirePermission(session, 'identity.manage_staff');
    const input = bodyOf(request);
    if(session.profile.role==='ADMIN'&&['OWNER','ADMIN'].includes(input.role)){
      throw Object.assign(new Error('Admin hanya dapat membuat staff operasional'),{status:403});
    }
    if (!input.email || !input.password || input.password.length < 8) { const error = new Error('Email dan kata sandi minimal 8 karakter wajib diisi'); error.status = 400; throw error; }
    const config = env();
    const created = await supabase('/auth/v1/admin/users', { method: 'POST', token: config.service, body: {
      email: input.email.trim().toLowerCase(), password: input.password, email_confirm: true,
      user_metadata: { display_name: input.displayName }
    } });
    const authUser = created.user ?? created;
    try {
      const permissions=normalizedAssignablePermissions(input.permissions,input.role);
      const profile = await rpc('manage_profile_access_v2', {
        p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_user_id: authUser.id,
        p_display_name: input.displayName, p_role: input.role, p_active: true,
        p_outlet_ids: input.outletIds ?? [],p_permissions:permissions
      });
      return send(response, 201, { ...profile, email: authUser.email });
    } catch (error) {
      await supabase(`/auth/v1/admin/users/${authUser.id}`, { method: 'DELETE', token: config.service }).catch(() => {});
      throw error;
    }
  }

  if (request.method === 'PATCH' && /^users\/[^/]+$/.test(route)) {
    requirePermission(session, 'identity.manage_staff');
    const userId = route.split('/')[1];
    const input = bodyOf(request);
    if(session.profile.role==='ADMIN'&&['OWNER','ADMIN'].includes(input.role)){
      throw Object.assign(new Error('Admin hanya dapat mengelola staff operasional'),{status:403});
    }
    const permissions=normalizedAssignablePermissions(input.permissions,input.role);
    const profile = await rpc('manage_profile_access_v2', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_user_id: userId,
      p_display_name: input.displayName, p_role: input.role, p_active: input.active !== false,
      p_outlet_ids: input.outletIds ?? [],p_permissions:permissions
    });
    return send(response, 200, profile);
  }

  if (request.method === 'POST' && route === 'sale-authorizations') {
    requirePermission(session, 'pos.sell');
    requirePermission(session, 'sale.adjust');
    if (!context.outlet?.id) { const error = new Error('Outlet aktif tidak ditemukan'); error.status = 409; throw error; }
    const input = await normalizeSaleCustomer(context, bodyOf(request));
    if (!Array.isArray(input.lines) || !input.lines.length) { const error = new Error('Keranjang masih kosong'); error.status = 400; throw error; }
    const adjustment = normalizeSaleAdjustment(input.adjustment);
    const fingerprint = saleAdjustmentFingerprint(input.lines, input.customerGroupId, adjustment);
    const token = randomBytes(32).toString('hex');
    const baseQuote = await baseSaleQuote(context, input);
    const preview = applySaleAdjustment(baseQuote, adjustment, { approvedBy: session.profile.display_name });
    const approved = await rpc('create_sale_adjustment_authorization', {
      p_tenant_id: context.tenantId,
      p_outlet_id: context.outlet.id,
      p_cashier_id: session.authUser.id,
      p_approved_by: session.authUser.id,
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
    const input = await normalizeSaleCustomer(context, bodyOf(request));
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
    const input = await normalizeSaleCustomer(context, bodyOf(request));
    if (!input.shiftId) {
      const error = new Error('Shift aktif tidak ditemukan. Muat ulang kasir lalu coba lagi.');
      error.status = 409;
      throw error;
    }
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
    let issuedVoucher=null;
    try{
      issuedVoucher=await rpc('issue_receipt_voucher_v1',{
        p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_sale_id:result.id
      });
    }catch(error){
      console.error('Receipt voucher issuance failed after completed sale',error.message);
    }
    await notifyTenantOwners(context.tenantId,{
      type:'SALE_COMPLETED',severity:'SUCCESS',title:`Transaksi ${result.receiptNo} berhasil`,
      message:`${context.outlet.name} · ${session.profile.display_name} · ${new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(quote.grandTotal)}`,
      entityType:'sale',entityId:result.id,actionPage:'reports-sales',
      data:{receiptNo:result.receiptNo,grandTotal:Number(quote.grandTotal),outletId:context.outlet.id,cashierId:session.authUser.id},
      dedupeKey:`sale:${result.id}`
    },request.waitUntil);
    const tenants = await rest('tenants', `id=eq.${context.tenantId}&select=*`);
    return send(response, 201, { ...result, issuedVoucher, occurredAt: new Date().toISOString(), cashier: session.profile.display_name, customerGroupId:input.customerGroupId, outletName:context.outlet.name, outlet:context.outlet, business:businessPayload(tenants[0]), quote });
  }

  if(request.method==='GET'&&route==='held-sales'){
    requirePermission(session,'pos.sell');
    const rows=await rest('parked_sales',`tenant_id=eq.${context.tenantId}&outlet_id=eq.${context.outlet.id}&status=eq.HELD&select=*&order=created_at.asc&limit=50`);
    return send(response,200,{holds:rows.map((row)=>({id:row.id,label:row.label,customerId:row.customer_id,customerGroupId:row.customer_group_id,notes:row.sale_notes??'',cart:row.cart_json,quote:row.quote_json,cashierId:row.cashier_id,createdAt:row.created_at}))});
  }

  if(request.method==='POST'&&route==='held-sales'){
    requirePermission(session,'pos.sell');
    const input=await normalizeSaleCustomer(context,bodyOf(request));
    if(!Array.isArray(input.lines)||!input.lines.length){const error=new Error('Keranjang kosong');error.status=400;throw error;}
    const quote=quoteBasket({lines:input.lines,customerGroupId:input.customerGroupId,products:await loadCatalog(context.tenantId,context.storeLocation?.id,context.outlet.id),promotions:await loadPromotions(context.tenantId,context.outlet.id),at:new Date()});
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
    const [products, promotions] = await Promise.all([loadCatalog(context.tenantId, context.storeLocation?.id, context.outlet.id), loadPromotions(context.tenantId, context.outlet.id)]);
    const results = [];
    for (const command of commands) {
      try {
        if (!command.key || !command.occurredAt || !command.payload?.lines?.length) throw new Error('Format transaksi offline tidak lengkap');
        const at = new Date(command.occurredAt);
        if (!Number.isFinite(at.getTime())) throw new Error('Waktu transaksi offline tidak valid');
        const payload=await normalizeSaleCustomer(context,command.payload);
        if (!payload.shiftId) throw new Error('Shift transaksi offline tidak ditemukan. Buka ulang shift lalu buat transaksi baru.');
        const quote = quoteBasket({ lines: payload.lines, customerGroupId: payload.customerGroupId, products, promotions, at });
        const result = await rpc('process_sync_sale', {
          p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_device_id: input.device.id,
          p_outlet_id: outletId, p_device_name: input.device.name ?? 'Perangkat POS', p_platform: input.device.platform ?? null,
          p_idempotency_key: command.key, p_occurred_at: command.occurredAt, p_payload: payload,
          p_expected_total: Number(command.expectedTotal), p_quote: quote
        });
        if (result.status === 'APPLIED' && result.result?.id && payload.notes) {
          await rest('sales', `tenant_id=eq.${context.tenantId}&id=eq.${encodeURIComponent(result.result.id)}`, {
            method:'PATCH',body:{notes:String(payload.notes).trim().slice(0,500)}
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

  if(request.method==='POST'&&route==='media/product-image'){
    requirePermission(session,'catalog.manage');
    const input=bodyOf(request);
    const imageUrl=await uploadPublicMedia(context.tenantId,'products',input.dataUrl);
    return send(response,201,{imageUrl});
  }

  if (request.method === 'POST' && route === 'products') {
    requirePermission(session, 'catalog.manage');
    const input = normalizeProductInput(bodyOf(request));
    await assertNoSharedBarcodeConflict(context.tenantId,input);
    return send(response, 201, await rpc('save_product_v6', { p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_product: input }));
  }

  if (request.method === 'GET' && route === 'products/manage') {
    requirePermission(session, 'catalog.manage');
    return send(response,200,{products:await loadManagedProducts(context.tenantId,{includeCost:session.permissions.includes('purchasing.view_cost')})});
  }

  if(request.method==='POST'&&route==='products/bulk-delete'){
    requirePermission(session,'catalog.manage');
    if(!['OWNER','ADMIN'].includes(session.profile.role)){const error=new Error('Hanya Owner atau Admin yang dapat menghapus produk');error.status=403;throw error;}
    const input=bodyOf(request),productIds=[...new Set(Array.isArray(input.productIds)?input.productIds.map((id)=>String(id).trim()):[])];
    if(!productIds.length){const error=new Error('Pilih minimal satu produk');error.status=400;throw error;}
    if(productIds.length>10000){const error=new Error('Maksimal 10.000 produk sekali proses');error.status=400;throw error;}
    if(productIds.some((id)=>!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))){
      const error=new Error('Identitas produk tidak valid');error.status=400;throw error;
    }
    return send(response,200,await rpc('delete_products_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_product_ids:productIds
    }));
  }

  if (request.method === 'PUT' && /^products\/[^/]+$/.test(route)) {
    requirePermission(session, 'catalog.manage');
    const productId=route.split('/')[1];
    const input=normalizeProductInput(bodyOf(request),productId);
    await assertNoSharedBarcodeConflict(context.tenantId,input);
    return send(response,200,await rpc('save_product_v6',{p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_product:input}));
  }

  if (request.method === 'POST' && /^products\/[^/]+\/status$/.test(route)) {
    requirePermission(session, 'catalog.manage');
    const productId=route.split('/')[1],input=bodyOf(request);
    return send(response,200,await rpc('set_product_active',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_product_id:productId,p_active:Boolean(input.active)
    }));
  }

  if(request.method==='POST'&&route==='imports/kaspin/reconcile-customers'){
    requirePermission(session,'audit.view');
    if(!['OWNER','ADMIN'].includes(session.profile.role))throw Object.assign(new Error('Hanya Owner atau Admin yang dapat menghubungkan riwayat pelanggan'),{status:403});
    return send(response,200,await reconcileKaspinCustomerHistory(context,session));
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
    const key = request.headers['idempotency-key'] || input.idempotencyKey;
    if (!key) { const error = new Error('Identitas proses impor tidak tersedia'); error.status = 400; throw error; }
    if(String(input.kind??'').toUpperCase()==='CUSTOMERS'&&String(input.source??'').toUpperCase()==='KASPIN')await ensureKaspinCustomerGroups(context,input.customerGroups);
    const preview = await previewImport(context, input);
    if (!preview.valid) { const error = new Error(`Masih ada ${preview.errors.length} kesalahan pada data impor`); error.status = 400; throw error; }
    if(preview.kind==='KASPIN_FIFO'){
      const result=await rpc('import_kaspin_fifo_v1',{
        p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_idempotency_key:key,
        p_file_name:input.fileName??null,p_location_id:preview.locationId,p_rows:preview.rows,p_capital_rows:preview.capitalRows
      });
      return send(response,201,{kind:preview.kind,total:preview.rows.length,created:Number(result.created??0),updated:Number(result.updated??0),duplicate:Boolean(result.duplicate),receipts:Number(result.receipts??0),layers:Number(result.layers??0)});
    }
    if(preview.kind==='KASPIN_SALES'){
      const result=await rpc('import_kaspin_sales_v1',{
        p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_idempotency_key:key,
        p_file_name:input.fileName??null,p_outlet_id:preview.outletId,p_rows:preview.rows
      });
      const history=await reconcileKaspinCustomerHistory(context,session);
      return send(response,201,{kind:preview.kind,total:preview.rows.length,created:Number(result.created??0),updated:0,duplicate:Boolean(result.duplicate),receipts:Number(result.receipts??0),completed:Number(result.completed??0),voided:Number(result.voided??0),items:Number(result.items??0),...history});
    }
    if(preview.kind==='CUSTOMERS'&&String(input.source??'').toUpperCase()==='KASPIN'){
      const result=await rpc('import_kaspin_customers_v1',{
        p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_idempotency_key:key,
        p_file_name:input.fileName??null,p_rows:preview.rows
      });
      const {reconciliation,pointReconstruction}=await reconcileKaspinCustomerHistory(context,session);
      return send(response,201,{
        kind:preview.kind,total:preview.rows.length,created:Number(result.created??0),
        updated:Number(result.updated??0),duplicate:Boolean(result.duplicate),reconciliation,pointReconstruction
      });
    }
    if(['PRODUCT_FAMILIES','PRODUCT_VARIANTS','PRODUCT_OPTIONS'].includes(preview.kind)){
      const tasks=[];
      for(let index=0;index<preview.rows.length;index+=500)tasks.push(preview.rows.slice(index,index+500));
      const results=[];
      for(let index=0;index<tasks.length;index+=1){
        results.push(await rpc('import_product_catalog_v1',{
          p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,
          p_idempotency_key:tasks.length===1?key:`${key}:${index+1}`,
          p_kind:preview.kind,p_file_name:input.fileName??null,p_rows:tasks[index]
        }));
      }
      const blueprint=preview.kind==='PRODUCT_VARIANTS'
        ?await rpc('sync_catalog_variant_blueprint_v1',{p_tenant_id:context.tenantId,p_actor_id:session.authUser.id})
        :null;
      return send(response,201,{kind:preview.kind,total:preview.rows.length,created:results.reduce((sum,item)=>sum+Number(item.created??0),0),updated:results.reduce((sum,item)=>sum+Number(item.updated??0),0),duplicate:results.length>0&&results.every((item)=>item.duplicate),chunks:results.length,...(blueprint?{blueprint}:{})});
    }
    let rows=preview.rows.map((row)=>({...row}));
    if(preview.kind==='PRODUCTS'){
      const blankCount=rows.filter((row)=>!row.sku).length;
      if(blankCount){
        const allocated=await rpc('allocate_product_skus_v1',{p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_idempotency_key:key,p_count:blankCount});
        let cursor=0;rows=rows.map((row)=>row.sku?row:{...row,sku:allocated[cursor++]});
      }
    }
    const tasks=[];
    const addChunks=(type,items)=>{for(let index=0;index<items.length;index+=500)tasks.push({type,rows:items.slice(index,index+500)});};
    if(preview.kind==='PRODUCTS'){
      const products=await restAll('products',`tenant_id=eq.${context.tenantId}&select=sku`),existing=new Set(products.map((product)=>String(product.sku).toUpperCase()));
      addChunks('CREATE',rows.filter((row)=>!existing.has(row.sku)));
      addChunks('UPDATE',rows.filter((row)=>existing.has(row.sku)));
    }else if(['PRODUCT_UNITS','PRODUCT_VARIANTS','PRODUCT_PRICES'].includes(preview.kind))addChunks('PRODUCT_EXTENSION',rows);
    else addChunks('STANDARD',rows);
    const results=[];
    for(let index=0;index<tasks.length;index+=1){
      const task=tasks[index],chunkKey=tasks.length===1?key:`${key}:${index+1}`;
      const result=task.type==='UPDATE'
        ?await rpc('update_import_products_v1',{p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_idempotency_key:chunkKey,p_file_name:input.fileName??null,p_rows:task.rows})
        :task.type==='PRODUCT_EXTENSION'
          ?await rpc('import_product_extensions_v1',{p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_idempotency_key:chunkKey,p_kind:preview.kind,p_file_name:input.fileName??null,p_rows:task.rows})
          :await rpc('import_initial_data',{p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_idempotency_key:chunkKey,p_kind:preview.kind,p_file_name:input.fileName??null,p_location_id:preview.locationId,p_rows:task.rows});
      if(preview.kind==='PRODUCTS')await rpc('apply_import_product_settings_v1',{p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_rows:task.rows});
      results.push(result);
    }
    let blueprint=null;
    if(preview.kind==='PRODUCTS'){
      await rpc('refresh_safe_customer_prices_v1',{p_tenant_id:context.tenantId,p_product_id:null});
      if(String(input.source??'').toUpperCase()==='KASPIN')blueprint=await rpc('apply_catalog_variant_blueprint_v1',{
        p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_source_system:'KASPIN'
      });
    }
    return send(response,201,{kind:preview.kind,total:rows.length,created:results.reduce((sum,item)=>sum+Number(item.created??0),0),updated:results.reduce((sum,item)=>sum+Number(item.updated??0),0),duplicate:results.length>0&&results.every((item)=>item.duplicate),chunks:results.length,...(blueprint?{blueprint}:{})});
  }

  if(request.method==='GET'&&route==='imports/catalog-blueprint'){
    requirePermission(session,'audit.view');
    if(!['OWNER','ADMIN'].includes(session.profile.role))throw Object.assign(new Error('Hanya Owner atau Admin yang dapat melihat Blueprint varian'),{status:403});
    const [families,variants]=await Promise.all([
      restAll('catalog_family_blueprints',`tenant_id=eq.${context.tenantId}&source_system=eq.KASPIN&active=eq.true&select=family_code,updated_at`),
      restAll('catalog_variant_blueprints',`tenant_id=eq.${context.tenantId}&source_system=eq.KASPIN&active=eq.true&select=source_key,last_match_status,updated_at`)
    ]);
    const latest=[...families,...variants].map((item)=>item.updated_at).filter(Boolean).sort().at(-1)??null;
    return send(response,200,{
      protected:true,families:families.length,variants:variants.length,latest,
      matched:variants.filter((item)=>item.last_match_status==='MATCHED').length,
      unmatched:variants.filter((item)=>item.last_match_status==='UNMATCHED').length,
      ambiguous:variants.filter((item)=>item.last_match_status==='AMBIGUOUS').length
    });
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

  if(request.method==='POST'&&route==='data-restore/preview'){
    requirePermission(session,'identity.manage');
    if(session.profile.role!=='OWNER')throw Object.assign(new Error('Hanya Owner yang dapat memeriksa file pemulihan'),{status:403});
    const snapshot=bodyOf(request).snapshot,verification=verifyBackup(snapshot,context.tenantId);
    if(!verification.valid)throw Object.assign(new Error(verification.message),{status:422});
    await requireRegisteredBackup(context.tenantId,snapshot);
    return send(response,200,{...verification,preview:restorePreview(snapshot)});
  }

  if(request.method==='POST'&&route==='data-restore/otp'){
    requirePermission(session,'identity.manage');
    if(session.profile.role!=='OWNER')throw Object.assign(new Error('Hanya Owner yang dapat meminta OTP pemulihan'),{status:403});
    const snapshot=bodyOf(request).snapshot,verification=verifyBackup(snapshot,context.tenantId);
    if(!verification.valid)throw Object.assign(new Error(verification.message),{status:422});
    await requireRegisteredBackup(context.tenantId,snapshot);
    const email=String(session.authUser.email??'').trim().toLowerCase();
    if(!email)throw Object.assign(new Error('Email akun Owner belum tersedia'),{status:422});
    let simulation;
    try{
      simulation=await rpc('dry_run_restore_tenant_backup_v2',{
        p_tenant_id:context.tenantId,
        p_actor_id:session.authUser.id,
        p_tables:restorePayload(snapshot)
      });
    }catch(error){
      if(/dry_run_restore_tenant_backup_v2|schema cache|function|PGRST202/i.test(error.message)){
        throw Object.assign(new Error('Pemulihan belum aktif di database. Jalankan migrasi pemulihan terbaru terlebih dahulu.'),{status:503});
      }
      throw Object.assign(new Error('Kesiapan pemulihan belum dapat diverifikasi'),{status:503});
    }
    if(!simulation?.valid)throw Object.assign(new Error(`File belum dapat dipulihkan: ${simulation?.error??'simulasi gagal'}`),{status:409});
    try{
      await supabase('/auth/v1/otp',{method:'POST',body:{email,create_user:false}});
    }catch(error){
      if(error.status===429)throw Object.assign(new Error('OTP terlalu sering diminta. Tunggu beberapa menit lalu coba lagi.'),{status:429});
      throw Object.assign(new Error('OTP pemulihan belum dapat dikirim'),{status:502});
    }
    await rest('audit_logs','',{method:'POST',body:{
      tenant_id:context.tenantId,actor_id:session.authUser.id,action:'TENANT_BACKUP_RESTORE_OTP_REQUESTED',
      entity_type:'tenant',entity_id:context.tenantId,
      details_json:{emailMasked:maskEmail(email),simulatedRows:simulation.restoredRows??verification.totalRows}
    }});
    return send(response,200,{sent:true,emailMasked:maskEmail(email),simulation});
  }

  if(request.method==='POST'&&route==='data-restore/execute'){
    requirePermission(session,'identity.manage');
    if(session.profile.role!=='OWNER')throw Object.assign(new Error('Hanya Owner yang dapat memulihkan backup'),{status:403});
    const input=bodyOf(request),otp=String(input.otp??'').trim(),snapshot=input.snapshot;
    const verification=verifyBackup(snapshot,context.tenantId);
    if(!verification.valid)throw Object.assign(new Error(verification.message),{status:422});
    await requireRegisteredBackup(context.tenantId,snapshot);
    if(!/^\d{6,10}$/.test(otp))throw Object.assign(new Error('OTP harus terdiri dari 6 sampai 10 angka'),{status:400});
    if(String(input.confirmation??'').trim().toUpperCase()!=='PULIHKAN DATA')throw Object.assign(new Error('Ketik PULIHKAN DATA untuk melanjutkan'),{status:400});
    const email=String(session.authUser.email??'').trim().toLowerCase();
    let verified;
    try{
      verified=await supabase('/auth/v1/verify',{method:'POST',body:{email,token:otp,type:'email'}});
    }catch(error){
      throw Object.assign(new Error('OTP salah, kedaluwarsa, atau sudah digunakan'),{status:401});
    }
    if(verified?.user?.id!==session.authUser.id)throw Object.assign(new Error('OTP bukan milik akun Owner yang sedang login'),{status:403});

    const currentSnapshot=await buildBackup(context,session);
    const rowCounts=Object.fromEntries(Object.entries(currentSnapshot.tables).map(([table,rows])=>[table,rows.length]));
    const totalRows=Object.values(rowCounts).reduce((sum,count)=>sum+count,0);
    const stamp=currentSnapshot.createdAt.replace(/\D/g,'').slice(0,14);
    const fileName=`kasir-nusa-sebelum-pemulihan-${stamp}.json`;
    await rest('backup_exports','',{method:'POST',body:{
      tenant_id:context.tenantId,actor_id:session.authUser.id,file_name:fileName,
      schema_version:currentSnapshot.schemaVersion,checksum_sha256:currentSnapshot.checksum,
      total_rows:totalRows,row_counts:rowCounts,status:'COMPLETED'
    }});
    let result;
    try{
      result=await rpc('restore_tenant_backup_v2',{
        p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_tables:restorePayload(snapshot)
      });
    }catch(error){
      if(/restore_tenant_backup_v2|schema cache|function/i.test(error.message))throw Object.assign(new Error('Pemulihan belum aktif di database. Jalankan migrasi pemulihan terbaru.'),{status:503});
      throw Object.assign(new Error(`Pemulihan dibatalkan seluruhnya: ${error.message}`),{status:409});
    }
    return send(response,200,{...result,fileName,snapshot:currentSnapshot,totalRows});
  }

  if(request.method==='POST'&&route==='data-reset/otp'){
    requirePermission(session,'identity.manage');
    if(session.profile.role!=='OWNER')throw Object.assign(new Error('Hanya Owner yang dapat meminta OTP reset data'),{status:403});
    const email=String(session.authUser.email??'').trim().toLowerCase();
    if(!email)throw Object.assign(new Error('Email akun Owner belum tersedia'),{status:422});
    try{
      await rpc('reset_tenant_data_v2',{
        p_tenant_id:'00000000-0000-0000-0000-000000000000',
        p_actor_id:'00000000-0000-0000-0000-000000000000',
        p_scopes:['TRANSACTIONS']
      });
      throw new Error('Pemeriksaan reset tidak berhenti pada pengaman Owner');
      }catch(error){
      if(/Hanya Owner aktif/i.test(error.message)){}else if(/reset_tenant_data_v2|schema cache|function|PGRST202/i.test(error.message)){
        try{
          await rpc('reset_tenant_data_v1',{
            p_tenant_id:'00000000-0000-0000-0000-000000000000',
            p_actor_id:'00000000-0000-0000-0000-000000000000',p_scopes:['TRANSACTIONS']
          });
          throw new Error('Pemeriksaan reset lama tidak berhenti pada pengaman Owner');
        }catch(legacyError){
          if(!/Hanya Owner aktif/i.test(legacyError.message))throw Object.assign(new Error('Fitur reset belum aktif di database. Pasang migrasi reset data terbaru terlebih dahulu.'),{status:503});
        }
      }else{
        throw Object.assign(new Error('Kesiapan reset data belum dapat diverifikasi'),{status:503});
      }
    }
    try{
      await supabase('/auth/v1/otp',{method:'POST',body:{email,create_user:false}});
    }catch(error){
      if(error.status===429)throw Object.assign(new Error('OTP terlalu sering diminta. Tunggu beberapa menit lalu coba lagi.'),{status:429});
      throw Object.assign(new Error('OTP belum dapat dikirim. Pastikan email Owner aktif dan konfigurasi email Supabase memakai kode OTP.'),{status:502});
    }
    await rest('audit_logs','',{method:'POST',body:{
      tenant_id:context.tenantId,actor_id:session.authUser.id,action:'TENANT_DATA_RESET_OTP_REQUESTED',
      entity_type:'tenant',entity_id:context.tenantId,details_json:{emailMasked:maskEmail(email)}
    }});
    return send(response,200,{sent:true,emailMasked:maskEmail(email)});
  }

  if(request.method==='POST'&&route==='data-reset/execute'){
    requirePermission(session,'identity.manage');
    if(session.profile.role!=='OWNER')throw Object.assign(new Error('Hanya Owner yang dapat mereset data'),{status:403});
    const input=bodyOf(request),otp=String(input.otp??'').trim();
    const scopes=[...new Set((Array.isArray(input.scopes)?input.scopes:[]).map((scope)=>String(scope).trim().toUpperCase()))];
    const allowed=new Set(['ALL','TRANSACTIONS','CATALOG','CUSTOMERS','SUPPLIERS','PROMOTIONS','FINANCE','WORKFORCE']);
    if(!scopes.length||scopes.some((scope)=>!allowed.has(scope)))throw Object.assign(new Error('Pilih data yang akan direset'),{status:400});
    if(!/^\d{6,10}$/.test(otp))throw Object.assign(new Error('OTP harus terdiri dari 6 sampai 10 angka'),{status:400});
    if(String(input.confirmation??'').trim().toUpperCase()!=='RESET DATA')throw Object.assign(new Error('Ketik RESET DATA untuk melanjutkan'),{status:400});
    const email=String(session.authUser.email??'').trim().toLowerCase();
    let verified;
    try{
      verified=await supabase('/auth/v1/verify',{method:'POST',body:{email,token:otp,type:'email'}});
    }catch(error){
      throw Object.assign(new Error('OTP salah, kedaluwarsa, atau sudah digunakan'),{status:401});
    }
    if(verified?.user?.id!==session.authUser.id)throw Object.assign(new Error('OTP bukan milik akun Owner yang sedang login'),{status:403});

    const snapshot=await buildBackup(context,session);
    const rowCounts=Object.fromEntries(Object.entries(snapshot.tables).map(([table,rows])=>[table,rows.length]));
    const totalRows=Object.values(rowCounts).reduce((sum,count)=>sum+count,0);
    const stamp=snapshot.createdAt.replace(/\D/g,'').slice(0,14);
    const fileName=`kasir-nusa-sebelum-reset-${stamp}.json`;
    await rest('backup_exports','',{method:'POST',body:{
      tenant_id:context.tenantId,actor_id:session.authUser.id,file_name:fileName,
      schema_version:snapshot.schemaVersion,checksum_sha256:snapshot.checksum,total_rows:totalRows,row_counts:rowCounts,status:'COMPLETED'
    }});
    let result;
    try{
      result=await rpc('reset_tenant_data_v2',{
        p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_scopes:scopes
      });
    }catch(error){
      if(/reset_tenant_data_v2|schema cache|function/i.test(error.message))throw Object.assign(new Error('Fitur reset belum aktif di database. Jalankan migrasi reset data terbaru terlebih dahulu.'),{status:503});
      if(/violates foreign key constraint/i.test(error.message)){
        const constraint=error.message.match(/constraint\s+"([^"]+)"/i)?.[1];
        throw Object.assign(new Error(`Reset dibatalkan seluruhnya karena relasi database belum diperbarui${constraint?` (${constraint})`:''}. Jalankan migrasi reset terbaru lalu minta OTP baru.`),{status:409});
      }
      throw error;
    }
    return send(response,200,{...result,fileName,snapshot,totalRows});
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

  if(request.method==='GET'&&route==='price-policy'){
    requirePermission(session,'catalog.manage');
    const rows=await rest('safe_customer_price_policies',`tenant_id=eq.${encodeURIComponent(context.tenantId)}&select=*&limit=1`);
    const policy=rows[0];
    return send(response,200,{policy:policy?{
      minProfit:Number(policy.min_profit),category:policy.category??'',brand:policy.brand??'',
      rules:policy.rules_json??[],active:policy.active,updatedAt:policy.updated_at
    }:null});
  }

  if(request.method==='POST'&&route==='price-policy/preview'){
    requirePermission(session,'catalog.manage');
    return send(response,200,await previewSafePricePolicy(context.tenantId,bodyOf(request)));
  }

  if(request.method==='POST'&&route==='price-policy/apply'){
    requirePermission(session,'catalog.manage');
    if(!['OWNER','ADMIN'].includes(session.profile.role)){const error=new Error('Hanya Owner atau Admin yang dapat menerapkan harga massal');error.status=403;throw error;}
    const preview=await previewSafePricePolicy(context.tenantId,bodyOf(request));
    const result=await rpc('apply_safe_price_policy_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_policy:preview.policy
    });
    return send(response,200,{...result,preview});
  }

  if(request.method==='DELETE'&&/^promotions\/[^/]+$/.test(route)){
    requirePermission(session,'promotion.manage');
    const versionId=route.split('/')[1],tenant=encodeURIComponent(context.tenantId),version=encodeURIComponent(versionId);
    const versions=await rest('promotion_versions',`tenant_id=eq.${tenant}&id=eq.${version}&select=id,promotion_id&limit=1`);
    if(!versions[0])throw Object.assign(new Error('Promo tidak ditemukan'),{status:404});
    const promotionId=versions[0].promotion_id,promotion=encodeURIComponent(promotionId);
    const used=await rest('promotion_redemptions',`tenant_id=eq.${tenant}&promotion_id=eq.${promotion}&select=id&limit=1`);
    if(used.length){
      await rest('promotion_versions',`tenant_id=eq.${tenant}&promotion_id=eq.${promotion}&status=eq.PUBLISHED`,{
        method:'PATCH',prefer:'return=minimal',body:{status:'RETIRED'}
      });
      return send(response,200,{deleted:true,archived:true});
    }
    const rows=await rest('promotions',`tenant_id=eq.${tenant}&id=eq.${promotion}`,{
      method:'DELETE',prefer:'return=representation'
    });
    if(!rows[0])throw Object.assign(new Error('Promo tidak ditemukan'),{status:404});
    return send(response,200,{deleted:true,archived:false});
  }

  if (request.method === 'POST' && route === 'promotions/simulate') {
    requirePermission(session, 'promotion.manage');
    const input = bodyOf(request);
    const temporary = { id: '00000000-0000-4000-8000-000000000000', promotionId: 'simulation', version: 0, code: input.promo.code, name: input.promo.name, status: 'PUBLISHED', startsAt: new Date(Date.now()-60000).toISOString(), endsAt: new Date(Date.now()+60000).toISOString(), priority: 999, stackable: Boolean(input.promo.stackable), condition: input.promo.condition, reward: input.promo.reward };
    return send(response, 200, quoteBasket({ lines: input.lines, customerGroupId: input.customerGroupId??'retail', products: await loadCatalog(context.tenantId, context.storeLocation?.id, context.outlet.id), promotions: [temporary], at: new Date() }));
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
    const [settings,tiers,vouchers,receiptCampaigns]=await Promise.all([
      rest('loyalty_settings',`tenant_id=eq.${tenant}&select=*&limit=1`),
      rest('customer_tiers',`tenant_id=eq.${tenant}&select=*&order=min_lifetime_spend.asc`),
      rest('vouchers',`tenant_id=eq.${tenant}&source=eq.MANUAL&select=*&order=created_at.desc`),
      rpc('receipt_voucher_dashboard_v1',{p_tenant_id:context.tenantId})
    ]);
    return send(response,200,{settings:settings[0]??null,tiers,vouchers,receiptCampaigns});
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

  if(request.method==='PUT'&&/^vouchers\/[^/]+$/.test(route)){
    requirePermission(session,'promotion.manage');
    const input=bodyOf(request),voucherId=route.split('/')[1];
    const payload={outlet_id:input.outletId||null,code:String(input.code??'').trim().toUpperCase(),
      name:String(input.name??'').trim(),discount_type:input.discountType,discount_value:Number(input.discountValue),
      max_discount:input.maxDiscount?Number(input.maxDiscount):null,min_purchase:Number(input.minPurchase??0),
      starts_at:input.startsAt,ends_at:input.endsAt,usage_limit_total:input.usageLimitTotal?Number(input.usageLimitTotal):null,
      usage_limit_per_customer:input.usageLimitPerCustomer?Number(input.usageLimitPerCustomer):null,
      segment:input.segment??'ALL',one_time:Boolean(input.oneTime)};
    if(!payload.code||!payload.name)throw Object.assign(new Error('Kode dan nama voucher wajib diisi'),{status:400});
    const rows=await rest('vouchers',`tenant_id=eq.${encodeURIComponent(context.tenantId)}&id=eq.${encodeURIComponent(voucherId)}&source=eq.MANUAL`,{
      method:'PATCH',prefer:'return=representation',body:payload
    });
    if(!rows[0])throw Object.assign(new Error('Voucher tidak ditemukan'),{status:404});
    return send(response,200,rows[0]);
  }

  if(request.method==='DELETE'&&/^vouchers\/[^/]+$/.test(route)){
    requirePermission(session,'promotion.manage');
    const voucherId=route.split('/')[1],tenant=encodeURIComponent(context.tenantId),voucher=encodeURIComponent(voucherId);
    const used=await rest('voucher_redemptions',`tenant_id=eq.${tenant}&voucher_id=eq.${voucher}&select=id&limit=1`);
    if(used.length){
      const rows=await rest('vouchers',`tenant_id=eq.${tenant}&id=eq.${voucher}&source=eq.MANUAL`,{
        method:'PATCH',prefer:'return=representation',body:{active:false}
      });
      if(!rows[0])throw Object.assign(new Error('Voucher tidak ditemukan'),{status:404});
      return send(response,200,{deleted:true,archived:true});
    }
    const rows=await rest('vouchers',`tenant_id=eq.${tenant}&id=eq.${voucher}&source=eq.MANUAL`,{
      method:'DELETE',prefer:'return=representation'
    });
    if(!rows[0])throw Object.assign(new Error('Voucher tidak ditemukan'),{status:404});
    return send(response,200,{deleted:true,archived:false});
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

  if(request.method==='POST'&&route==='receipt-voucher-campaigns'){
    requirePermission(session,'promotion.manage');
    const input=bodyOf(request);
    const payload={tenant_id:context.tenantId,outlet_id:input.outletId||null,
      name:String(input.name??'').trim(),active:true,priority:Number(input.priority??0),
      trigger_min_purchase:Number(input.triggerMinPurchase??0),discount_type:input.discountType,
      discount_value:Number(input.discountValue),max_discount:input.maxDiscount?Number(input.maxDiscount):null,
      redemption_min_purchase:Number(input.redemptionMinPurchase??0),
      valid_after_days:Number(input.validAfterDays??1),valid_days:Number(input.validDays??14),
      customer_mode:input.customerMode==='MEMBER'?'MEMBER':'BEARER',created_by:session.authUser.id};
    if(!payload.name||!['FIXED','PERCENT'].includes(payload.discount_type)||payload.discount_value<=0){
      throw Object.assign(new Error('Nama, jenis, dan nilai voucher wajib diisi'),{status:400});
    }
    if(payload.discount_type==='PERCENT'&&payload.discount_value>100){
      throw Object.assign(new Error('Persentase voucher maksimal 100%'),{status:400});
    }
    const rows=await rest('receipt_voucher_campaigns','',{method:'POST',prefer:'return=representation',body:payload});
    return send(response,201,rows[0]);
  }

  if(request.method==='PUT'&&/^receipt-voucher-campaigns\/[^/]+$/.test(route)){
    requirePermission(session,'promotion.manage');
    const input=bodyOf(request),campaignId=route.split('/')[1];
    const payload={outlet_id:input.outletId||null,name:String(input.name??'').trim(),
      priority:Number(input.priority??0),trigger_min_purchase:Number(input.triggerMinPurchase??0),
      discount_type:input.discountType,discount_value:Number(input.discountValue),
      max_discount:input.maxDiscount?Number(input.maxDiscount):null,
      redemption_min_purchase:Number(input.redemptionMinPurchase??0),
      valid_after_days:Number(input.validAfterDays??1),valid_days:Number(input.validDays??14),
      customer_mode:input.customerMode==='MEMBER'?'MEMBER':'BEARER',updated_at:new Date().toISOString()};
    if(!payload.name||!['FIXED','PERCENT'].includes(payload.discount_type)||payload.discount_value<=0){
      throw Object.assign(new Error('Nama, jenis, dan nilai voucher wajib diisi'),{status:400});
    }
    if(payload.discount_type==='PERCENT'&&payload.discount_value>100){
      throw Object.assign(new Error('Persentase voucher maksimal 100%'),{status:400});
    }
    const rows=await rest('receipt_voucher_campaigns',`tenant_id=eq.${encodeURIComponent(context.tenantId)}&id=eq.${encodeURIComponent(campaignId)}`,{
      method:'PATCH',prefer:'return=representation',body:payload
    });
    if(!rows[0])throw Object.assign(new Error('Promo voucher struk tidak ditemukan'),{status:404});
    return send(response,200,rows[0]);
  }

  if(request.method==='DELETE'&&/^receipt-voucher-campaigns\/[^/]+$/.test(route)){
    requirePermission(session,'promotion.manage');
    const campaignId=route.split('/')[1],tenant=encodeURIComponent(context.tenantId),campaign=encodeURIComponent(campaignId);
    const issued=await rest('vouchers',`tenant_id=eq.${tenant}&receipt_campaign_id=eq.${campaign}&source=eq.RECEIPT&select=id&limit=1`);
    if(issued.length){
      const rows=await rest('receipt_voucher_campaigns',`tenant_id=eq.${tenant}&id=eq.${campaign}`,{
        method:'PATCH',prefer:'return=representation',body:{active:false,updated_at:new Date().toISOString()}
      });
      if(!rows[0])throw Object.assign(new Error('Promo voucher struk tidak ditemukan'),{status:404});
      return send(response,200,{deleted:true,archived:true});
    }
    const rows=await rest('receipt_voucher_campaigns',`tenant_id=eq.${tenant}&id=eq.${campaign}`,{
      method:'DELETE',prefer:'return=representation'
    });
    if(!rows[0])throw Object.assign(new Error('Promo voucher struk tidak ditemukan'),{status:404});
    return send(response,200,{deleted:true,archived:false});
  }

  if(request.method==='POST'&&/^receipt-voucher-campaigns\/[^/]+\/status$/.test(route)){
    requirePermission(session,'promotion.manage');
    const input=bodyOf(request),campaignId=route.split('/')[1];
    const rows=await rest('receipt_voucher_campaigns',`tenant_id=eq.${encodeURIComponent(context.tenantId)}&id=eq.${encodeURIComponent(campaignId)}`,{
      method:'PATCH',prefer:'return=representation',body:{active:Boolean(input.active),updated_at:new Date().toISOString()}
    });
    if(!rows[0])throw Object.assign(new Error('Program voucher struk tidak ditemukan'),{status:404});
    return send(response,200,rows[0]);
  }

  if(request.method==='GET'&&/^customers\/[^/]+\/loyalty$/.test(route)){
    requirePermission(session,'pos.sell');
    const customerId=route.split('/')[1],tenant=encodeURIComponent(context.tenantId);
    const entries=await rest('customer_point_entries',`tenant_id=eq.${tenant}&customer_id=eq.${encodeURIComponent(customerId)}&select=*&order=occurred_at.desc&limit=100`);
    const saleIds=[...new Set(entries.map((entry)=>entry.sale_id).filter(Boolean))];
    const actorIds=[...new Set(entries.map((entry)=>entry.actor_id).filter(Boolean))];
    const [sales,actors]=await Promise.all([
      saleIds.length?rest('sales',`tenant_id=eq.${tenant}&id=${inFilter(saleIds)}&select=id,receipt_no`):[],
      actorIds.length?rest('profiles',`tenant_id=eq.${tenant}&user_id=${inFilter(actorIds)}&select=user_id,display_name,role`):[]
    ]);
    return send(response,200,{entries:entries.map((entry)=>({
      ...entry,points:Number(entry.points),balanceAfter:Number(entry.balance_after),
      receiptNo:sales.find((sale)=>sale.id===entry.sale_id)?.receipt_no??null,
      actor:actors.find((actor)=>actor.user_id===entry.actor_id)??null
    }))});
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

  if (request.method === 'POST' && route === 'customer-groups') {
    requirePermission(session,'catalog.manage');
    if(!['OWNER','ADMIN'].includes(session.profile.role))throw Object.assign(new Error('Hanya Owner atau Admin yang dapat menambah tipe pelanggan'),{status:403});
    const input=bodyOf(request),name=String(input.name??'').trim().replace(/\s+/g,' ');
    if(name.length<2||name.length>50)throw Object.assign(new Error('Nama tipe pelanggan harus berisi 2 sampai 50 karakter'),{status:400});
    const baseId=name.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,36);
    if(baseId.length<2||baseId==='retail')throw Object.assign(new Error('Nama tipe pelanggan tidak dapat digunakan'),{status:400});
    const existing=await rest('customer_price_groups',`tenant_id=eq.${encodeURIComponent(context.tenantId)}&select=id,sort_order`);
    if(existing.some((group)=>String(group.id).toLowerCase()===baseId))throw Object.assign(new Error('Tipe pelanggan dengan nama tersebut sudah ada'),{status:409});
    const sortOrder=Math.max(0,...existing.map((group)=>Number(group.sort_order??0)))+10;
    const rows=await rest('customer_price_groups','',{method:'POST',prefer:'return=representation',body:{
      tenant_id:context.tenantId,id:baseId,name,is_default:false,active:true,sort_order:sortOrder
    }});
    await rest('audit_logs','',{method:'POST',body:{tenant_id:context.tenantId,actor_id:session.authUser.id,action:'CUSTOMER_PRICE_GROUP_CREATED',entity_type:'customer_price_group',entity_id:null,details_json:{id:baseId,name}}});
    return send(response,201,{id:rows[0].id,name:rows[0].name,isDefault:false,active:true,sortOrder});
  }

  if (request.method === 'POST' && route === 'customers') {
    requirePermission(session, 'pos.sell');
    const input = bodyOf(request);
    const customer=await rpc('save_customer_profile',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_customer_id:null,p_name:input.name,
      p_phone:input.phone??'',p_email:input.email??'',p_address:input.address??'',p_group_id:String(input.groupId??'retail'),
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
      p_phone:input.phone??'',p_email:input.email??'',p_address:input.address??'',p_group_id:String(input.groupId??'retail'),
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
    const canViewAllAttendancePhotos=['OWNER','ADMIN'].includes(session.profile.role);
    const tenant=encodeURIComponent(context.tenantId);
    const today=todayInTimeZone(new Date(),context.outlet.timezone??'Asia/Makassar');
    const monthStart=`${today.slice(0,7)}-01`;
    const monthEnd=new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7)),0)).toISOString().slice(0,10);
    const userFilter=canManage?'':`&user_id=eq.${encodeURIComponent(session.authUser.id)}`;
    const [profiles,schedules,shiftRules,attendance,targets,sales]=await Promise.all([
      rest('profiles',`tenant_id=eq.${tenant}&active=eq.true${canManage?'':`&user_id=eq.${encodeURIComponent(session.authUser.id)}`}&select=user_id,display_name,role&order=display_name`),
      rest('employee_schedules',`tenant_id=eq.${tenant}${userFilter}&work_date=gte.${monthStart}&work_date=lte.${monthEnd}&select=*&order=work_date,starts_at`),
      rest('employee_shift_rules',`tenant_id=eq.${tenant}${userFilter}&active=eq.true&select=*&order=effective_from.desc`),
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
    const safeAttendance=attendance.map(({clock_in_photo_path,clock_out_photo_path,...item})=>({
      ...item,
      clock_in_photo_available:Boolean(clock_in_photo_path)&&(item.user_id===session.authUser.id||canViewAllAttendancePhotos),
      clock_out_photo_available:Boolean(clock_out_photo_path)&&(item.user_id===session.authUser.id||canViewAllAttendancePhotos)
    }));
    return send(response,200,{
      canManage,canViewAllAttendancePhotos,today,profiles,outlets:context.outlets,schedules,shiftRules,attendance:safeAttendance,targets,performance,
      activeAttendance:safeAttendance.find((item)=>item.user_id===session.authUser.id&&!item.clock_out_at)??null
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
    if(input.mode==='RECURRING'){
      const weekdays=[...new Set((input.weekdays??[]).map(Number))].filter((day)=>Number.isInteger(day)&&day>=1&&day<=7);
      if(!weekdays.length)throw Object.assign(new Error('Pilih minimal satu hari kerja'),{status:400});
      const rule=await rpc('save_employee_shift_rule_v2',{
        p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_rule_id:null,p_user_id:input.userId,
        p_outlet_id:input.outletId,p_effective_from:input.workDate,p_weekdays:weekdays,
        p_starts_at:input.startsAt,p_ends_at:input.endsAt,p_note:String(input.note??'').trim().slice(0,240)
      });
      return send(response,201,{...rule,mode:'RECURRING'});
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

  const employeeScheduleMatch=route.match(/^workforce\/schedules\/([^/]+)$/);
  if(request.method==='PUT'&&employeeScheduleMatch){
    requirePermission(session,'workforce.manage');
    const input=bodyOf(request),scheduleId=employeeScheduleMatch[1],deviceId=request.headers['x-device-id']||null;
    const employee=await profileFor(input.userId);
    if(!employee?.active||employee.tenant_id!==context.tenantId)throw Object.assign(new Error('Karyawan aktif tidak ditemukan'),{status:404});
    if(!context.outlets.some((outlet)=>outlet.id===input.outletId))throw Object.assign(new Error('Outlet tidak dapat diakses'),{status:403});
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(input.workDate??''))||!/^\d{2}:\d{2}$/.test(String(input.startsAt??''))||!/^\d{2}:\d{2}$/.test(String(input.endsAt??''))){
      throw Object.assign(new Error('Tanggal dan jam jadwal tidak valid'),{status:400});
    }
    if(input.mode==='RECURRING'){
      const weekdays=[...new Set((input.weekdays??[]).map(Number))].filter((day)=>Number.isInteger(day)&&day>=1&&day<=7);
      if(!weekdays.length)throw Object.assign(new Error('Pilih minimal satu hari kerja'),{status:400});
      const rule=await rpc('save_employee_shift_rule_v2',{
        p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_rule_id:scheduleId,p_user_id:input.userId,
        p_outlet_id:input.outletId,p_effective_from:input.workDate,p_weekdays:weekdays,
        p_starts_at:input.startsAt,p_ends_at:input.endsAt,p_note:String(input.note??'').trim().slice(0,240)
      });
      return send(response,200,{...rule,mode:'RECURRING'});
    }
    const existing=(await rest('employee_schedules',`tenant_id=eq.${context.tenantId}&id=eq.${encodeURIComponent(scheduleId)}&select=id&limit=1`))[0];
    if(!existing)throw Object.assign(new Error('Jadwal tanggal khusus tidak ditemukan'),{status:404});
    const rows=await rest('employee_schedules',`tenant_id=eq.${context.tenantId}&id=eq.${encodeURIComponent(scheduleId)}`,{
      method:'PATCH',prefer:'return=representation',body:{user_id:input.userId,outlet_id:input.outletId,
        work_date:input.workDate,starts_at:input.startsAt,ends_at:input.endsAt,
        note:String(input.note??'').trim().slice(0,240)||null,updated_at:new Date().toISOString()}
    });
    await rest('audit_logs','',{method:'POST',body:{tenant_id:context.tenantId,actor_id:session.authUser.id,
      action:'EMPLOYEE_SCHEDULE_EDITED',entity_type:'employee_schedule',entity_id:scheduleId,
      details_json:{userId:input.userId,outletId:input.outletId,workDate:input.workDate,deviceId}}});
    return send(response,200,{...rows[0],mode:'ONCE'});
  }

  if(request.method==='POST'&&route==='workforce/attendance'){
    requirePermission(session,'workforce.self');
    const input=bodyOf(request);
    const latitude=Number(input.latitude),longitude=Number(input.longitude),accuracy=Number(input.accuracy);
    if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||!Number.isFinite(accuracy)||latitude< -90||latitude>90||longitude< -180||longitude>180){
      throw Object.assign(new Error('Aktifkan GPS dan izinkan akses lokasi untuk absensi'),{status:400});
    }
    const tenant=(await rest('tenants',`id=eq.${context.tenantId}&select=attendance_latitude,attendance_longitude,attendance_radius_m&limit=1`))[0];
    if(!tenant||tenant.attendance_latitude===null||tenant.attendance_longitude===null){
      throw Object.assign(new Error('Owner belum mengatur koordinat absensi usaha'),{status:409});
    }
    if(accuracy<0||accuracy>Math.max(Number(tenant.attendance_radius_m??100),100)){
      throw Object.assign(new Error('Akurasi GPS terlalu rendah. Pindah ke area terbuka lalu coba lagi'),{status:400});
    }
    const distance=distanceMeters(Number(tenant.attendance_latitude),Number(tenant.attendance_longitude),latitude,longitude);
    if(distance>Number(tenant.attendance_radius_m??100)){
      throw Object.assign(new Error(`Anda berada ${Math.round(distance)} meter dari lokasi usaha. Batas absensi ${Number(tenant.attendance_radius_m??100)} meter`),{status:403});
    }
    const photoPath=await uploadAttendancePhoto(context.tenantId,input.photoDataUrl);
    try{
      const result=await rpc('clock_employee_attendance_v2',{
        p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_outlet_id:context.outlet.id,
        p_device_id:request.headers['x-device-id']||null,p_action:input.action,
        p_note:String(input.note??'').trim().slice(0,240),p_latitude:latitude,p_longitude:longitude,
        p_accuracy_m:accuracy,p_photo_path:photoPath
      });
      const clockIn=String(input.action??'').toUpperCase()==='CLOCK_IN';
      const late=clockIn&&result.status==='LATE';
      await notifyTenantOwners(context.tenantId,{
        type:clockIn?'ATTENDANCE_CLOCK_IN':'ATTENDANCE_CLOCK_OUT',severity:late?'WARNING':'INFO',
        title:clockIn?`${session.profile.display_name} absen masuk`:`${session.profile.display_name} absen pulang`,
        message:`${context.outlet.name} · ${late?'Terlambat · ':''}${new Date(clockIn?result.clockInAt:result.clockOutAt).toLocaleString('id-ID',{timeZone:context.outlet.timezone??'Asia/Makassar',dateStyle:'medium',timeStyle:'short'})}`,
        entityType:'attendance',entityId:result.id,actionPage:'workforce-attendance-history',
        data:{userId:session.authUser.id,outletId:context.outlet.id,action:clockIn?'CLOCK_IN':'CLOCK_OUT',status:result.status},
        dedupeKey:`attendance:${result.id}:${clockIn?'in':'out'}`
      },request.waitUntil);
      return send(response,200,result);
    }catch(error){await deleteAttendancePhoto(photoPath);throw error;}
  }

  const attendancePhotoMatch=route.match(/^workforce\/attendance\/([^/]+)\/photo$/);
  if(request.method==='GET'&&attendancePhotoMatch){
    requirePermission(session,'workforce.self');
    const attendanceId=attendancePhotoMatch[1],event=queryValue(request,'event')==='out'?'out':'in';
    const rows=await rest('attendance_records',`tenant_id=eq.${context.tenantId}&id=eq.${encodeURIComponent(attendanceId)}&select=user_id,clock_in_photo_path,clock_out_photo_path&limit=1`);
    const attendance=rows[0];
    if(!attendance)throw Object.assign(new Error('Absensi tidak ditemukan'),{status:404});
    if(attendance.user_id!==session.authUser.id&&!['OWNER','ADMIN'].includes(session.profile.role)){
      throw Object.assign(new Error('Anda tidak dapat membuka foto absensi ini'),{status:403});
    }
    const path=event==='out'?attendance.clock_out_photo_path:attendance.clock_in_photo_path;
    if(!path)throw Object.assign(new Error('Foto absensi tidak tersedia'),{status:404});
    return send(response,200,{url:await signedAttendancePhotoUrl(path),expiresIn:120});
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

  if(request.method==='GET'&&route==='pilot/dashboard'){
    requirePermission(session,'pilot.manage');
    const since=encodeURIComponent(new Date(Date.now()-7*86400000).toISOString());
    const [runs,incidents,telemetry,drills,backups,health,safety]=await Promise.all([
      rest('pilot_runs',`tenant_id=eq.${context.tenantId}&select=*&order=created_at.desc&limit=20`),
      rest('production_incidents',`tenant_id=eq.${context.tenantId}&select=*&order=reported_at.desc&limit=100`),
      rest('production_telemetry',`tenant_id=eq.${context.tenantId}&occurred_at=gte.${since}&select=*&order=occurred_at.desc&limit=1000`),
      rest('recovery_drills',`tenant_id=eq.${context.tenantId}&select=*&order=performed_at.desc&limit=20`),
      rest('backup_exports',`tenant_id=eq.${context.tenantId}&status=eq.COMPLETED&select=*&order=created_at.desc&limit=20`),
      rpc('operational_health_check',{p_tenant_id:context.tenantId,p_actor_id:session.authUser.id}),
      rpc('pilot_safety_readiness_v1',{p_tenant_id:context.tenantId,p_actor_id:session.authUser.id})
    ]);
    const activeRun=runs.find((item)=>item.status==='ACTIVE')??runs[0]??null;
    const checks=activeRun?await rest('pilot_check_results',`tenant_id=eq.${context.tenantId}&pilot_run_id=eq.${activeRun.id}&select=*&order=category,check_code`):[];
    const durations=telemetry.map((item)=>Number(item.duration_ms)).filter(Number.isFinite).sort((a,b)=>a-b);
    const p95=durations.length?durations[Math.min(durations.length-1,Math.ceil(durations.length*.95)-1)]:0;
    const endpointMetrics=[...new Set(telemetry.map((item)=>item.endpoint))].map((endpoint)=>{
      const rows=telemetry.filter((item)=>item.endpoint===endpoint),timings=rows.map((item)=>Number(item.duration_ms)).filter(Number.isFinite);
      return {endpoint,events:rows.length,errors:rows.filter((item)=>item.event_type!=='SLOW_REQUEST').length,
        maxDurationMs:timings.length?Math.max(...timings):0,lastSeenAt:rows[0]?.occurred_at??null};
    }).sort((a,b)=>b.events-a.events);
    return send(response,200,{runs,activeRun,checks,incidents,drills,backups,health,safety,
      telemetry:{total:telemetry.length,errors:telemetry.filter((item)=>item.event_type!=='SLOW_REQUEST').length,
        slowRequests:telemetry.filter((item)=>item.event_type==='SLOW_REQUEST').length,p95DurationMs:p95,endpoints:endpointMetrics}});
  }

  if(request.method==='POST'&&route==='pilot/runs'){
    requirePermission(session,'pilot.manage');
    const input=bodyOf(request);
    if(!context.outlets.some((item)=>item.id===input.outletId))throw Object.assign(new Error('Outlet pilot tidak dapat diakses'),{status:403});
    return send(response,201,await rpc('start_pilot_run_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_outlet_id:input.outletId,
      p_name:String(input.name??'').trim(),p_start:input.plannedStart,p_end:input.plannedEnd,
      p_notes:String(input.notes??'').trim()||null
    }));
  }

  if(request.method==='PATCH'&&/^pilot\/checks\/[^/]+$/.test(route)){
    requirePermission(session,'pilot.manage');
    const input=bodyOf(request),checkId=route.split('/')[2];
    return send(response,200,await rpc('update_pilot_check_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_check_id:checkId,
      p_status:input.status,p_evidence:String(input.evidence??'').trim()
    }));
  }

  if(request.method==='POST'&&/^pilot\/runs\/[^/]+\/decide$/.test(route)){
    requirePermission(session,'pilot.manage');
    const input=bodyOf(request),pilotId=route.split('/')[2];
    return send(response,200,await rpc('decide_pilot_run_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_pilot_id:pilotId,
      p_decision:input.decision,p_notes:String(input.notes??'').trim()
    }));
  }

  if(request.method==='POST'&&route==='pilot/incidents'){
    requirePermission(session,'pilot.manage');
    const input=bodyOf(request),outletId=input.outletId||null;
    if(outletId&&!context.outlets.some((item)=>item.id===outletId))throw Object.assign(new Error('Outlet insiden tidak dapat diakses'),{status:403});
    const title=String(input.title??'').trim(),description=String(input.description??'').trim();
    const category=String(input.category??'OTHER').toUpperCase(),severity=String(input.severity??'MEDIUM').toUpperCase();
    if(title.length<3||description.length<5||!['POS','PAYMENT','STOCK','SYNC','PRINTER','SCANNER','PERFORMANCE','DATA','OTHER'].includes(category)||!['LOW','MEDIUM','HIGH','CRITICAL'].includes(severity))
      throw Object.assign(new Error('Data insiden belum lengkap atau tidak valid'),{status:400});
    const rows=await rest('production_incidents','',{method:'POST',prefer:'return=representation',body:{
      tenant_id:context.tenantId,outlet_id:outletId,pilot_run_id:input.pilotRunId||null,category,severity,
      title:title.slice(0,120),description:description.slice(0,1000),
      reproduction_steps:String(input.reproductionSteps??'').trim().slice(0,1500)||null,
      expected_result:String(input.expectedResult??'').trim().slice(0,1000)||null,
      actual_result:String(input.actualResult??'').trim().slice(0,1000)||null,reported_by:session.authUser.id
    }});
    await rest('audit_logs','',{method:'POST',body:{tenant_id:context.tenantId,actor_id:session.authUser.id,
      action:'PRODUCTION_INCIDENT_REPORTED',entity_type:'production_incident',entity_id:rows[0].id,
      details_json:{category,severity,title:title.slice(0,120),deviceId:request.headers['x-device-id']||null}}});
    return send(response,201,rows[0]);
  }

  if(request.method==='PATCH'&&/^pilot\/incidents\/[^/]+$/.test(route)){
    requirePermission(session,'pilot.manage');
    const input=bodyOf(request),incidentId=route.split('/')[2],status=String(input.status??'').toUpperCase();
    if(!['OPEN','INVESTIGATING','RESOLVED','CLOSED'].includes(status))throw Object.assign(new Error('Status insiden tidak valid'),{status:400});
    const body={status,resolution_note:String(input.resolutionNote??'').trim().slice(0,1500)||null,
      ...(status==='RESOLVED'||status==='CLOSED'?{resolved_by:session.authUser.id,resolved_at:new Date().toISOString()}:{})};
    const rows=await rest('production_incidents',`tenant_id=eq.${context.tenantId}&id=eq.${encodeURIComponent(incidentId)}`,{method:'PATCH',prefer:'return=representation',body});
    if(!rows[0])throw Object.assign(new Error('Insiden tidak ditemukan'),{status:404});
    return send(response,200,rows[0]);
  }

  if(request.method==='POST'&&route==='pilot/recovery-drills'){
    requirePermission(session,'pilot.manage');
    const input=bodyOf(request);
    const backups=await rest('backup_exports',`tenant_id=eq.${context.tenantId}&id=eq.${encodeURIComponent(input.backupExportId??'')}&status=eq.COMPLETED&select=*&limit=1`);
    if(!backups[0])throw Object.assign(new Error('Backup terverifikasi tidak ditemukan'),{status:404});
    const checksumVerified=Boolean(input.checksumVerified),procedureReviewed=Boolean(input.procedureReviewed);
    const result=checksumVerified&&procedureReviewed&&input.result==='PASSED'?'PASSED':'FAILED';
    const rows=await rest('recovery_drills','',{method:'POST',prefer:'return=representation',body:{
      tenant_id:context.tenantId,backup_export_id:backups[0].id,result,checksum_verified:checksumVerified,
      procedure_reviewed:procedureReviewed,row_count:Number(backups[0].total_rows??0),
      notes:String(input.notes??'').trim().slice(0,1000)||null,performed_by:session.authUser.id
    }});
    await rest('audit_logs','',{method:'POST',body:{tenant_id:context.tenantId,actor_id:session.authUser.id,
      action:'RECOVERY_DRILL_RECORDED',entity_type:'recovery_drill',entity_id:rows[0].id,
      details_json:{backupExportId:backups[0].id,result,checksumVerified,procedureReviewed}}});
    return send(response,201,rows[0]);
  }

  if(request.method==='POST'&&route==='pilot/telemetry'){
    const input=bodyOf(request),eventType=String(input.eventType??'').toUpperCase();
    if(!['SLOW_REQUEST','HTTP_ERROR','NETWORK_ERROR','CLIENT_ERROR'].includes(eventType))
      throw Object.assign(new Error('Jenis telemetri tidak valid'),{status:400});
    const rawEndpoint=String(input.endpoint??'').split('?')[0].slice(0,160);
    const endpoint=rawEndpoint.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/ig,':id').replace(/\/\d+(?=\/|$)/g,'/:id');
    if(!endpoint.startsWith('/api/')||endpoint==='/api/pilot/telemetry')throw Object.assign(new Error('Endpoint telemetri tidak valid'),{status:400});
    const statusCode=input.statusCode==null?null:Number(input.statusCode),duration=input.durationMs==null?null:Math.max(0,Math.round(Number(input.durationMs)));
    await rest('production_telemetry','',{method:'POST',prefer:'return=minimal',body:{
      tenant_id:context.tenantId,outlet_id:context.outlet?.id??null,user_id:session.authUser.id,
      device_id:/^[0-9a-f-]{36}$/i.test(String(request.headers['x-device-id']??''))?request.headers['x-device-id']:null,
      event_type:eventType,endpoint,status_code:Number.isFinite(statusCode)?statusCode:null,
      duration_ms:Number.isFinite(duration)?Math.min(duration,600000):null,
      detail_json:{online:input.online!==false,platform:String(input.platform??'').slice(0,80)}
    }});
    return send(response,202,{accepted:true});
  }

  if(request.method==='POST'&&route==='pilot/telemetry/purge'){
    requirePermission(session,'pilot.manage');
    const input=bodyOf(request);
    return send(response,200,{deleted:await rpc('purge_old_telemetry_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_retention_days:Number(input.retentionDays??30)
    })});
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
    await rest('audit_logs','',{method:'POST',body:{
      tenant_id:context.tenantId,actor_id:session.authUser.id,action:'SHIFT_OPENED',
      entity_type:'shift',entity_id:rows[0].id,details_json:{outletId:context.outlet.id,openingCash}
    }});
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
    await rest('audit_logs','',{method:'POST',body:{
      tenant_id:context.tenantId,actor_id:session.authUser.id,
      action:movementType==='CASH_IN'?'SHIFT_CASH_ADDED':'SHIFT_CASH_REMOVED',
      entity_type:'cash_movement',entity_id:rows[0].id,
      details_json:{shiftId:shifts[0].id,amount,note:rows[0].note??null}
    }});
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
    const [balances, ledger, products] = await Promise.all([
      restAll('stock_balances', `tenant_id=eq.${context.tenantId}&location_id=${inFilter(context.locationIds)}&select=*&order=location_id`),
      rest('stock_ledger', `tenant_id=eq.${context.tenantId}&location_id=${inFilter(context.locationIds)}&select=*&order=occurred_at.desc&limit=50`),
      restAll('products', `tenant_id=eq.${context.tenantId}&select=id,sku,name,category,brand,image_url,minimum_stock,track_expiry,active&order=name`)
    ]);
    const canViewCost=session.permissions.includes('purchasing.view_cost');
    return send(response, 200, {
      balances:canViewCost?balances:balances.map(({ avg_cost, ...balance })=>balance),
      ledger:canViewCost?ledger:ledger.map(({ unit_cost, ...entry })=>entry),
      products
    });
  }

  const inventoryAdjustmentMatch=route.match(/^inventory-products\/([^/]+)\/adjustments$/);
  if(request.method==='POST'&&inventoryAdjustmentMatch){
    requirePermission(session,'inventory.manage');
    const input=bodyOf(request),key=request.headers['idempotency-key'];
    if(!key)throw Object.assign(new Error('Idempotency-Key wajib diisi'),{status:400});
    requireLocationAccess(context,input.locationId);
    const direction=String(input.direction??'').trim().toUpperCase();
    const quantity=moneyInput(input.quantity,'Jumlah stok');
    const canViewCost=session.permissions.includes('purchasing.view_cost');
    const unitCost=direction==='IN'&&canViewCost?moneyInput(input.unitCost,'Modal per pcs',{allowZero:true}):null;
    const expiresOn=String(input.expiresOn??'').trim()||null;
    if(expiresOn&&!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn))throw Object.assign(new Error('Tanggal EXP tidak valid'),{status:400});
    const result=await rpc('adjust_product_stock_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_idempotency_key:key,
      p_location_id:input.locationId,p_product_id:inventoryAdjustmentMatch[1],
      p_direction:direction,p_quantity:quantity,p_unit_cost:unitCost,
      p_batch_no:String(input.batchNo??'').trim()||null,p_expires_on:expiresOn,
      p_reason:String(input.reason??'').trim()
    });
    return send(response,result.duplicate?200:201,result);
  }

  const inventoryProductMatch=route.match(/^inventory-products\/([^/]+)$/);
  if(request.method==='GET'&&inventoryProductMatch){
    requirePermission(session,'inventory.manage');
    const productId=inventoryProductMatch[1],scope=`tenant_id=eq.${context.tenantId}&product_id=eq.${encodeURIComponent(productId)}`;
    const includeHistory=queryValue(request,'includeHistory')==='true';
    const [products,balances,batches,ledger,allocations,kaspinSaleItems,kaspinPurchaseItems,openingEntries]=await Promise.all([
      rest('products',`tenant_id=eq.${context.tenantId}&id=eq.${encodeURIComponent(productId)}&select=id,sku,name,category,brand,image_url,minimum_stock,track_expiry,active&limit=1`),
      rest('stock_balances',`${scope}&location_id=${inFilter(context.locationIds)}&select=*&order=location_id`),
      rest('inventory_batches',`${scope}&location_id=${inFilter(context.locationIds)}&select=*&order=received_at.desc&limit=200`),
      includeHistory?rest('stock_ledger',`${scope}&location_id=${inFilter(context.locationIds)}&select=*&order=occurred_at.desc&limit=200`):Promise.resolve([]),
      includeHistory?rest('sale_stock_allocations',`${scope}&select=*&order=occurred_at.desc&limit=200`).catch(()=>[]):Promise.resolve([]),
      includeHistory?restAll('sale_items',`${scope}&select=id,sale_id,base_qty,cost_total`):Promise.resolve([]),
      includeHistory?restAll('purchase_receipt_items',`${scope}&document_no=like.KASPIN-*&select=id,receipt_id,base_qty,unit_cost,supplier_name,document_no,received_at`):Promise.resolve([]),
      includeHistory?rest('stock_ledger',`${scope}&location_id=${inFilter(context.locationIds)}&event_type=in.(OPENING_IMPORT,OPENING_BALANCE)&select=balance_after,occurred_at&order=occurred_at.asc&limit=1`):Promise.resolve([])
    ]);
    if(!products[0])throw Object.assign(new Error('Produk tidak ditemukan'),{status:404});
    const kaspinSaleIds=[...new Set(kaspinSaleItems.map((item)=>item.sale_id).filter(Boolean))];
    const kaspinSales=kaspinSaleIds.length?(await Promise.all(
      Array.from({length:Math.ceil(kaspinSaleIds.length/80)},(_,index)=>kaspinSaleIds.slice(index*80,index*80+80))
        .map((ids)=>rest('sales',`tenant_id=eq.${context.tenantId}&id=${inFilter(ids)}&source_system=eq.KASPIN&select=id,receipt_no,occurred_at,source_cashier,status`))
    )).flat():[];
    const canViewCost=session.permissions.includes('purchasing.view_cost');
    const locations=new Map(context.locations.map((location)=>[location.id,location]));
    const visibleLedgerIds=new Set(ledger.map((item)=>item.id));
    const actorIds=[...new Set(ledger.map((item)=>item.actor_id).filter(Boolean))];
    const referenceIds=(types)=>[...new Set(ledger.filter((item)=>types.includes(item.event_type)).map((item)=>item.reference_id).filter(Boolean))];
    const saleIds=referenceIds(['SALE','SALE_VOID']);
    const purchaseIds=referenceIds(['PURCHASE_RECEIPT']);
    const adjustmentIds=referenceIds(['STOCK_ADJUSTMENT_IN','STOCK_ADJUSTMENT_OUT','MANUAL_IN','MANUAL_OUT']);
    const countIds=referenceIds(['STOCK_COUNT']);
    const transferIds=referenceIds(['TRANSFER_IN','TRANSFER_OUT']);
    const returnIds=referenceIds(['CUSTOMER_RETURN']);
    const supplierReturnIds=referenceIds(['SUPPLIER_RETURN']);
    const tenant=`tenant_id=eq.${context.tenantId}`;
    const [actors,sales,purchases,adjustments,counts,transfers,returns,supplierReturns]=await Promise.all([
      actorIds.length?rest('profiles',`${tenant}&user_id=${inFilter(actorIds)}&select=user_id,display_name,role`):[],
      saleIds.length?rest('sales',`${tenant}&id=${inFilter(saleIds)}&select=id,receipt_no,status,void_reason`):[],
      purchaseIds.length?rest('purchase_receipts',`${tenant}&id=${inFilter(purchaseIds)}&select=id,document_no,supplier_name`):[],
      adjustmentIds.length?rest('stock_adjustments',`${tenant}&id=${inFilter(adjustmentIds)}&select=id,reason,batch_no,expires_on`):[],
      countIds.length?rest('stock_counts',`${tenant}&id=${inFilter(countIds)}&select=id,count_no`):[],
      transferIds.length?rest('stock_transfers',`${tenant}&id=${inFilter(transferIds)}&select=id,transfer_no`):[],
      returnIds.length?rest('customer_returns',`${tenant}&id=${inFilter(returnIds)}&select=id,return_no,sale_id,reason`):[],
      supplierReturnIds.length?rest('supplier_returns',`${tenant}&id=${inFilter(supplierReturnIds)}&select=id,return_no,reason,supplier_name`):[]
    ]);
    const documents=new Map([
      ...sales.map((item)=>[item.id,{documentNo:item.receipt_no,reason:item.status==='VOIDED'?(item.void_reason||'Transaksi dibatalkan'):'Barang terjual',saleId:item.id,canOpenReceipt:true}]),
      ...purchases.map((item)=>[item.id,{documentNo:item.document_no,reason:`Diterima dari ${item.supplier_name}`}]),
      ...adjustments.map((item)=>[item.id,{documentNo:null,reason:item.reason,batchNo:item.batch_no,expiresOn:item.expires_on}]),
      ...counts.map((item)=>[item.id,{documentNo:item.count_no,reason:'Hasil penghitungan stok fisik'}]),
      ...transfers.map((item)=>[item.id,{documentNo:item.transfer_no,reason:'Perpindahan stok antar lokasi'}]),
      ...returns.map((item)=>[item.id,{documentNo:item.return_no,reason:item.reason,saleId:item.sale_id,canOpenReceipt:true}]),
      ...supplierReturns.map((item)=>[item.id,{documentNo:item.return_no,reason:`${item.reason}${item.supplier_name?` · ${item.supplier_name}`:''}`}])
    ]);
    const kaspinSaleById=new Map(kaspinSales.map((sale)=>[sale.id,sale]));
    const legacyByReference=new Map();
    kaspinSaleItems.forEach((item)=>{
      const sale=kaspinSaleById.get(item.sale_id);
      if(!sale||sale.status==='VOIDED')return;
      const key=`sale:${sale.id}`,existing=legacyByReference.get(key);
      if(existing){existing.delta-=Number(item.base_qty);existing.costTotal+=Number(item.cost_total??0);return;}
      legacyByReference.set(key,{
        id:`kaspin-sale-${sale.id}`,locationId:context.locations.find((location)=>location.outlet_id===context.outlet.id)?.id??context.locationIds[0],
        delta:-Number(item.base_qty),eventType:'KASPIN_SALE',referenceId:sale.id,occurredAt:sale.occurred_at,
        actorName:sale.source_cashier||'Kasir Pintar',actorRole:'KASPIN',documentNo:sale.receipt_no,
        reason:'Penjualan sebelum migrasi dari Kasir Pintar',saleId:sale.id,canOpenReceipt:true,
        costTotal:Number(item.cost_total??0),legacy:true,balanceEstimated:true
      });
    });
    kaspinPurchaseItems.forEach((item)=>{
      const key=`purchase:${item.receipt_id}`,existing=legacyByReference.get(key);
      if(existing){existing.delta+=Number(item.base_qty);existing.costTotal+=Number(item.base_qty)*Number(item.unit_cost??0);return;}
      legacyByReference.set(key,{
        id:`kaspin-purchase-${item.receipt_id}`,locationId:balances[0]?.location_id??context.locationIds[0],
        delta:Number(item.base_qty),eventType:'KASPIN_PURCHASE',referenceId:item.receipt_id,occurredAt:item.received_at,
        actorName:'Kasir Pintar',actorRole:'KASPIN',documentNo:item.document_no,
        reason:`Pembelian sebelum migrasi${item.supplier_name?` dari ${item.supplier_name}`:''}`,
        canOpenReceipt:false,costTotal:Number(item.base_qty)*Number(item.unit_cost??0),legacy:true,balanceEstimated:true
      });
    });
    const legacyLedger=[...legacyByReference.values()].sort((a,b)=>new Date(a.occurredAt)-new Date(b.occurredAt));
    const snapshotBalance=Number(openingEntries[0]?.balance_after??balances.reduce((sum,item)=>sum+Number(item.quantity??0),0));
    let reconstructedBalance=snapshotBalance-legacyLedger.reduce((sum,item)=>sum+Number(item.delta),0);
    legacyLedger.forEach((item)=>{
      reconstructedBalance+=Number(item.delta);
      item.balanceAfter=reconstructedBalance;
      if(canViewCost)item.unitCost=Math.abs(Number(item.delta))>0?Number(item.costTotal??0)/Math.abs(Number(item.delta)):0;
      item.locationName=locations.get(item.locationId)?.name??'Toko Utama';
      delete item.costTotal;
    });
    const visibleBatches=batches.map((batch)=>({
      id:batch.id,locationId:batch.location_id,locationName:locations.get(batch.location_id)?.name??'Lokasi',
      batchNo:batch.batch_no??'-',expiresOn:batch.expires_on,receivedAt:batch.received_at,
      receivedQty:Number(batch.received_qty),availableQty:Number(batch.available_qty),
      supplierName:batch.supplier_name??'-',
      ...(canViewCost?{unitCost:Number(batch.unit_cost),stockValue:Number(batch.available_qty)*Number(batch.unit_cost)}:{})
    }));
    return send(response,200,{
      product:products[0],canViewCost,historyLoaded:includeHistory,
      balances:balances.map((balance)=>({
        locationId:balance.location_id,locationName:locations.get(balance.location_id)?.name??'Lokasi',
        quantity:Number(balance.quantity),...(canViewCost?{averageCost:Number(balance.avg_cost)}:{})
      })),
      batches:visibleBatches,
      ledger:[...ledger.map((item)=>{
        const actor=actors.find((profile)=>profile.user_id===item.actor_id);
        const document=documents.get(item.reference_id)??{};
        return {
        id:item.id,locationId:item.location_id,locationName:locations.get(item.location_id)?.name??'Lokasi',
        delta:Number(item.delta),balanceAfter:Number(item.balance_after),eventType:item.event_type,
        referenceId:item.reference_id,note:item.note,occurredAt:item.occurred_at,
        actorId:item.actor_id,actorName:actor?.display_name??'Sistem',actorRole:actor?.role??null,
        documentNo:document.documentNo??null,reason:document.reason??item.note??null,
        saleId:document.saleId??null,canOpenReceipt:Boolean(document.canOpenReceipt),
        batchNo:document.batchNo??null,expiresOn:document.expiresOn??null,
        ...(canViewCost?{unitCost:Number(item.unit_cost)}:{})
      }}),...legacyLedger].sort((a,b)=>new Date(b.occurredAt)-new Date(a.occurredAt)),
      allocations:canViewCost?allocations.filter((item)=>visibleLedgerIds.has(item.stock_ledger_id)).map((item)=>({
        id:item.id,saleId:item.sale_id,batchId:item.batch_id,lineIndex:item.line_index,
        quantity:Number(item.base_qty),unitCost:Number(item.unit_cost),costTotal:Number(item.cost_total),
        occurredAt:item.occurred_at
      })):[]
    });
  }

  if (request.method === 'GET' && route === 'expiry-dashboard') {
    requirePermission(session, 'inventory.manage');
    const [batches, products] = await Promise.all([
      restAll('inventory_batches', `tenant_id=eq.${context.tenantId}&location_id=${inFilter(context.locationIds)}&available_qty=gt.0&select=*&order=expires_on.asc.nullslast,received_at.asc`),
      restAll('products', `tenant_id=eq.${context.tenantId}&select=id,sku,name,brand`)
    ]);
    const dashboard = summarizeExpiryBatches({
      rows: batches,
      products,
      locations: context.locations,
      today: todayInTimeZone(new Date(), 'Asia/Makassar')
    });
    return send(response, 200, dashboard);
  }

  if (request.method === 'GET' && route === 'multi-outlet/transfers') {
    requirePermission(session, 'multioutlet.view');
    const transfers = await rest('transfer_requests', `tenant_id=eq.${context.tenantId}&select=*&order=updated_at.desc&limit=200`);
    const visible = transfers.filter((item)=>context.locationIds.includes(item.from_location_id)||context.locationIds.includes(item.to_location_id));
    const ids=visible.map((item)=>item.id);
    const items=ids.length?await rest('transfer_request_items',`tenant_id=eq.${context.tenantId}&transfer_request_id=${inFilter(ids)}&select=*`):[];
    const productIds=[...new Set(items.map((item)=>item.product_id))];
    const products=productIds.length?await rest('products',`tenant_id=eq.${context.tenantId}&id=${inFilter(productIds)}&select=id,sku,name`):[];
    return send(response,200,{transfers:visible.map((item)=>({
      ...item,
      fromLocation:context.locations.find((location)=>location.id===item.from_location_id)??null,
      toLocation:context.locations.find((location)=>location.id===item.to_location_id)??null,
      items:items.filter((line)=>line.transfer_request_id===item.id).map((line)=>({
        ...line,product:products.find((product)=>product.id===line.product_id)??null
      }))
    }))});
  }

  if (request.method === 'POST' && route === 'multi-outlet/transfers') {
    requirePermission(session, 'multioutlet.manage');
    const input=bodyOf(request),key=request.headers['idempotency-key'];
    if(!key)throw Object.assign(new Error('Idempotency-Key wajib diisi'),{status:400});
    requireLocationAccess(context,input.fromLocationId);
    requireLocationAccess(context,input.toLocationId);
    const result=await rpc('request_stock_transfer_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_idempotency_key:key,
      p_from_location_id:input.fromLocationId,p_to_location_id:input.toLocationId,
      p_note:String(input.note??'').trim()||null,p_items:input.items
    });
    return send(response,result.duplicate?200:201,result);
  }

  const transferAction=route.match(/^multi-outlet\/transfers\/([^/]+)\/(approve|reject|cancel|ship|receive)$/);
  if(request.method==='POST'&&transferAction){
    requirePermission(session,'multioutlet.manage');
    const transferId=transferAction[1],action=transferAction[2].toUpperCase(),input=bodyOf(request);
    const rows=await rest('transfer_requests',`tenant_id=eq.${context.tenantId}&id=eq.${encodeURIComponent(transferId)}&select=from_location_id,to_location_id&limit=1`);
    if(!rows[0]||(!context.locationIds.includes(rows[0].from_location_id)&&!context.locationIds.includes(rows[0].to_location_id)))
      throw Object.assign(new Error('Dokumen transfer tidak ditemukan pada outlet yang dapat diakses'),{status:404});
    if(action==='SHIP'&&!context.locationIds.includes(rows[0].from_location_id))
      throw Object.assign(new Error('Pengiriman hanya dapat dilakukan dari lokasi yang dapat diakses'),{status:403});
    if(action==='RECEIVE'&&!context.locationIds.includes(rows[0].to_location_id))
      throw Object.assign(new Error('Penerimaan hanya dapat dilakukan pada lokasi tujuan yang dapat diakses'),{status:403});
    return send(response,200,await rpc('advance_stock_transfer_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_transfer_id:transferId,
      p_action:action,p_note:String(input.note??'').trim()||null
    }));
  }

  if(request.method==='GET'&&route==='multi-outlet/pricing'){
    requirePermission(session,'multioutlet.view');
    const [overrides,baseRules]=await Promise.all([
      rest('outlet_price_overrides',`tenant_id=eq.${context.tenantId}&outlet_id=${inFilter(context.outlets.map((item)=>item.id))}&select=*&order=updated_at.desc`),
      rest('price_rules',`tenant_id=eq.${context.tenantId}&starts_at=is.null&ends_at=is.null&select=product_id,customer_group_id,min_base_qty,unit_price_base,priority`)
    ]);
    return send(response,200,{overrides,baseRules});
  }

  if(request.method==='PUT'&&route==='multi-outlet/pricing'){
    requirePermission(session,'multioutlet.manage');
    const input=bodyOf(request);
    if(!context.outlets.some((item)=>item.id===input.outletId))throw Object.assign(new Error('Outlet harga tidak dapat diakses'),{status:403});
    return send(response,200,await rpc('save_outlet_price_override_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_outlet_id:input.outletId,
      p_product_id:input.productId,p_customer_group_id:input.customerGroupId??'retail',
      p_min_base_qty:Number(input.minBaseQty??1),p_unit_price_base:Number(input.unitPriceBase),
      p_active:input.active!==false
    }));
  }

  if(request.method==='GET'&&route==='multi-outlet/promotions'){
    requirePermission(session,'multioutlet.view');
    const [versions,assignments]=await Promise.all([
      loadPromotionManagement(context.tenantId),
      rest('promotion_outlets',`tenant_id=eq.${context.tenantId}&select=*`)
    ]);
    return send(response,200,{versions:versions.map((item)=>({
      ...item,outletIds:assignments.filter((row)=>row.promotion_version_id===item.id).map((row)=>row.outlet_id)
    }))});
  }

  const promotionScope=route.match(/^multi-outlet\/promotions\/([^/]+)\/outlets$/);
  if(request.method==='PUT'&&promotionScope){
    requirePermission(session,'multioutlet.manage');
    const input=bodyOf(request),outletIds=Array.isArray(input.outletIds)?input.outletIds:[];
    if(outletIds.some((id)=>!context.outlets.some((outlet)=>outlet.id===id)))
      throw Object.assign(new Error('Ada outlet promo yang tidak dapat diakses'),{status:403});
    const currentAssignments=await rest('promotion_outlets',`tenant_id=eq.${context.tenantId}&promotion_version_id=eq.${encodeURIComponent(promotionScope[1])}&select=outlet_id`);
    const inaccessible=currentAssignments.map((item)=>item.outlet_id).filter((id)=>!context.outlets.some((outlet)=>outlet.id===id));
    const scopedOutletIds=[...new Set([...inaccessible,...outletIds])];
    return send(response,200,await rpc('assign_promotion_outlets_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,
      p_promotion_version_id:promotionScope[1],p_outlet_ids:scopedOutletIds
    }));
  }

  if(request.method==='GET'&&route==='multi-outlet/consolidation'){
    requirePermission(session,'multioutlet.view');
    const outletIds=context.outlets.map((item)=>item.id),locationIds=context.locationIds;
    const [balances,sales,transfers]=await Promise.all([
      rest('stock_balances',`tenant_id=eq.${context.tenantId}&location_id=${inFilter(locationIds)}&select=location_id,product_id,quantity,avg_cost`),
      rest('sales',`tenant_id=eq.${context.tenantId}&outlet_id=${inFilter(outletIds)}&status=eq.COMPLETED&occurred_at=gte.${encodeURIComponent(new Date(Date.now()-30*86400000).toISOString())}&select=outlet_id,grand_total,cost_total`),
      rest('transfer_requests',`tenant_id=eq.${context.tenantId}&status=eq.IN_TRANSIT&select=id,from_location_id,to_location_id`)
    ]);
    const scopedTransfers=transfers.filter((item)=>locationIds.includes(item.from_location_id)||locationIds.includes(item.to_location_id));
    const transferItems=scopedTransfers.length?await rest('transfer_request_items',`tenant_id=eq.${context.tenantId}&transfer_request_id=${inFilter(scopedTransfers.map((item)=>item.id))}&select=transfer_request_id,shipped_qty,unit_cost`):[];
    return send(response,200,{
      totals:{
        outlets:context.outlets.length,
        stockQty:balances.reduce((sum,item)=>sum+Number(item.quantity),0),
        stockValue:balances.reduce((sum,item)=>sum+Number(item.quantity)*Number(item.avg_cost),0),
        sales30d:sales.reduce((sum,item)=>sum+Number(item.grand_total),0),
        grossProfit30d:sales.reduce((sum,item)=>sum+Number(item.grand_total)-Number(item.cost_total),0),
        inTransitQty:transferItems.reduce((sum,item)=>sum+Number(item.shipped_qty),0),
        inTransitValue:transferItems.reduce((sum,item)=>sum+Number(item.shipped_qty)*Number(item.unit_cost),0)
      },
      outlets:context.outlets.map((outlet)=>{
        const ownLocations=context.locations.filter((location)=>location.outlet_id===outlet.id).map((item)=>item.id);
        const ownBalances=balances.filter((item)=>ownLocations.includes(item.location_id));
        const ownSales=sales.filter((item)=>item.outlet_id===outlet.id);
        return {id:outlet.id,name:outlet.name,
          stockQty:ownBalances.reduce((sum,item)=>sum+Number(item.quantity),0),
          stockValue:ownBalances.reduce((sum,item)=>sum+Number(item.quantity)*Number(item.avg_cost),0),
          sales30d:ownSales.reduce((sum,item)=>sum+Number(item.grand_total),0),
          grossProfit30d:ownSales.reduce((sum,item)=>sum+Number(item.grand_total)-Number(item.cost_total),0)};
      })
    });
  }

  if(request.method==='GET'&&route==='multi-outlet/notifications'){
    requirePermission(session,'multioutlet.view');
    const [policies,recentShifts]=await Promise.all([
      rest('restock_policies',`tenant_id=eq.${context.tenantId}&location_id=${inFilter(context.locationIds)}&active=eq.true&select=id,location_id,product_id,minimum_stock`),
      rest('shifts',`tenant_id=eq.${context.tenantId}&outlet_id=${inFilter(context.outlets.map((item)=>item.id))}&status=eq.CLOSED&closed_at=gte.${encodeURIComponent(new Date(Date.now()-30*86400000).toISOString())}&select=id,outlet_id`)
    ]);
    const policyBalances=policies.length?await rest('stock_balances',`tenant_id=eq.${context.tenantId}&location_id=${inFilter(context.locationIds)}&select=location_id,product_id,quantity`):[];
    const productIds=[...new Set(policies.map((item)=>item.product_id))];
    const [products,reconciliations]=await Promise.all([
      productIds.length?rest('products',`tenant_id=eq.${context.tenantId}&id=${inFilter(productIds)}&select=id,name`):[],
      recentShifts.length?rest('shift_reconciliations',`tenant_id=eq.${context.tenantId}&shift_id=${inFilter(recentShifts.map((item)=>item.id))}&select=id,shift_id,payment_method,difference,reconciled_at`):[]
    ]);
    const stockAlerts=policies.filter((policy)=>{
      const balance=policyBalances.find((item)=>item.location_id===policy.location_id&&item.product_id===policy.product_id);
      return Number(balance?.quantity??0)<=Number(policy.minimum_stock);
    }).map((policy)=>{
      const location=context.locations.find((item)=>item.id===policy.location_id),product=products.find((item)=>item.id===policy.product_id);
      const balance=policyBalances.find((item)=>item.location_id===policy.location_id&&item.product_id===policy.product_id);
      return {tenant_id:context.tenantId,outlet_id:location?.outlet_id??null,notification_type:'CRITICAL_STOCK',severity:'CRITICAL',
        fingerprint:`critical-stock:${policy.location_id}:${policy.product_id}`,title:`Stok kritis: ${product?.name??'Produk'}`,
        message:`${location?.name??'Lokasi'} tersisa ${Number(balance?.quantity??0)}; batas minimum ${Number(policy.minimum_stock)}.`,
        entity_type:'restock_policy',entity_id:policy.id,status:'OPEN'};
    });
    const unusualAlerts=reconciliations.filter((item)=>Math.abs(Number(item.difference))>=100000).map((item)=>{
      const shift=recentShifts.find((row)=>row.id===item.shift_id),outlet=context.outlets.find((row)=>row.id===shift?.outlet_id);
      return {tenant_id:context.tenantId,outlet_id:shift?.outlet_id??null,notification_type:'UNUSUAL_ACTIVITY',severity:'WARNING',
        fingerprint:`shift-difference:${item.id}`,title:`Selisih shift ${outlet?.name??'outlet'}`,
        message:`Metode ${item.payment_method} memiliki selisih Rp ${Math.abs(Number(item.difference)).toLocaleString('id-ID')}. Periksa rekonsiliasi dan audit.`,
        entity_type:'shift_reconciliation',entity_id:item.id,status:'OPEN',detected_at:item.reconciled_at};
    });
    const generated=[...stockAlerts,...unusualAlerts];
    if(generated.length)await rest('operational_notifications','on_conflict=tenant_id,fingerprint',{method:'POST',prefer:'resolution=ignore-duplicates,return=minimal',body:generated});
    const notifications=await rest('operational_notifications',`tenant_id=eq.${context.tenantId}&status=eq.OPEN&select=*&order=detected_at.desc&limit=100`);
    return send(response,200,{notifications:notifications.filter((item)=>!item.outlet_id||context.outlets.some((outlet)=>outlet.id===item.outlet_id))});
  }

  const notificationAction=route.match(/^multi-outlet\/notifications\/([^/]+)\/(acknowledge|dismiss)$/);
  if(request.method==='POST'&&notificationAction){
    requirePermission(session,'multioutlet.manage');
    const status=notificationAction[2]==='acknowledge'?'ACKNOWLEDGED':'DISMISSED';
    const rows=await rest('operational_notifications',`tenant_id=eq.${context.tenantId}&id=eq.${encodeURIComponent(notificationAction[1])}`,{
      method:'PATCH',prefer:'return=representation',body:{status,acknowledged_by:session.authUser.id,acknowledged_at:new Date().toISOString()}
    });
    return send(response,200,rows[0]??{id:notificationAction[1],status});
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
    requireAnyPermission(session, ['purchasing.view_cost','purchasing.receive']);
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
      return {
        productId:item.productId,baseQty:qty,unitCost:cost,lineDiscount:0,
        purchaseQty:Number(item.purchaseQty??qty),purchaseUnitId:item.purchaseUnitId??null,
        purchaseUnitName:item.purchaseUnitName??'pcs',purchaseUnitFactor:Number(item.purchaseUnitFactor??1),
        purchaseUnitCost:Number(item.purchaseUnitCost??cost)
      };
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
    requireAnyPermission(session, ['purchasing.view_cost','purchasing.receive']);
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
    if(accessibleOrder.receiving_approval)throw Object.assign(new Error('PO sedang diproses dalam pengajuan penerimaan. Lanjutkan dari menu Persetujuan harga agar stok tidak diterima dua kali.'),{status:409});
    if(await restockNeedsPriceApproval(context.tenantId,input.items))throw Object.assign(new Error('Modal berubah. Ajukan harga kepada Owner sebelum menerima barang.'),{status:409});
    const result = await rpc('receive_purchase_order', {
      p_tenant_id: context.tenantId, p_actor_id: session.authUser.id, p_order_id: orderId,
      p_idempotency_key: key, p_document_no: input.documentNo, p_items: input.items
    });
    return send(response, result.duplicate ? 200 : 201, result);
  }

  if (request.method === 'GET' && route === 'restock-approvals') {
    requirePermission(session, 'purchasing.receive');
    const canApprove=['OWNER','ADMIN'].includes(session.profile.role);
    const requesterFilter=canApprove?'':`&requester_id=eq.${encodeURIComponent(session.authUser.id)}`;
    const rows=await rest('restock_approval_requests',`tenant_id=eq.${context.tenantId}${requesterFilter}&select=*&order=requested_at.desc&limit=100`);
    return send(response,200,{requests:rows.map((row)=>({
      id:row.id,requesterId:row.requester_id,approverId:row.approver_id,supplierId:row.supplier_id,
      locationId:row.location_id,documentNo:row.document_no,items:row.items_json,proposedPrices:row.proposed_prices_json,
      approvedPrices:row.approved_prices_json,status:row.status,requesterNote:row.requester_note,decisionNote:row.decision_note,
      requestedAt:row.requested_at,decidedAt:row.decided_at,receivedAt:row.received_at,receiptId:row.receipt_id
    }))});
  }

  if (request.method === 'POST' && route === 'restock-approvals') {
    requirePermission(session, 'purchasing.receive');
    const input=bodyOf(request);requireLocationAccess(context,input.locationId);
    const purchaseOrderId=input.items?.find?.((item)=>item?.purchaseOrderId)?.purchaseOrderId??null;
    if(purchaseOrderId){
      const purchaseOrder=(await loadPurchaseOrders(context.tenantId,purchaseOrderId,context.locationIds))[0];
      if(!purchaseOrder)throw Object.assign(new Error('Purchase Order tidak ditemukan pada lokasi user'),{status:404});
      if(purchaseOrder.receiving_approval)throw Object.assign(new Error('PO ini sudah memiliki pengajuan penerimaan yang masih diproses.'),{status:409});
    }
    const result=await rpc('submit_restock_approval_v2',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_supplier_id:input.supplierId,
      p_location_id:input.locationId,p_document_no:input.documentNo,p_items:input.items,
      p_proposed_prices:input.proposedPrices??[],p_note:input.note??''
    });
    await notifyTenantOwners(context.tenantId,{
      type:'RESTOCK_APPROVAL',severity:'WARNING',title:`Persetujuan restok ${input.documentNo}`,
      message:`${session.profile.display_name} mengajukan ${Array.isArray(input.items)?input.items.length:0} barang untuk diperiksa Owner.`,
      entityType:'restock_approval',entityId:result.id??null,actionPage:'restock-approvals',
      data:{documentNo:input.documentNo,itemCount:Array.isArray(input.items)?input.items.length:0,requesterId:session.authUser.id},
      dedupeKey:`restock-approval:${result.id??input.documentNo}`
    },request.waitUntil);
    return send(response,201,result);
  }

  if (request.method === 'POST' && /^restock-approvals\/[^/]+\/(approve|reject|revise)$/.test(route)) {
    if(!['OWNER','ADMIN'].includes(session.profile.role))throw Object.assign(new Error('Hanya Owner/Admin yang dapat memutuskan'),{status:403});
    const [,requestId,action]=route.split('/'),input=bodyOf(request);
    const result=await rpc('decide_restock_approval_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_request_id:requestId,
      p_decision:action.toUpperCase(),p_approved_prices:input.prices??[],p_note:input.note??''
    });
    return send(response,200,result);
  }

  if (request.method === 'POST' && /^restock-approvals\/[^/]+\/resubmit$/.test(route)) {
    requirePermission(session,'purchasing.receive');
    const [,requestId]=route.split('/'),input=bodyOf(request);
    const result=await rpc('resubmit_restock_approval_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_request_id:requestId,
      p_items:input.items,p_note:input.note??''
    });
    return send(response,200,result);
  }

  if (request.method === 'POST' && /^restock-approvals\/[^/]+\/receive$/.test(route)) {
    requirePermission(session,'purchasing.receive');
    const requestId=route.split('/')[1],key=request.headers['idempotency-key'];
    if(!key)throw Object.assign(new Error('Idempotency-Key wajib diisi'),{status:400});
    const result=await rpc('receive_approved_restock_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_request_id:requestId,p_idempotency_key:key
    });
    return send(response,result.duplicate?200:201,result);
  }

  if (request.method === 'POST' && route === 'purchase-receipts') {
    requirePermission(session, 'purchasing.receive');
    const input = bodyOf(request);
    const key = request.headers['idempotency-key'];
    if (!key) { const error = new Error('Idempotency-Key wajib diisi'); error.status = 400; throw error; }
    requireLocationAccess(context, input.locationId);
    if(await restockNeedsPriceApproval(context.tenantId,input.items))throw Object.assign(new Error('Modal berubah. Ajukan harga kepada Owner sebelum menerima barang.'),{status:409});
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
    requireAnyPermission(session, ['purchasing.view_cost','purchasing.receive']);
    const input = bodyOf(request);
    const items = await rest('purchase_receipt_items', `tenant_id=eq.${context.tenantId}&product_id=eq.${encodeURIComponent(input.productId)}&select=*&order=received_at.desc&limit=50`);
    const history = items.map((item) => ({
      occurredAt: item.received_at,
      costPerBase: Number(item.unit_cost),
      supplier: item.supplier_name,
      batch: item.batch_no
    }));
    const comparison = compareCost(Number(input.newCost), history);
    return send(response, 200, { ...comparison, lastDocument: items[0]?.document_no ?? null, supplierScoped: false });
  }

  if (request.method === 'GET' && route.startsWith('supplier-comparison/')) {
    requireAnyPermission(session, ['purchasing.view_cost','purchasing.receive']);
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
    requireAnyPermission(session, ['purchasing.view_cost','purchasing.receive']);
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
    const reportScope=queryValue(request,'scope')==='report';
    if(reportScope)requireAnyPermission(session,['report.transactions','report.view']);
    else requirePermission(session,'pos.sell');
    const outletId=queryValue(request,'outletId');
    const from=queryValue(request,'from'),to=queryValue(request,'to');
    if(reportScope&&(!/^\d{4}-\d{2}-\d{2}$/.test(from??'')||!/^\d{4}-\d{2}-\d{2}$/.test(to??'')||from>to)){
      throw Object.assign(new Error('Periode riwayat transaksi tidak valid'),{status:400});
    }
    if(outletId&&!context.outlets.some((outlet)=>outlet.id===outletId)){
      throw Object.assign(new Error('Outlet riwayat transaksi tidak dapat diakses'),{status:403});
    }
    const outletIds=reportScope?(outletId?[outletId]:context.outlets.map((outlet)=>outlet.id)):[context.outlet.id];
    const sales=await loadPosSales(context, queryValue(request,'q') ?? '', {
      outletIds,from:reportScope?from:null,to:reportScope?to:null,limit:reportScope?500:50
    });
    const safeSales=!session.permissions.includes('report.view')?sales.map((sale)=>{
      const {grossProfit,netCost,returnCost,...safe}=sale;
      const {manualAdjustment,...quote}=safe.quote??{};
      return {...safe,quote};
    }):sales;
    return send(response, 200, { sales:safeSales });
  }

  const inventorySaleReceiptMatch=route.match(/^inventory-sales\/([^/]+)\/receipt$/);
  if(request.method==='GET'&&inventorySaleReceiptMatch){
    requirePermission(session,'inventory.manage');
    const sales=await loadPosSales(context,'',{
      outletIds:context.outlets.map((outlet)=>outlet.id),saleId:inventorySaleReceiptMatch[1],limit:1
    });
    if(!sales[0])throw Object.assign(new Error('Riwayat struk tidak ditemukan atau tidak dapat diakses'),{status:404});
    return send(response,200,{sale:sales[0]});
  }

  if(request.method==='GET'&&route==='purchase-receipts/report'){
    requirePermission(session,'report.view');
    const from=queryValue(request,'from'),to=queryValue(request,'to'),outletId=queryValue(request,'outletId');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(from??'')||!/^\d{4}-\d{2}-\d{2}$/.test(to??'')||from>to){
      throw Object.assign(new Error('Periode laporan pembelian tidak valid'),{status:400});
    }
    if(outletId&&!context.outlets.some((outlet)=>outlet.id===outletId)){
      throw Object.assign(new Error('Outlet laporan pembelian tidak dapat diakses'),{status:403});
    }
    const allowedOutletIds=outletId?[outletId]:context.outlets.map((outlet)=>outlet.id);
    const locations=context.locations.filter((location)=>allowedOutletIds.includes(location.outlet_id));
    if(!locations.length)return send(response,200,{receipts:[]});
    const tenant=encodeURIComponent(context.tenantId);
    let receipts=await restAll('purchase_receipts',`tenant_id=eq.${tenant}&location_id=${inFilter(locations.map((item)=>item.id))}&status=eq.RECEIVED&occurred_at=gte.${encodeURIComponent(`${shiftIsoDate(from,-1)}T00:00:00Z`)}&occurred_at=lt.${encodeURIComponent(`${shiftIsoDate(to,2)}T00:00:00Z`)}&select=*&order=occurred_at.desc`);
    const timezone=context.outlet.timezone??'Asia/Makassar';
    receipts=receipts.filter((receipt)=>{const date=todayInTimeZone(new Date(receipt.occurred_at),timezone);return date>=from&&date<=to;});
    if(!receipts.length)return send(response,200,{receipts:[]});
    const receiptIds=receipts.map((item)=>item.id);
    const byIds=async(table,column,ids,tail)=>(await Promise.all(
      Array.from({length:Math.ceil(ids.length/100)},(_,index)=>ids.slice(index*100,index*100+100))
        .map((chunk)=>rest(table,`tenant_id=eq.${tenant}&${column}=${inFilter(chunk)}&${tail}`))
    )).flat();
    const items=await byIds('purchase_receipt_items','receipt_id',receiptIds,'select=*&order=id');
    const productIds=[...new Set(items.map((item)=>item.product_id))];
    const actorIds=[...new Set(receipts.map((item)=>item.actor_id).filter(Boolean))];
    const [products,actors]=await Promise.all([
      productIds.length?byIds('products','id',productIds,'select=id,sku,name'):[],
      actorIds.length?byIds('profiles','user_id',actorIds,'select=user_id,display_name'):[]
    ]);
    return send(response,200,{receipts:receipts.map((receipt)=>{
      const lines=items.filter((item)=>item.receipt_id===receipt.id).map((item)=>{
        const product=products.find((row)=>row.id===item.product_id),baseQty=Number(item.base_qty),costPerBase=Number(item.unit_cost);
        const unitFactor=Math.max(1,Number(item.purchase_unit_factor??1));
        const qty=Number(item.received_purchase_qty??(baseQty/unitFactor));
        const unitCost=Number(item.purchase_unit_cost??(costPerBase*unitFactor));
        return{productId:item.product_id,sku:product?.sku??'',productName:product?.name??'Produk',qty,baseQty,
          unitName:item.purchase_unit_name??'pcs',unitFactor,unitCost,costPerBase,total:baseQty*costPerBase,
          batchNo:item.batch_no??'',expiresOn:item.expires_on??null};
      });
      const location=locations.find((item)=>item.id===receipt.location_id);
      return{id:receipt.id,documentNo:receipt.document_no,supplierId:receipt.supplier_id,supplierName:receipt.supplier_name,
        occurredAt:receipt.occurred_at,locationName:location?.name??'Lokasi',outletName:context.outlets.find((item)=>item.id===location?.outlet_id)?.name??'Outlet',
        receiver:actors.find((item)=>item.user_id===receipt.actor_id)?.display_name??'Staff',lines,
        total:lines.reduce((sum,line)=>sum+line.total,0)};
    })});
  }

  if (request.method === 'POST' && /^pos-sales\/[^/]+\/void$/.test(route)) {
    requirePermission(session, 'pos.sell');
    requirePermission(session, 'sale.void');
    const input = bodyOf(request);
    const saleId = route.split('/')[1];
    const result = await rpc('void_sale_v2', {
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_approved_by:session.authUser.id,
      p_sale_id:saleId,p_outlet_id:context.outlet.id,p_reason:String(input.reason ?? '')
    });
    try{
      await rpc('cancel_receipt_vouchers_for_sale_v1',{
        p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_sale_id:saleId
      });
    }catch(error){
      console.error('Receipt voucher cancellation failed after void',error.message);
    }
    let stockBalances=null;
    try{
      const saleItems=await rest('sale_items',`tenant_id=eq.${context.tenantId}&sale_id=eq.${encodeURIComponent(saleId)}&select=product_id`);
      const productIds=[...new Set(saleItems.map((item)=>item.product_id).filter(Boolean))];
      stockBalances=context.storeLocation&&productIds.length
        ?await rest('stock_balances',`tenant_id=eq.${context.tenantId}&location_id=eq.${encodeURIComponent(context.storeLocation.id)}&product_id=${inFilter(productIds)}&select=product_id,quantity`)
        :[];
    }catch(error){
      console.error('Stock snapshot failed after void',error.message);
    }
    return send(response, 200, {...result,stockBalances});
  }

  if (request.method === 'GET' && route.startsWith('sales/')) {
    requirePermission(session, 'sales.return');
    const saleId = route.split('/').pop();
    const sale = await loadReturnableSale(context,{saleId});
    if (!sale) { const error = new Error('Transaksi penjualan tidak ditemukan'); error.status = 404; throw error; }
    return send(response, 200, { sale });
  }

  if(request.method==='GET'&&route==='reports/sales-filtered'){
    requirePermission(session,'report.view');
    const timezone=context.outlet.timezone??'Asia/Makassar';
    const from=queryValue(request,'from'),to=queryValue(request,'to'),outletId=queryValue(request,'outletId');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(from??'')||!/^\d{4}-\d{2}-\d{2}$/.test(to??'')||from>to){
      throw Object.assign(new Error('Periode laporan penjualan tidak valid'),{status:400});
    }
    if(outletId&&!context.outlets.some((outlet)=>outlet.id===outletId)){
      throw Object.assign(new Error('User tidak memiliki akses ke outlet laporan'),{status:403});
    }
    const allowedMethods=['CASH','QRIS','TRANSFER','EDC','CREDIT','MULTIPAYMENT'];
    const rawMethods=queryValue(request,'paymentMethods');
    const paymentMethods=(rawMethods==null?allowedMethods:String(rawMethods).split(',').map((item)=>item.trim().toUpperCase()))
      .filter((method)=>allowedMethods.includes(method));
    const paymentState=['ALL','PAID','CREDIT'].includes(String(queryValue(request,'paymentState')).toUpperCase())
      ? String(queryValue(request,'paymentState')).toUpperCase():'ALL';
    const outletIds=outletId?[outletId]:context.outlets.map((outlet)=>outlet.id);
    const staffId=String(queryValue(request,'staffId')??'');
    const includeCreditProfit=queryValue(request,'includeCreditProfit')!=='false';
    const includeCreditRevenue=queryValue(request,'includeCreditRevenue')==='true';
    const report=await rpc('report_sales_filtered_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_outlet_ids:outletIds,
      p_from:from,p_to:to,p_timezone:timezone,p_staff_id:staffId||null,p_payment_state:paymentState,
      p_payment_methods:paymentMethods,p_include_credit_profit:includeCreditProfit,
      p_include_credit_revenue:includeCreditRevenue
    });
    return send(response,200,{...report,period:{from,to},truncated:false});
  }

  if(request.method==='GET'&&route==='reports/sales-items'){
    requirePermission(session,'report.view');
    const from=queryValue(request,'from'),to=queryValue(request,'to'),outletId=queryValue(request,'outletId');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(from??'')||!/^\d{4}-\d{2}-\d{2}$/.test(to??'')||from>to)throw Object.assign(new Error('Periode analisis barang tidak valid'),{status:400});
    if(outletId&&!context.outlets.some((outlet)=>outlet.id===outletId))throw Object.assign(new Error('Outlet laporan tidak dapat diakses'),{status:403});
    const allowedMethods=['CASH','QRIS','TRANSFER','EDC','CREDIT','MULTIPAYMENT'];
    const rawMethods=queryValue(request,'paymentMethods');
    const options={
      staffId:String(queryValue(request,'staffId')??''),
      paymentState:['ALL','PAID','CREDIT'].includes(String(queryValue(request,'paymentState')).toUpperCase())?String(queryValue(request,'paymentState')).toUpperCase():'ALL',
      paymentMethods:(rawMethods==null?allowedMethods:String(rawMethods).split(',').map((item)=>item.trim().toUpperCase())).filter((method)=>allowedMethods.includes(method)),
      includeCreditProfit:queryValue(request,'includeCreditProfit')!=='false',
      includeCreditRevenue:queryValue(request,'includeCreditRevenue')==='true'
    };
    const outletIds=outletId?[outletId]:context.outlets.map((outlet)=>outlet.id);
    const sales=await loadSalesReportSource(context,{outletIds,from,to,limit:10000});
    if(!sales.length)return send(response,200,{products:[],categories:[],addons:[],staff:[],dashboard:{qtySold:0,netRevenue:0,grossProfit:0},period:{from,to}});
    const saleIds=sales.map((sale)=>sale.id);
    const byChunks=async(table,column,ids,tail)=>(await Promise.all(Array.from({length:Math.ceil(ids.length/80)},(_,index)=>ids.slice(index*80,index*80+80)).map((chunk)=>rest(table,`tenant_id=eq.${context.tenantId}&${column}=${inFilter(chunk)}&${tail}`)))).flat();
    const items=await byChunks('sale_items','sale_id',saleIds,'select=sale_id,product_id,product_name,base_qty,total,cost_total');
    const returns=await byChunks('customer_returns','sale_id',saleIds,'status=eq.COMPLETED&select=id,sale_id');
    const rawReturnItems=returns.length?await byChunks('customer_return_items','return_id',returns.map((item)=>item.id),'select=return_id,product_id,base_qty,line_total,unit_cost'):[];
    const returnSaleMap=new Map(returns.map((item)=>[item.id,item.sale_id]));
    const returnItems=rawReturnItems.map((item)=>({...item,sale_id:returnSaleMap.get(item.return_id)}));
    const productIds=[...new Set([...items.map((item)=>item.product_id),...returnItems.map((item)=>item.product_id)])];
    const locationIds=context.locations.filter((location)=>outletIds.includes(location.outlet_id)).map((location)=>location.id);
    const [products,balances]=await Promise.all([
      productIds.length?byChunks('products','id',productIds,'select=id,sku,name,category,image_url'):[],
      productIds.length&&locationIds.length?rest('stock_balances',`tenant_id=eq.${context.tenantId}&location_id=${inFilter(locationIds)}&product_id=${inFilter(productIds)}&select=product_id,quantity`):[]
    ]);
    const staff=filteredSalesReport(sales,{timezone:context.outlet.timezone??'Asia/Makassar',paymentMethods:allowedMethods}).staff;
    return send(response,200,{...buildSalesItemAnalytics(sales,items,products,returnItems,balances,options),staff,period:{from,to},truncated:sales.length>=10000});
  }

  if(request.method==='GET'&&route==='reports/stock-flow'){
    requirePermission(session,'report.view');
    const from=queryValue(request,'from'),to=queryValue(request,'to'),outletId=queryValue(request,'outletId');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(from??'')||!/^\d{4}-\d{2}-\d{2}$/.test(to??'')||from>to)throw Object.assign(new Error('Periode arus stok tidak valid'),{status:400});
    if(outletId&&!context.outlets.some((outlet)=>outlet.id===outletId))throw Object.assign(new Error('Outlet arus stok tidak dapat diakses'),{status:403});
    const outletIds=outletId?[outletId]:context.outlets.map((outlet)=>outlet.id);
    const locations=context.locations.filter((location)=>outletIds.includes(location.outlet_id));
    if(!locations.length)return send(response,200,{rows:[],period:{from,to}});
    const timezone=context.outlet.timezone??'Asia/Makassar';
    const ledger=await rest('stock_ledger',`tenant_id=eq.${context.tenantId}&location_id=${inFilter(locations.map((item)=>item.id))}&occurred_at=gte.${encodeURIComponent(`${shiftIsoDate(from,-1)}T00:00:00Z`)}&occurred_at=lt.${encodeURIComponent(`${shiftIsoDate(to,2)}T00:00:00Z`)}&select=id,product_id,delta,event_type,reference_id,occurred_at&order=occurred_at.desc&limit=10000`);
    const scoped=ledger.filter((item)=>{const date=todayInTimeZone(new Date(item.occurred_at),timezone);return date>=from&&date<=to;});
    const productIds=[...new Set(scoped.map((item)=>item.product_id))];
    const products=productIds.length?await rest('products',`tenant_id=eq.${context.tenantId}&id=${inFilter(productIds)}&select=id,sku,name,category,image_url`):[];
    return send(response,200,{rows:buildStockFlowEntries(scoped,products),period:{from,to},truncated:ledger.length>=10000});
  }

  if(request.method==='GET'&&route==='reports/sales-years'){
    requirePermission(session,'report.view');
    const timezone=context.outlet.timezone??'Asia/Makassar';
    const today=todayInTimeZone(new Date(),timezone);
    const outletId=queryValue(request,'outletId');
    if(outletId&&!context.outlets.some((outlet)=>outlet.id===outletId)){
      throw Object.assign(new Error('User tidak memiliki akses ke outlet laporan'),{status:403});
    }
    const outletIds=outletId?[outletId]:context.outlets.map((outlet)=>outlet.id);
    const earliest=await rest('sales',`tenant_id=eq.${context.tenantId}&outlet_id=${inFilter(outletIds)}&status=in.(COMPLETED,VOIDED)&select=occurred_at&order=occurred_at.asc&limit=1`);
    const firstYear=earliest[0]?Number(String(earliest[0].occurred_at).slice(0,4)):Number(today.slice(0,4));
    const currentYear=Number(today.slice(0,4));
    const years=await Promise.all(Array.from({length:Math.max(1,currentYear-firstYear+1)},(_,index)=>firstYear+index).map(async(year)=>{
      const from=`${year}-01-01`,to=year===currentYear?today:`${year}-12-31`;
      const report=await rpc('report_operational_summary',{
        p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_outlet_ids:outletIds,
        p_from:from,p_to:to,p_timezone:timezone
      });
      return{year,from,to,metrics:report.metrics};
    }));
    return send(response,200,{fromYear:firstYear,toYear:currentYear,years:years.reverse()});
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

  if(request.method==='POST'&&route==='accounting/sync'){
    requirePermission(session,'finance.owner');
    return send(response,200,await rpc('sync_accounting_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id
    }));
  }

  if(request.method==='GET'&&route==='accounting/dashboard'){
    requirePermission(session,'finance.owner');
    const timezone=context.outlet.timezone??'Asia/Makassar';
    const today=todayInTimeZone(new Date(),timezone);
    const from=queryValue(request,'from')??`${today.slice(0,4)}-01-01`;
    const to=queryValue(request,'to')??today;
    const accountId=queryValue(request,'accountId');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to){
      throw Object.assign(new Error('Periode akuntansi tidak valid'),{status:400});
    }
    if(accountId&&!/^[0-9a-f-]{36}$/i.test(accountId)){
      throw Object.assign(new Error('Akun buku besar tidak valid'),{status:400});
    }
    return send(response,200,await rpc('report_core_accounting_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_from:from,p_to:to,p_account_id:accountId||null
    }));
  }

  if(request.method==='POST'&&route==='accounting/journals'){
    requirePermission(session,'finance.owner');
    const input=bodyOf(request),lines=Array.isArray(input.lines)?input.lines:[];
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(input.entryDate??''))){
      throw Object.assign(new Error('Tanggal jurnal tidak valid'),{status:400});
    }
    if(String(input.description??'').trim().length<3||String(input.description??'').trim().length>240){
      throw Object.assign(new Error('Keterangan jurnal harus 3â€“240 karakter'),{status:400});
    }
    let validated;
    try{validated=validateJournalLines(lines);}catch(error){error.status=400;throw error;}
    const normalized=validated.lines.map((line)=>{
      if(!/^[0-9a-f-]{36}$/i.test(String(line.accountId??'')))throw Object.assign(new Error('Akun jurnal tidak valid'),{status:400});
      if(line.outletId&&!context.outlets.some((outlet)=>outlet.id===line.outletId)){
        throw Object.assign(new Error('Outlet jurnal tidak dapat diakses'),{status:403});
      }
      return{accountId:line.accountId,outletId:line.outletId||null,memo:String(line.memo??'').trim(),debit:line.debit,credit:line.credit};
    });
    return send(response,201,await rpc('post_manual_journal_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_entry_date:input.entryDate,
      p_description:String(input.description).trim(),p_lines:normalized
    }));
  }

  if(request.method==='POST'&&/^accounting\/journals\/[^/]+\/reverse$/.test(route)){
    requirePermission(session,'finance.owner');
    const input=bodyOf(request),entryId=route.split('/')[2];
    return send(response,200,await rpc('reverse_manual_journal_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_entry_id:entryId,
      p_reason:String(input.reason??'').trim()
    }));
  }

  if(request.method==='POST'&&route==='accounting/periods'){
    requirePermission(session,'finance.owner');
    const input=bodyOf(request);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(input.startsOn??''))||!/^\d{4}-\d{2}-\d{2}$/.test(String(input.endsOn??''))){
      throw Object.assign(new Error('Tanggal periode tidak valid'),{status:400});
    }
    return send(response,201,await rpc('save_accounting_period_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_name:String(input.name??'').trim(),
      p_starts_on:input.startsOn,p_ends_on:input.endsOn
    }));
  }

  if(request.method==='POST'&&/^accounting\/periods\/[^/]+\/close$/.test(route)){
    requirePermission(session,'finance.owner');
    return send(response,200,await rpc('close_accounting_period_v1',{
      p_tenant_id:context.tenantId,p_actor_id:session.authUser.id,p_period_id:route.split('/')[2]
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
