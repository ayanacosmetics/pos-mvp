import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [migration,api,app,html]=await Promise.all([
  readFile(new URL('../supabase/migrations/202608120002_close_partial_purchase_order.sql',import.meta.url),'utf8'),
  readFile(new URL('../api/index.mjs',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/index.html',import.meta.url),'utf8')
]);

test('Owner dapat menutup sisa PO tanpa mengubah stok atau jumlah diterima',()=>{
  assert.match(migration,/CLOSED_PARTIAL/);
  assert.match(migration,/v_order\.status<>'PARTIALLY_RECEIVED'/);
  assert.match(migration,/coalesce\(v_role,''\) not in\('OWNER','ADMIN'\)/);
  assert.match(migration,/item->>'purchaseOrderId'=p_order_id::text/);
  assert.match(migration,/status='CLOSED_PARTIAL'/);
  assert.doesNotMatch(migration,/update public\.purchase_order_items set/);
  assert.doesNotMatch(migration,/insert into public\.stock_movements/);
  assert.doesNotMatch(migration,/insert into public\.purchase_receipt_items/);
  assert.match(migration,/'stockChanged',false/);
  assert.match(migration,/PURCHASE_ORDER_REMAINDER_CLOSED/);
});

test('API dan detail PO menjelaskan penutupan sisa secara audit-safe',()=>{
  assert.match(api,/close-remainder/);
  assert.match(api,/close_purchase_order_remainder_v1/);
  assert.match(app,/CLOSED_PARTIAL: \['Ditutup sebagian'/);
  assert.match(app,/class="button danger po-close-remainder"/);
  assert.match(app,/Stok tidak akan bertambah atau berkurang/);
  assert.match(app,/Jumlah diterima PO tidak akan dipalsukan menjadi 100%/);
  assert.match(app,/PURCHASE_ORDER_REMAINDER_CLOSED|SISA DITUTUP/);
  assert.match(app,/\['RECEIVED','CLOSED_PARTIAL','CANCELLED','PARTIALLY_RECEIVED'\]/);
  assert.match(app,/!\['APPROVED','PARTIALLY_RECEIVED'\]\.includes\(currentOrder\.status\)/);
  assert.match(app,/removeRestockDraft\(localStorage,currentRestockDraftKey\(\)\)/);
  assert.match(html,/option value="CLOSED_PARTIAL">Ditutup sebagian/);
});
