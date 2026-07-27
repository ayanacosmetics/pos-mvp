import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, app, css] = await Promise.all([
  readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
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

test('jumlah restok diisi dalam popup setelah barang ditekan', () => {
  for (const id of ['planning-item-dialog','planning-item-qty','save-planning-item','remove-planning-item']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /function openPlanningItem/);
  assert.match(app, /state\.restockSelection\.set\(productId,qty\)/);
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
  assert.match(app, /state\.restockSelection\.get\(item\.productId\)/);
  assert.match(app, /\[\.\.\.state\.restockSelection\.entries\(\)\]/);
  assert.match(app, /state\.restockSelection\.clear\(\)/);
});

test('satu tombol membuat pesanan supplier dan mengajukannya untuk diproses', () => {
  assert.match(html, /id="create-planning-draft"[\s\S]*Buat pesanan supplier/);
  assert.match(html, /id="planning-order-supplier"/);
  assert.match(app, /purchase-orders\/\$\{result\.id\}\/submit/);
  assert.match(app, /baseQty:item\.orderQty/);
  assert.match(app, /Pilih supplier tujuan pesanan/);
  assert.match(app, /supplierId,locationId/);
});

test('surat pesanan dapat dicetak atau dibagikan dan bukan bukti bayar', () => {
  for (const id of ['purchase-order-dialog','purchase-order-print-content','share-purchase-order','print-purchase-order']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /BUKAN BUKTI PEMBAYARAN/);
  assert.match(app, /navigator\.share/);
  assert.match(app, /navigator\.clipboard\.writeText/);
  assert.match(app, /class="button secondary po-print"/);
});

test('dokumen supplier memakai tata cetak A4 terpisah dari struk penjualan', () => {
  assert.match(css, /body\.printing-purchase-order>\*:not\(#purchase-order-dialog\)/);
  assert.match(css, /\.supplier-order-sheet/);
  assert.match(css, /@page\{size:A4 portrait/);
  assert.match(css, /body\.printing-purchase-order #receipt-dialog\{display:none!important\}/);
});
