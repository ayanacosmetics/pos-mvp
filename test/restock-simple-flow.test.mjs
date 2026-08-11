import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, app, api, css] = await Promise.all([
  readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/index.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8')
]);

test('sidebar mempunyai satu lipatan Restok dengan empat tujuan kerja', () => {
  assert.equal((html.match(/data-nav-group="restock"/g) ?? []).length, 1);
  assert.equal((html.match(/data-nav-panel="restock"/g) ?? []).length, 1);
  for (const label of ['Pilih barang','Pesanan supplier','Terima barang','Retur supplier']) {
    assert.match(html, new RegExp(`<span>${label}</span>`));
  }
  const inventoryPanel = html.match(/data-nav-panel="inventory"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.doesNotMatch(inventoryPanel, /purchase-|restock-planning|supplier-return/);
});

test('pilihan barang menampilkan seluruh produk dari stok paling sedikit', () => {
  assert.doesNotMatch(html, /id="planning-needed-only"[^>]*checked/);
  assert.match(app, /\.sort\(\(a,b\) => Number\(a\.stock\) - Number\(b\.stock\)/);
  assert.match(html, /Stok paling sedikit dahulu/);
  assert.match(app, /class="planning-compact-row/);
  assert.match(app, /<small>Harga jual<\/small>/);
  assert.match(app, /<small>Stok<\/small>/);
});

test('jumlah dan satuan restok diisi dalam popup setelah barang ditekan', () => {
  for (const id of ['planning-item-dialog','planning-item-unit','planning-item-qty','planning-item-conversion','save-planning-item','remove-planning-item']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /function openPlanningItem/);
  assert.match(app, /function planningPurchaseUnits/);
  assert.match(app, /state\.restockSelection\.set\(productId,\{qty,unitId:/);
  assert.match(app, /state\.restockSelection\.delete/);
  assert.doesNotMatch(app, /class="planning-select" type="checkbox"/);
});

test('daftar besar mempunyai pencarian dan dimuat bertahap', () => {
  assert.match(html, /id="planning-product-search"/);
  assert.match(app, /state\.restockPlanningLimit = 100/);
  assert.match(app, /list\.slice\(0,state\.restockPlanningLimit\)/);
  assert.match(app, /state\.restockPlanningLimit\+=100/);
  assert.match(app, /item\.productName} \$\{item\.sku}/);
});

test('pilihan tersimpan ketika daftar dirender ulang', () => {
  assert.match(app, /state\.restockSelection = new Map\(\)/);
  assert.match(app, /function planningSelectionOf/);
  assert.match(app, /\[\.\.\.state\.restockSelection\.keys\(\)\]/);
  assert.match(app, /state\.restockSelection\.clear\(\)/);
});

test('satu tombol membuat pesanan supplier dan mengajukannya untuk diproses', () => {
  assert.match(html, /id="create-planning-draft"[\s\S]*Buat pesanan/);
  assert.match(html, /id="planning-order-supplier"/);
  assert.match(app, /purchase-orders\/\$\{result\.id\}\/submit/);
  assert.match(app, /baseQty:item\.qty\*item\.factor/);
  assert.match(app, /purchaseUnitId:item\.unitId/);
  assert.match(app, /purchaseUnitCost:Number\(item\.estimatedCost\?\?0\)\*item\.factor/);
  assert.match(api, /purchaseUnitFactor:Number\(item\.purchaseUnitFactor\?\?1\)/);
  assert.match(app, /Pilih supplier tujuan pesanan/);
  assert.match(app, /supplierId,locationId/);
});

test('halaman pilih barang padat dan responsif pada laptop tablet serta mobile',()=>{
  assert.match(app,/classList\.toggle\('purchase-planning-active',name==='planning'\)/);
  assert.match(html,/class="button secondary planning-refresh-icon"[\s\S]*aria-label="Muat ulang rekomendasi restok"/);
  assert.match(app,/class="planning-mobile-stock"/);
  assert.match(css,/\.purchase-planning-active \.content-width\{display:flex;height:calc\(100dvh - 62px\)/);
  assert.match(css,/#purchase-view-planning #restock-planning-list\{[^}]*max-height:none;flex:1;overflow-y:auto/);
  assert.match(css,/#purchase-view-planning \.planning-compact-row\{grid-template-columns:42px[^}]*min-height:56px/);
  assert.match(css,/@media\(max-width:1000px\) and \(min-width:701px\)/);
  assert.match(css,/@media\(max-width:700px\)[\s\S]*grid-template-areas:"thumb product choice arrow"/);
  assert.match(css,/#planning-item-dialog \.planning-item-order-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test('kontrol pesanan berada di atas daftar dan hanya daftar barang yang menggulir', () => {
  assert.ok(html.indexOf('class="planning-draft-actions"') < html.indexOf('id="restock-planning-list"'));
  assert.match(css, /#page-restock #restock-planning-list\{[^}]*max-height:calc\(100dvh - 405px\)[^}]*overflow-y:auto/);
  assert.match(css, /#page-restock \.planning-draft-actions\{[^}]*z-index:3/);
  assert.match(css, /@media\(max-width:700px\)[\s\S]*#page-restock \.planning-draft-actions\{grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(css, /#page-restock \.planning-compact-row\{grid-template-columns:50px minmax\(0,1fr\) 14px;grid-template-areas:"thumb product arrow" "thumb choice arrow"/);
  assert.match(css, /#page-restock \.planning-compact-product strong\{[^}]*-webkit-line-clamp:2[^}]*white-space:normal/);
  assert.match(css, /#page-restock #restock-planning-list\{[^}]*scroll-padding-bottom/);
});

test('surat pesanan dapat dicetak atau dibagikan sebagai PDF ke supplier', () => {
  for (const id of ['purchase-order-dialog','purchase-order-print-content','purchase-order-print-root','whatsapp-purchase-order','share-purchase-order','print-purchase-order']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /BUKAN BUKTI PEMBAYARAN/);
  assert.match(app, /function purchaseOrderPdfBlob/);
  assert.match(app, /navigator\.canShare\?\.\(\{files:\[file\]\}\)/);
  assert.match(app, /files:\[file\]/);
  assert.match(app, /https:\/\/wa\.me\/\$\{phone\}/);
  assert.match(app, /Nomor WhatsApp supplier belum diisi/);
  assert.match(app, /class="button secondary purchase-order-icon-action po-print"/);
  assert.match(app, /class="button secondary purchase-order-icon-action po-whatsapp"/);
  assert.match(app, /Tambahan barang baru yang belum tercatat di Nusa/);
  assert.match(app, /function openPurchaseOrderWhatsApp/);
});

test('dokumen supplier memakai tata cetak A4 terpisah dari struk penjualan', () => {
  assert.match(css, /body\.printing-purchase-order>\*:not\(#purchase-order-print-root\)/);
  assert.match(css, /body\.printing-purchase-order #purchase-order-print-root\{display:block!important/);
  assert.match(css, /\.supplier-order-sheet/);
  assert.match(css, /@page\{size:A4 portrait/);
  assert.match(app, /requestAnimationFrame\(\(\)=>requestAnimationFrame\(\(\)=>window\.print\(\)\)\)/);
  assert.match(app, /window\.addEventListener\('afterprint',cleanup/);
});

test('daftar PO ringkas membuka halaman detail penuh yang aman', () => {
  for (const id of ['purchase-view-detail','back-purchase-order-detail','purchase-order-detail-content']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /class="purchase-document purchase-document-open"/);
  assert.match(app, /function openPurchaseOrderDetail/);
  assert.match(app, /role="button" tabindex="0"/);
  assert.match(app, /purchase-order-detail-line/);
  assert.match(app, /function purchaseOrderDetailActions/);
  assert.match(app,/purchase-order-icon-action po-print[\s\S]*aria-label="Cetak atau bagikan PO"/);
  assert.match(app,/purchase-order-icon-action po-whatsapp[\s\S]*aria-label="Kirim PO ke WhatsApp supplier"/);
  assert.match(app,/purchase-order-utility-actions[\s\S]*purchase-order-workflow-actions/);
  assert.match(app,/purchase-order-utility-actions[\s\S]*purchaseOrderDetailTotals\(order\)[\s\S]*purchase-order-workflow-actions/);
  assert.match(app,/const receiveLabel=order\.status==='PARTIALLY_RECEIVED'\?`Terima sisa \$\{Number\(order\.outstanding_qty\)[\s\S]*:'Terima barang'/);
  assert.match(app,/data-action="cancel">Batalkan PO<\/button>`:''[\s\S]*po-receive[\s\S]*\$\{receiveLabel\}/);
  assert.match(css, /\.purchase-metrics\{\s*grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(css, /\.purchase-order-detail-page/);
  assert.match(html,/purchase-refresh-icon[\s\S]*aria-label="Muat ulang pesanan supplier"/);
  assert.match(app,/purchase-documents-active[\s\S]*purchase-detail-active/);
  assert.match(css,/#purchase-order-list\{display:grid;min-height:0[\s\S]*?flex:1[\s\S]*?overflow-y:auto/);
  assert.match(css,/#purchase-order-detail-content\{display:flex;min-height:0;flex:1/);
  assert.match(css,/\.purchase-order-detail-lines\{display:grid;min-height:100px[\s\S]*?flex:1[\s\S]*?overflow-y:auto/);
  assert.match(css,/#purchase-view-documents \.purchase-metrics \.metric:last-child\{grid-column:auto\}/);
  assert.match(css,/#purchase-order-list>\.purchase-document\{border:1px solid/);
  assert.match(css,/\.purchase-order-detail-lines>\.purchase-order-detail-line\{padding:10px 11px;border:1px solid/);
  assert.match(css, /#purchase-view-documents \.purchase-metrics\{\s*display:grid;\s*grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(css, /#purchase-view-documents \.purchase-metrics \.metric:last-child\{\s*grid-column:1\/-1/);
  assert.match(css,/#purchase-order-list\{[^}]*background:#f1f3f3\}/);
  assert.match(css,/\.purchase-order-detail-lines>\.purchase-order-detail-line\{[^}]*border-left:4px solid #aab4b4/);
  assert.match(html,/purchase-order-detail-title-row[\s\S]*purchase-order-detail-title[\s\S]*purchase-order-detail-status/);
  assert.match(css,/\.purchase-order-detail-summary\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)\}/);
  assert.match(css,/\.purchase-order-detail-lines>\.purchase-order-detail-line\{grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(css,/\.purchase-order-detail-totals\{display:grid;grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(css,/\.purchase-order-detail-actions\{position:static;grid-template-columns:auto minmax\(0,1fr\)/);
  assert.match(css,/\.purchase-order-detail-actions\{grid-template-columns:auto minmax\(330px,1fr\) auto/);
  assert.match(css,/grid-template-areas:"totals totals" "utility workflow"/);
});
