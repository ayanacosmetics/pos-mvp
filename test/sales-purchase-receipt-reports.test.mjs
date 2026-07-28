import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSalesItemAnalytics, filteredSalesReport } from '../api/index.mjs';

const [html, app, api, css] = await Promise.all([
  readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/index.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8'),
]);

test('filter laporan membedakan tunai, piutang, dan multipayment',()=>{
  const base={status:'COMPLETED',returnTotal:0,occurredAt:'2026-07-28T10:00:00+08:00',cashierId:'staff-1',cashier:'Ayu'};
  const sales=[
    {...base,id:'cash',netTotal:100000,netCost:60000,grossProfit:40000,quote:{grandTotal:100000},payments:[{method:'CASH',amount:100000}]},
    {...base,id:'credit',netTotal:200000,netCost:100000,grossProfit:100000,quote:{grandTotal:200000},payments:[{method:'CREDIT',amount:200000}]},
    {...base,id:'split',netTotal:300000,netCost:180000,grossProfit:120000,quote:{grandTotal:300000},payments:[{method:'CASH',amount:100000},{method:'CREDIT',amount:200000}]}
  ];
  const all=filteredSalesReport(sales,{timezone:'Asia/Makassar',paymentMethods:['CASH','CREDIT','MULTIPAYMENT']});
  assert.equal(all.metrics.transactionCount,3);assert.equal(all.metrics.netSales,200000);assert.equal(all.metrics.grossProfit,260000);
  const split=filteredSalesReport(sales,{timezone:'Asia/Makassar',paymentState:'CREDIT',paymentMethods:['MULTIPAYMENT'],includeCreditRevenue:true,includeCreditProfit:false});
  assert.equal(split.metrics.transactionCount,1);assert.equal(split.metrics.netSales,300000);assert.equal(split.metrics.grossProfit,40000);
});

test('analisis barang menghitung qty, pendapatan, keuntungan, kategori, dan add-on',()=>{
  const sales=[{id:'sale-1',status:'COMPLETED',cashierId:'staff-1',payments:[{method:'CASH',amount:50000}],quote:{grandTotal:50000},paidCreditAmount:0}];
  const items=[
    {sale_id:'sale-1',product_id:'p1',product_name:'Lip Tint',base_qty:2,total:30000,cost_total:18000},
    {sale_id:'sale-1',product_id:'p2',product_name:'Pouch',base_qty:1,total:20000,cost_total:8000}
  ];
  const products=[{id:'p1',sku:'LIP-1',name:'Lip Tint',category:'Makeup'},{id:'p2',sku:'ADD-1',name:'Pouch',category:'Aksesori'}];
  const result=buildSalesItemAnalytics(sales,items,products,[],[{product_id:'p1',quantity:8},{product_id:'p2',quantity:4}],{paymentMethods:['CASH'],paymentState:'ALL',includeCreditProfit:true,includeCreditRevenue:true});
  assert.equal(result.dashboard.qtySold,3);assert.equal(result.dashboard.netRevenue,50000);assert.equal(result.dashboard.grossProfit,24000);
  assert.equal(result.products[0].currentStock,8);assert.equal(result.categories.length,2);assert.equal(result.addons.length,2);
});

test('laporan penjualan menyatukan ringkasan keuntungan dan riwayat struk', () => {
  assert.match(html, /data-report-view="sales"[\s\S]*<span>Transaksi<\/span>/);
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
  assert.match(app,/\['transactions','Jumlah transaksi'\]/);
  assert.match(app,/\['returns','Retur pelanggan'\]/);
  assert.match(html,/id="sales-report-filters"/);
  assert.match(html,/data-sales-payment-method="MULTIPAYMENT" checked/);
  assert.match(html,/id="sales-include-credit-profit" type="checkbox" checked/);
  assert.match(html,/id="sales-include-credit-revenue" type="checkbox"/);
  assert.match(app,/function readSalesReportFilter\(\)/);
  assert.match(app,/function filteredPosSales\(\)/);
  assert.match(api,/route==='reports\/sales-filtered'/);
  assert.match(api,/route==='reports\/sales-items'/);
  assert.match(api,/route==='reports\/stock-flow'/);
  assert.match(api,/function filteredSalesReport/);
  assert.match(api,/classification=payments\.length>1\?'MULTIPAYMENT'/);
  assert.match(app,/PENJUALAN PER BULAN/);
  assert.match(app,/TRANSAKSI PER HARI/);
  assert.match(app,/data-sales-drill-level/);
  assert.match(app,/data-sales-period-back/);
  assert.match(api,/route==='reports\/sales-years'/);
  assert.match(css,/#page-reports #report-cards:has\(\.sales-metric-button\)/);
  assert.match(css,/\.sales-metric-value\{/);
  assert.match(css,/#page-reports #report-cards:has\(\.sales-metric-button\)\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(app,/Nomor struk/);
  assert.match(app,/Waktu transaksi/);
  assert.match(html,/id="sales-analysis-dashboard"/);
  assert.match(html,/id="sales-analysis-list"/);
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
