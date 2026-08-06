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
  assert.match(html, /id="create-planning-draft"[\s\S]*Buat pesanan supplier/);
  assert.match(html, /id="planning-order-supplier"/);
  assert.match(app, /purchase-orders\/\$\{result\.id\}\/submit/);
  assert.match(app, /baseQty:item\.qty\*item\.factor/);
  assert.match(app, /purchaseUnitId:item\.unitId/);
  assert.match(app, /purchaseUnitCost:Number\(item\.estimatedCost\?\?0\)\*item\.factor/);
  assert.match(api, /purchaseUnitFactor:Number\(item\.purchaseUnitFactor\?\?1\)/);
  assert.match(app, /Pilih supplier tujuan pesanan/);
  assert.match(app, /supplierId,locationId/);
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
  assert.match(app, /class="button secondary po-print"/);
  assert.match(app, /class="button secondary po-whatsapp"/);
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
