import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPurchaseReceiptInspection, purchaseReceiptShortageMessage, reconcilePurchaseReceiptDraft } from '../apps/web/restock-inspection.mjs';

test('draft lama disaring terhadap sisa PO terbaru sebelum dilanjutkan',()=>{
  const result=reconcilePurchaseReceiptDraft({
    activePurchaseOrder:{id:'po-1',outstanding_qty:180},
    lines:[
      {productId:'done',poLine:true,qty:'3',verificationMethod:'manual',poRemainingBaseQty:'3'},
      {productId:'left',poLine:true,qty:'3',verificationMethod:'manual',poRemainingBaseQty:'6'}
    ]
  },{
    id:'po-1',outstanding_qty:84,items:[
      {product_id:'done',remaining_qty:0,purchase_unit_factor:1},
      {product_id:'left',remaining_qty:3,purchase_unit_factor:1,purchase_unit_name:'pcs'},
      {product_id:'missing',remaining_qty:6,purchase_unit_factor:1,purchase_unit_name:'pcs',unit_cost:10}
    ]
  });
  assert.equal(result.removedCount,1);
  assert.equal(result.addedCount,1);
  assert.equal(result.draft.lines.length,2);
  assert.equal(result.draft.activePurchaseOrder.outstanding_qty,84);
  assert.deepEqual(result.draft.lines.map((line)=>line.productId),['left','missing']);
});

test('jumlah draft yang melebihi sisa terbaru direset agar tidak diposting ulang',()=>{
  const result=reconcilePurchaseReceiptDraft({
    activePurchaseOrder:{id:'po-1',outstanding_qty:6},
    lines:[{productId:'a',poLine:true,qty:'6',verificationMethod:'scan',poRemainingBaseQty:'6'}]
  },{
    id:'po-1',outstanding_qty:3,
    items:[{product_id:'a',remaining_qty:3,purchase_unit_factor:1,purchase_unit_name:'pcs'}]
  });
  assert.equal(result.resetCount,1);
  assert.equal(result.draft.lines[0].qty,'');
  assert.equal(result.draft.lines[0].verificationMethod,'');
  assert.equal(result.draft.lines[0].poRemainingBaseQty,'3');
});

test('baris tambahan lama untuk produk PO yang sudah diterima penuh ikut dibuang',()=>{
  const result=reconcilePurchaseReceiptDraft({
    activePurchaseOrder:{id:'po-1',outstanding_qty:3},
    lines:[
      {productId:'done',poLine:false,qty:'3',verificationMethod:'manual'},
      {productId:null,productKey:'new-item',poLine:false,qty:'3',verificationMethod:'manual'},
      {productId:'left',poLine:true,qty:'3',verificationMethod:'scan',poRemainingBaseQty:'3'}
    ]
  },{
    id:'po-1',outstanding_qty:3,items:[
      {product_id:'done',remaining_qty:0,purchase_unit_factor:1},
      {product_id:'left',remaining_qty:3,purchase_unit_factor:1,purchase_unit_name:'pcs'}
    ]
  });
  assert.equal(result.removedCount,1);
  assert.deepEqual(result.draft.lines.map((line)=>line.productId??line.productKey),['new-item','left']);
  assert.equal(result.draft.lines.find((line)=>line.productKey==='new-item').poLine,false);
});

test('baris tambahan lama untuk produk yang masih tersisa dinormalkan menjadi baris PO',()=>{
  const result=reconcilePurchaseReceiptDraft({
    activePurchaseOrder:{id:'po-1',outstanding_qty:3},
    lines:[{productId:'left',poLine:false,qty:'3',verificationMethod:'manual'}]
  },{
    id:'po-1',outstanding_qty:3,
    items:[{product_id:'left',remaining_qty:3,purchase_unit_factor:1,purchase_unit_name:'pcs'}]
  });
  assert.equal(result.removedCount,0);
  assert.equal(result.draft.lines.length,1);
  assert.equal(result.draft.lines[0].poLine,true);
  assert.equal(result.draft.lines[0].poRemainingBaseQty,'3');
});

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
  assert.match(api,/submit_restock_approval_v4/);
  assert.match(api,/receive_purchase_order_draft_v2/);
  assert.match(api,/receive_purchase_order_draft_v2'[\s\S]{0,350}p_inspection:input\.inspection/);
  assert.match(api,/receive_approved_restock_v3/);
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

test('pengaman lanjutan menolak draft lama dan barang PO yang sudah diterima penuh',async()=>{
  const [app,api,sql]=await Promise.all([
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
    readFile(new URL('../api/index.mjs',import.meta.url),'utf8'),
    readFile(new URL('../supabase/migrations/202608120001_reconcile_receipt_draft_with_current_po.sql',import.meta.url),'utf8')
  ]);
  assert.match(app,/reconcilePurchaseReceiptDraft\(claimed\.payload\?\?draft,order\)/);
  assert.match(api,/submit_restock_approval_v4/);
  assert.match(api,/receive_purchase_order_draft_v2/);
  assert.match(api,/receive_approved_restock_v3/);
  assert.match(sql,/Ringkasan pemeriksaan memakai sisa PO lama/);
  assert.match(sql,/Barang ini sudah diterima penuh dan tidak boleh dimasukkan kembali/);
  assert.doesNotMatch(sql,/update\s+public\.stock_balances/i);
  assert.doesNotMatch(sql,/update\s+public\.purchase_receipt_items/i);
});
