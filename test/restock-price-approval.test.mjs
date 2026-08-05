import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html,app,api,sql,sqlPo,sqlPoNewProduct,sqlRevision,sqlDeliveryVariance,sqlReceivingLock,sqlOwnerSelfDecision,css]=await Promise.all([
  readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
  readFile(new URL('../api/index.mjs',import.meta.url),'utf8'),
  readFile(new URL('../supabase/migrations/202608030015_restock_price_approval.sql',import.meta.url),'utf8'),
  readFile(new URL('../supabase/migrations/202608030016_restock_approval_purchase_order.sql',import.meta.url),'utf8'),
  readFile(new URL('../supabase/migrations/202608040017_restock_po_approved_new_product.sql',import.meta.url),'utf8'),
  readFile(new URL('../supabase/migrations/202608040018_restock_revision_workflow.sql',import.meta.url),'utf8'),
  readFile(new URL('../supabase/migrations/202608050021_purchase_order_delivery_variance.sql',import.meta.url),'utf8'),
  readFile(new URL('../supabase/migrations/202608050022_purchase_order_receiving_lock.sql',import.meta.url),'utf8'),
  readFile(new URL('../supabase/migrations/202608050023_owner_self_restock_decision.sql',import.meta.url),'utf8'),
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

test('persetujuan Owner memakai daftar dan halaman detail dengan patokan harga lengkap',()=>{
  assert.match(app,/class="restock-approval-summary"/);
  assert.match(app,/class="restock-approval-detail-toolbar"/);
  assert.match(app,/Modal lama/);
  assert.match(app,/Modal baru/);
  assert.match(app,/Perubahan modal/);
  assert.match(app,/Saran harga jual baru/);
  assert.match(app,/price\.customerGroupId==='retail'\?'Harga jual'/);
  assert.match(app,/class="button secondary back-restock-approvals"/);
  assert.match(css,/\.restock-approval-status\{display:inline-flex!important/);
});

test('Owner dapat meminta revisi dan Staff mengirim ulang pengajuan yang sama',()=>{
  assert.match(sqlRevision,/REVISION_REQUIRED/);
  assert.match(sqlRevision,/revision_history_json/);
  assert.match(sqlRevision,/resubmit_restock_approval_v1/);
  assert.match(api,/approve\|reject\|revise/);
  assert.match(api,/resubmit_restock_approval_v1/);
  assert.match(app,/Minta revisi/);
  assert.match(app,/Kirim ulang ke Owner/);
  assert.match(app,/function resubmitRestockApproval/);
  assert.match(app,/Modal lama, perhitungan laba, dan saran harga hanya tampil pada akun Owner/);
  assert.match(css,/\.restock-revision-banner\{display:grid/);
});

test('Owner dapat memutuskan restok yang dibuat sendiri tanpa membuka hak Admin',()=>{
  assert.match(app,/!isRequester\|\|state\.session\.user\.role==='OWNER'/);
  assert.match(sqlOwnerSelfDecision,/v_request\.requester_id=p_actor_id and v_actor_role<>'OWNER'/);
  assert.match(sqlOwnerSelfDecision,/ownerSelfDecision/);
});

test('staff hanya melihat pemberitahuan approval tanpa modal lama dan saran harga',()=>{
  assert.match(app,/function canReviewRestockCostDetails/);
  assert.match(app,/function staffRestockApprovalNote/);
  assert.match(app,/querySelector\('\.cost-insight'\)\?\.replaceWith/);
  assert.match(app,/querySelector\('\.history-button'\)\?\.remove/);
  assert.match(app,/restock-staff-proposal-data/);
  assert.match(app,/canReviewRestockCostDetails\(\)\?`\$\{money\.format\(cost\)\} \/ \$\{restockSelectedUnit\(row\)\.name\}`:'Modal dicatat dari nota'/);
  assert.match(css,/\.restock-owner-approval-note\{display:flex/);
});

test('kelebihan kiriman PO hanya diterima melalui persetujuan Owner',()=>{
  assert.match(api,/submit_restock_approval_v2/);
  assert.match(app,/function restockPoQuantityVariance/);
  assert.match(app,/Lebih kirim/);
  assert.match(app,/SELISIH JUMLAH/);
  assert.match(sqlDeliveryVariance,/poVarianceType/);
  assert.match(sqlDeliveryVariance,/PURCHASE_ORDER_DELIVERY_VARIANCE_APPROVED/);
  assert.match(sqlDeliveryVariance,/overageItemCount/);
  assert.match(sqlDeliveryVariance,/is_supplement/);
  assert.match(sqlDeliveryVariance,/v_request\.status<>'APPROVED'/);
});

test('PO dikunci selama pengajuan penerimaan masih diproses',()=>{
  assert.match(api,/receiving_approval:approvalByOrder\.get\(order\.id\)/);
  assert.match(api,/PO sedang diproses dalam pengajuan penerimaan/);
  assert.match(api,/PO ini sudah memiliki pengajuan penerimaan yang masih diproses/);
  assert.match(app,/\['APPROVED','PARTIALLY_RECEIVED'\]\.includes\(order\.status\)&&!receivingApproval/);
  assert.match(app,/PENERIMAAN DIPROSES/);
  assert.match(app,/function openPurchaseOrderReceivingApproval/);
  assert.match(app,/if\(order\.receiving_approval\)return toast/);
  assert.match(css,/\.purchase-receiving-lock\{/);
  assert.match(sqlReceivingLock,/guard_active_purchase_order_receiving_v1/);
  assert.match(sqlReceivingLock,/PENDING','REVISION_REQUIRED','APPROVED/);
  assert.match(sqlReceivingLock,/for update/);
});
