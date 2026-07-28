import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, app, api, css] = await Promise.all([
  readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/index.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8'),
]);

test('analitik memisahkan laporan penjualan dan pembelian', () => {
  assert.match(html, /data-report-view="sales"[\s\S]*Laporan penjualan/);
  assert.match(html, /data-report-view="purchases"[\s\S]*Laporan pembelian/);
  assert.match(html, /id="report-purchase-workspace"/);
  assert.match(html, /id="purchase-report-list"/);
});

test('klik penjualan membuka struk pelanggan asli', () => {
  assert.match(app, /state\.reportView==='sales'&&sale/);
  assert.match(app, /renderReceipt\(sale,sale\.payments\|\|\[\]\)/);
});

test('laporan pembelian memakai data penerimaan tersimpan dan membuka dokumen asli', () => {
  assert.match(api, /route==='purchase-receipts\/report'/);
  assert.match(api, /rest\('purchase_receipts'/);
  assert.match(api, /rest\('purchase_receipt_items'/);
  assert.match(app, /function openPurchaseReportReceipt\(receipt\)/);
  assert.match(app, /STRUK PEMBELIAN/);
  assert.match(app, /data-purchase-report-id/);
  assert.match(html, /id="purchase-report-dialog"/);
  assert.match(css, /\.purchase-original-document/);
  assert.match(css, /body\.purchase-report-print/);
});
