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
  assert.match(api,/purchase_order_id=\$\{inFilter\(orders\.map\(\(order\)=>order\.id\)\)\}/);
});

test('draft lokal lama otomatis dipindahkan menjadi draft bersama',async()=>{
  const app=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
  assert.match(app,/migrateLocalRestockDraftToShared/);
  assert.match(app,/receipt-draft\/claim[\s\S]*release:true/);
  assert.match(app,/if\(await migrateLocalRestockDraftToShared\(\)\)[\s\S]*request\('\/api\/purchase-orders'\)/);
});
