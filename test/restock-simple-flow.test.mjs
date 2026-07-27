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
  assert.match(app, /class="planning-order-qty"/);
  assert.match(app, /orderQty:Number\(row\.querySelector\('\.planning-order-qty'\)\.value\)/);
});

test('barang dapat dipilih langsung tanpa aturan supplier per produk', () => {
  assert.match(app, /class="planning-select" type="checkbox" aria-label="Pilih/);
  assert.doesNotMatch(app, /class="planning-select"[^>]*disabled/);
  assert.match(app, /Supplier dipilih saat membuat pesanan/);
  assert.match(app, /class="planning-order-qty"[^>]*value="\$\{orderQty\}"/);
  assert.doesNotMatch(app, /class="planning-order-qty"[^>]*disabled/);
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
