import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html,app,api,sql,sqlPo,sqlPoNewProduct,css]=await Promise.all([
  readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
  readFile(new URL('../api/index.mjs',import.meta.url),'utf8'),
  readFile(new URL('../supabase/migrations/202608030015_restock_price_approval.sql',import.meta.url),'utf8'),
  readFile(new URL('../supabase/migrations/202608030016_restock_approval_purchase_order.sql',import.meta.url),'utf8'),
  readFile(new URL('../supabase/migrations/202608040017_restock_po_approved_new_product.sql',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/styles.css',import.meta.url),'utf8')
]);

test('barang baru dapat dimulai tanpa scan dan tetap berupa draft',()=>{
  assert.match(html,/id="open-restock-new-product"/);
  assert.match(html,/Belum masuk katalog atau stok sampai Owner menyetujui/);
  assert.match(app,/state\.restockDraftProducts=new Map/);
  assert.match(app,/appendRestockNewLine\(productKey,payload\)/);
  assert.doesNotMatch(app,/saveRestockNewProduct[\s\S]{0,1800}request\('\/api\/products'/);
});

test('barang baru mendukung barcode internal, multi satuan, dan tipe harga',()=>{
  assert.match(html,/value="INTERNAL">Buat barcode internal/);
  assert.match(html,/id="add-restock-new-unit"/);
  assert.match(html,/id="restock-new-prices"/);
  assert.match(app,/function generateInternalBarcode/);
  assert.match(app,/function renderRestockNewUnits/);
  assert.match(app,/function renderRestockNewPrices/);
});

test('modal dibandingkan dengan pembelian terakhir lintas supplier',()=>{
  const route=api.slice(api.indexOf("route === 'cost-comparison'"),api.indexOf("route.startsWith('supplier-comparison/')"));
  assert.doesNotMatch(route,/supplierFilter/);
  assert.match(route,/order=received_at\.desc/);
  assert.match(api,/function restockNeedsPriceApproval/);
});

test('persetujuan dan penerimaan diposting atomik',()=>{
  assert.match(sql,/create table if not exists public\.restock_approval_requests/);
  assert.match(sql,/submit_restock_approval_v1/);
  assert.match(sql,/decide_restock_approval_v1/);
  assert.match(sql,/receive_approved_restock_v1/);
  assert.match(sql,/v_result:=public\.save_product_v6/);
  assert.match(sql,/v_result:=public\.receive_purchase/);
  assert.match(api,/route === 'restock-approvals'/);
  assert.match(app,/function renderRestockApprovals/);
  assert.match(app,/purchaseOrderId=state\.activePurchaseOrder\?\.id/);
  assert.match(sqlPo,/v_result:=public\.receive_purchase_order/);
  assert.match(sqlPo,/profile_can_receive_purchase_v1/);
  assert.match(sqlPo,/'purchasing\.receive'=any\(coalesce\(custom_permissions/);
  assert.match(sqlPoNewProduct,/PURCHASE_ORDER_SUPPLEMENT_APPROVED/);
  assert.match(sqlPoNewProduct,/insert into purchase_order_items/);
  assert.match(sqlPoNewProduct,/grand_total=greatest/);
  assert.doesNotMatch(sqlPoNewProduct,/Barang baru tidak dapat ditambahkan/);
});

test('form restok padat dan bagian opsional dapat dilipat',()=>{
  assert.match(html,/class="restock-optional-section"/);
  assert.match(app,/class="restock-line-options"/);
  assert.match(css,/Compact restock proposal and approval flow/);
  assert.match(css,/\.restock-card-grid\{grid-template-columns:repeat\(4/);
});

test('mobile restok memadatkan harga dan mengganti input readonly menjadi ringkasan',()=>{
  assert.match(app,/function restockApprovalPriceMarkup/);
  assert.match(app,/class="approval-price-readonly"/);
  assert.match(css,/Dense mobile restock/);
  assert.match(css,/@media\(max-width:650px\)[\s\S]*\.restock-approval-price-grid\{grid-template-columns:repeat\(2/);
  assert.match(css,/\.restock-wizard-step small\{display:none\}/);
  assert.match(css,/\.restock-card-grid>label:nth-child\(3\)/);
});
