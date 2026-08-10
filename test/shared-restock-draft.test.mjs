import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('draft penerimaan PO dibagikan dan dikunci atomik di database', async()=>{
  const [sql,api]=await Promise.all([
    readFile(new URL('../supabase/migrations/202608100004_shared_purchase_receipt_drafts.sql',import.meta.url),'utf8'),
    readFile(new URL('../api/index.mjs',import.meta.url),'utf8')
  ]);
  assert.match(sql,/create table if not exists public\.purchase_receipt_drafts/);
  assert.match(sql,/unique\(tenant_id,purchase_order_id\)/);
  assert.match(sql,/claim_purchase_receipt_draft_v1[\s\S]*for update/);
  assert.match(sql,/claim_expires_at>now\(\)[\s\S]*Pemeriksaan sedang dikerjakan/);
  assert.match(sql,/save_purchase_receipt_draft_v1[\s\S]*p_release boolean/);
  assert.match(sql,/validate_purchase_receipt_draft_lock_v1/);
  assert.match(api,/claim_purchase_receipt_draft_v1/);
  assert.match(api,/validate_purchase_receipt_draft_lock_v1[\s\S]*receive_purchase_order/);
  assert.match(api,/purchase_receipt_drafts[\s\S]*method:'DELETE'/);
  assert.match(api,/const ordersPromise=loadPurchaseOrders\(context\.tenantId,null,context\.locationIds\)/);
  assert.match(api,/draftLocationFilter=context\.locationIds\.length/);
  assert.match(api,/Promise\.all\(\[ordersPromise,actorsPromise\]\)/);
  assert.match(api,/const draftByOrder=new Map/);
});

test('draft lokal lama otomatis dipindahkan menjadi draft bersama',async()=>{
  const app=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
  assert.match(app,/migrateLocalRestockDraftToShared/);
  assert.match(app,/receipt-draft\/claim[\s\S]*release:true/);
  assert.match(app,/if\(await migrateLocalRestockDraftToShared\(\)\)[\s\S]*request\('\/api\/purchase-orders'\)/);
  assert.match(app,/localIsRicher=localInspected>sharedInspected/);
  assert.match(app,/activePurchaseOrder\?\.id===orderId&&state\.restockDraftLeaseToken\)return false/);
});

test('menu pesanan supplier melakukan prefetch, deduplikasi, dan render awal tanpa menunggu migrasi',async()=>{
  const [app,api]=await Promise.all([
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
    readFile(new URL('../api/index.mjs',import.meta.url),'utf8')
  ]);
  assert.match(app,/let purchaseOrdersLoadPromise = null/);
  assert.match(app,/can\('purchasing\.view_cost'\)\|\|can\('purchasing\.receive'\)[\s\S]{0,80}\[loadPurchaseOrders\]/);
  assert.match(app,/if\(purchaseOrdersLoadPromise\)return purchaseOrdersLoadPromise/);
  assert.match(app,/state\.purchaseOrders=data\.orders;[\s\S]{0,180}renderPurchaseOrders\(\);[\s\S]{0,180}if\(await migrateLocalRestockDraftToShared\(\)\)/);
  assert.match(api,/const itemsByOrder=new Map\(\)/);
  assert.match(api,/const \[orders,actors\]=await Promise\.all\(\[ordersPromise,actorsPromise\]\)/);
});

test('akun staff yang sama dapat memindahkan pemeriksaan ke perangkat lain dengan aman',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/202608100005_same_staff_receipt_device_handoff.sql',import.meta.url),'utf8');
  assert.match(sql,/v_draft\.claimed_by is distinct from p_actor_id then/);
  assert.doesNotMatch(sql,/v_draft\.claimed_by is distinct from p_actor_id or v_draft\.claim_token is distinct from p_client_token/);
  assert.match(sql,/claim_token=p_client_token/);
  assert.match(sql,/Pemeriksaan telah dipindahkan ke perangkat lain/);
});
