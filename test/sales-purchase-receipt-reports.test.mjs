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
  assert.match(html, /data-report-view="sales-history"[\s\S]*Riwayat penjualan/);
  assert.match(html, /data-report-view="purchases"[\s\S]*Laporan pembelian/);
  assert.match(html, /data-report-view="purchases-history"[\s\S]*Riwayat pembelian/);
  assert.match(html, /id="report-purchase-workspace"/);
  assert.match(html, /id="purchase-report-list"/);
  assert.match(html, /id="pos-history-detail" class="pos-history-detail hidden"/);
  assert.match(html, /id="report-filter-panel" class="report-filter-panel"/);
  assert.match(html, /id="report-filter-summary"/);
  assert.match(css, /\.report-sales-layout\{display:block;min-height:0\}/);
  assert.match(css, /#page-reports \.page-title h1\{margin:0;font-size:25px/);
  assert.match(css, /\.report-filter-panel>summary\{display:flex/);
  assert.match(app, /el\('report-filter-panel'\)\.open=false/);
  assert.match(app, /daily\?\.classList\.toggle\('hidden',!\['summary','sales'\]\.includes\(name\)\)/);
  assert.match(app, /sales\.classList\.toggle\('hidden',name!=='sales-history'\)/);
  assert.match(app, /purchases\?\.classList\.toggle\('hidden',name!=='purchases'\)/);
  assert.match(app, /purchaseWorkspace\.classList\.toggle\('hidden',name!=='purchases-history'\)/);
});

test('klik penjualan membuka struk pelanggan asli', () => {
  assert.match(app, /state\.reportView==='sales-history'&&sale/);
  assert.match(app, /openHistoryReceiptPage\(sale\)/);
  assert.match(html, /id="report-sale-receipt-page"/);
  assert.match(html, /id="back-history-receipt"/);
  for (const action of ['details','print','share','return','void','edit','delete']) {
    assert.match(html, new RegExp(`data-history-receipt-action="${action}"`));
  }
  assert.match(app, /Transaksi selesai tidak dapat diedit langsung/);
  assert.match(app, /Transaksi selesai tidak boleh dihapus permanen/);
  assert.match(css, /#page-reports\.receipt-page-open/);
  assert.match(css, /\.history-receipt-paper/);
  assert.match(app, /if\(allowAutoPrint&&state\.deviceSettings\.autoPrint\)/);
  assert.match(css, /html:has\(dialog\[open\]\),body:has\(dialog\[open\]\)\{overflow:hidden\}/);
  assert.match(css, /#receipt-dialog \.receipt-dialog\{[^}]*overflow-y:auto[^}]*background:#fff/);
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
