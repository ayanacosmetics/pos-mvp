import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPurchaseReceiptInspection, purchaseReceiptShortageMessage } from '../apps/web/restock-inspection.mjs';

test('ringkasan pemeriksaan membedakan stok masuk dan jumlah PO yang belum datang',()=>{
  const inspection=buildPurchaseReceiptInspection({
    purchaseOrderId:'po-1',documentNo:'INV-1',
    orderItems:[
      {product_id:'a',remaining_qty:100},
      {product_id:'b',remaining_qty:136}
    ],
    lines:[
      {productId:'a',productKey:'a',poLine:true,verificationMethod:'scan',purchaseQty:100,purchaseUnitFactor:1},
      {productId:'b',productKey:'b',poLine:true,verificationMethod:'manual',purchaseQty:52,purchaseUnitFactor:1}
    ],inspectedAt:'2026-08-11T00:00:00.000Z'
  });
  assert.equal(inspection.summary.orderedRemainingBaseQty,236);
  assert.equal(inspection.summary.actualReceivedBaseQty,152);
  assert.equal(inspection.summary.notReceivedBaseQty,84);
  assert.equal(inspection.summary.completion,'PARTIAL');
  assert.match(purchaseReceiptShortageMessage(inspection.summary),/belum datang 84 pcs/);
});

test('kelebihan barang lain tidak menutupi kekurangan satu produk PO',()=>{
  const inspection=buildPurchaseReceiptInspection({
    orderItems:[{product_id:'a',remaining_qty:10},{product_id:'b',remaining_qty:10}],
    lines:[
      {productId:'a',productKey:'a',poLine:true,verificationMethod:'scan',baseQty:15},
      {productId:'b',productKey:'b',poLine:true,verificationMethod:'scan',baseQty:5}
    ]
  });
  assert.equal(inspection.summary.actualReceivedBaseQty,20);
  assert.equal(inspection.summary.excessBaseQty,5);
  assert.equal(inspection.summary.notReceivedBaseQty,5);
});

test('approval menyimpan seluruh pemeriksaan dan penerimaan memakai kunci server yang stabil',async()=>{
  const [app,api,sql]=await Promise.all([
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
    readFile(new URL('../api/index.mjs',import.meta.url),'utf8'),
    readFile(new URL('../supabase/migrations/202608110001_safe_purchase_receipt_continuation.sql',import.meta.url),'utf8')
  ]);
  assert.match(app,/buildRestockApprovalInspection\(rows\)/);
  assert.match(app,/items:rows\.map[\s\S]{0,220}proposedPrices,inspection/);
  assert.match(app,/purchaseReceiptShortageMessage\(inspection\.summary\)/);
  assert.match(app,/items: lines,[\s\S]{0,80}inspection,[\s\S]{0,100}draftToken/);
  assert.match(app,/order\.items\.filter\(\(line\)=>line\.remaining_qty>0\)/);
  assert.match(app,/Terima sisa \$\{Number\(order\.outstanding_qty\)/);
  assert.match(api,/submit_restock_approval_v3/);
  assert.match(api,/receive_purchase_order_draft_v1/);
  assert.match(api,/receive_purchase_order_draft_v1'[\s\S]{0,350}p_inspection:input\.inspection/);
  assert.match(api,/receive_approved_restock_v2/);
  assert.match(sql,/inspection_json jsonb not null default '\{\}'::jsonb/);
  assert.match(sql,/PURCHASE_RECEIPT_INSPECTION_ARCHIVED/);
  assert.match(sql,/delete from public\.purchase_receipt_drafts where id=v_draft\.id/);
  assert.match(sql,/'PO-RECEIPT-DRAFT:'\|\|v_draft\.id::text/);
  assert.match(sql,/'RESTOCK-APPROVAL:'\|\|p_request_id::text/);
  assert.match(sql,/Setiap barang sisa PO harus memiliki tepat satu hasil pemeriksaan/);
});

test('migrasi pengaman tidak mengubah data stok atau penerimaan lama',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/202608110001_safe_purchase_receipt_continuation.sql',import.meta.url),'utf8');
  assert.doesNotMatch(sql,/update\s+public\.stock_balances/i);
  assert.doesNotMatch(sql,/update\s+public\.purchase_receipt_items/i);
  assert.doesNotMatch(sql,/delete\s+from\s+public\.purchase_receipts/i);
  assert.doesNotMatch(sql,/delete\s+from\s+public\.stock_ledger/i);
});
