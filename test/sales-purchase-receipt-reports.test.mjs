import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, app, api, css] = await Promise.all([
  readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/index.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8'),
]);

test('laporan penjualan menyatukan ringkasan keuntungan dan riwayat struk', () => {
  assert.match(html, /data-report-view="sales"[\s\S]*<span>Penjualan<\/span>/);
  assert.doesNotMatch(html, /data-report-view="sales-history"/);
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
  assert.match(app, /daily\?\.classList\.toggle\('hidden',name!=='summary'\)/);
  assert.match(app, /sales\.classList\.add\('hidden'\)/);
  assert.match(app, /purchases\?\.classList\.toggle\('hidden',name!=='purchases'\)/);
  assert.match(app, /purchaseWorkspace\.classList\.toggle\('hidden',name!=='purchases-history'\)/);
  for(const period of ['DAY','MONTH','YEAR','ALL'])assert.match(html,new RegExp(`data-sales-period="${period}"`));
  assert.match(html,/id="sales-report-detail-toolbar"/);
  assert.match(html,/id="close-sales-report-detail"/);
  assert.match(html,/id="sales-metric-value"/);
  assert.match(html,/id="sales-period-breakdown"/);
  assert.match(app,/function selectSalesPeriod\(level,value=null,\{drill=false,back=false\}=\{\}\)/);
  assert.match(app,/state\.salesReportOpen = false/);
  assert.match(app,/function syncSalesReportShell\(\)/);
  assert.match(app,/function renderSelectedSalesMetric\(\)/);
  for(const metric of ['transactions','revenue','profit','returns'])assert.match(app,new RegExp(`data-sales-metric="\\$\\{key\\}"`));
  assert.match(app,/\['transactions','Jumlah transaksi','receipt'\]/);
  assert.match(app,/\['returns','Retur pelanggan','return'\]/);
  assert.match(app,/PENJUALAN PER BULAN/);
  assert.match(app,/TRANSAKSI PER HARI/);
  assert.match(app,/data-sales-drill-level/);
  assert.match(app,/data-sales-period-back/);
  assert.match(api,/route==='reports\/sales-years'/);
  assert.match(css,/#page-reports #report-cards:has\(\.sales-metric-button\)/);
  assert.match(css,/\.sales-metric-value\{/);
  assert.match(css,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(app,/Nomor struk/);
  assert.match(app,/Waktu transaksi/);
});

test('klik penjualan membuka struk pelanggan asli', () => {
  assert.match(app, /state\.reportView==='sales'&&sale/);
  assert.match(app, /openHistoryReceiptPage\(sale\)/);
  assert.match(html, /id="report-sale-receipt-page"/);
  assert.match(html, /id="back-history-receipt"/);
  assert.match(html, /id="history-receipt-menu-backdrop"/);
  for (const action of ['details','print','share','return','void','edit','delete']) {
    assert.match(html, new RegExp(`data-history-receipt-action="${action}"`));
  }
  assert.match(app, /Transaksi selesai tidak dapat diedit langsung/);
  assert.match(app, /Transaksi selesai tidak boleh dihapus permanen/);
  assert.match(css, /#page-reports\.receipt-page-open/);
  assert.match(css, /\.history-receipt-paper/);
  assert.match(css, /\.history-receipt-page\{position:fixed;z-index:100;inset:0/);
  assert.match(css, /\.history-action-menu\{position:fixed;z-index:115;[^}]*bottom:0/);
  assert.match(app, /document\.body\.classList\.add\('history-receipt-open'\)/);
  assert.match(app, /if\(allowAutoPrint&&state\.deviceSettings\.autoPrint\)/);
  assert.match(app, /function saleReturnLabel\(sale\)/);
  assert.match(app, /Diretur \$\{Number\(line\.returnedQty\)/);
  assert.match(app, /Total setelah retur/);
  assert.match(css, /html:has\(dialog\[open\]\),body:has\(dialog\[open\]\)\{overflow:hidden\}/);
  assert.match(css, /#receipt-dialog \.receipt-dialog\{[^}]*overflow-y:auto[^}]*background:#fff/);
});

test('semua filter laporan utama dimulai dari hari ini dan tren bersifat opsional', () => {
  assert.match(html, /id="report-preset"[\s\S]*value="TODAY" selected/);
  assert.match(html, /id="report-filter-summary">Hari ini · Semua outlet/);
  assert.match(html, /class="surface report-trend-panel"/);
  assert.match(css, /\.report-trend-panel>summary/);
  assert.match(app, /owner-finance-from'\)\.value = today/);
  assert.match(app, /accounting-from'\)\.value=today/);
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
