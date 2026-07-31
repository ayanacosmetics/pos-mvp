import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PosStore } from '../apps/api/src/storage.mjs';
import { products, quoteBasket } from '../packages/domain/src/index.mjs';

const files = async () => Promise.all([
  readFile(new URL('../supabase/migrations/202607260025_pos_speed_customer_service.sql',import.meta.url),'utf8'),
  readFile(new URL('../api/index.mjs',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/styles.css',import.meta.url),'utf8')
]);

test('void transaksi wajib persetujuan, alasan, audit, dan pengembalian stok atomik',async()=>{
  const [migration,api]=await files();
  assert.match(migration,/function public\.void_sale_v1/);
  assert.match(migration,/role in \('OWNER','ADMIN'\)/);
  assert.match(migration,/length\(v_reason\)<5/);
  assert.match(migration,/customer_returns[\s\S]*status='COMPLETED'/);
  assert.match(migration,/credit_amount,0\)>0/);
  assert.match(migration,/Void hanya dapat dilakukan sebelum shift transaksi ditutup/);
  assert.match(migration,/'SALE_VOID'/);
  assert.match(migration,/'SALE_VOIDED'/);
  assert.match(migration,/for update/);
  assert.match(api,/requirePermission\(session, 'sale\.void'\)/);
  assert.match(api,/p_approved_by:session\.authUser\.id/);
  assert.match(api,/rpc\('void_sale_v2'/);
});

test('SQLite demo mengembalikan stok sekali dan menyimpan catatan saat void',()=>{
  const store=new PosStore(':memory:',products);
  const actor={id:'owner-v121',displayName:'Owner V121'};
  const shift=store.openShift({cashier:actor,openingCash:100000});
  const quote=quoteBasket({lines:[{productId:'lip-tint-a',unitId:'lip-tint-a-pcs',qty:2}],customerGroupId:'retail',products:store.catalog(),promotions:[],at:new Date()});
  const before=store.balance('outlet-utama','lip-tint-a').quantity;
  const sale=store.recordSale({key:'v121-sale',quote,cashier:actor,customerGroupId:'retail',paymentMethod:'Tunai',notes:'Diambil sore',shiftId:shift.id});
  assert.equal(store.balance('outlet-utama','lip-tint-a').quantity,before-2);
  const result=store.voidSale({saleId:sale.id,reason:'Salah pilih warna',actorId:actor.id,approvedBy:actor.id});
  assert.equal(result.status,'VOIDED');
  assert.equal(store.balance('outlet-utama','lip-tint-a').quantity,before);
  assert.equal(store.recentPosSales()[0].notes,'Diambil sore');
  assert.equal(store.recentPosSales()[0].voidReason,'Salah pilih warna');
  assert.equal(store.voidSale({saleId:sale.id,reason:'Salah pilih warna',actorId:actor.id,approvedBy:actor.id}).duplicate,true);
  assert.equal(store.balance('outlet-utama','lip-tint-a').quantity,before);
  assert.ok(store.auditLogs().some((entry)=>entry.action==='SALE_VOIDED'));
  const lateSale=store.recordSale({key:'v121-late-sale',quote,cashier:actor,customerGroupId:'retail',paymentMethod:'Tunai',shiftId:shift.id});
  store.closeShift({shiftId:shift.id,closingCash:store.shiftExpected(shift.id),actorId:actor.id});
  assert.throws(()=>store.voidSale({saleId:lateSale.id,reason:'Terlambat dibatalkan',actorId:actor.id,approvedBy:actor.id}),/sebelum shift/);
});

test('POS menyediakan produk cepat dan riwayat berpindah ke laporan transaksi',async()=>{
  const [,api,html,script]=await files();
  for(const id of ['pos-category-filters','favorite-filter','open-shortcuts','report-sales-workspace','pos-history-search','pos-history-list','pos-history-detail','sale-note','customer-service-note','mobile-cart-jump'])assert.match(html,new RegExp(`id="${id}"`));
  assert.doesNotMatch(html,/id="open-pos-history"/);
  assert.match(html,/data-report-view="sales"[\s\S]*<span>Transaksi<\/span>/);
  assert.match(html,/value="WEEK">Minggu ini/);
  assert.match(script,/pos_favorites:/);
  assert.match(script,/function handlePosShortcut/);
  assert.match(script,/event\.key==='F9'/);
  assert.match(script,/reprint-pos-sale/);
  assert.match(script,/state\.reportView==='sales'/);
  assert.match(script,/reportScope:true/);
  assert.match(script,/notes:el\('sale-note'\)\.value\.trim\(\)/);
  assert.match(api,/route === 'pos-sales'/);
  assert.match(api,/reportScope\?'report\.view':'pos\.sell'/);
  assert.match(api,/limit:reportScope\?500:50/);
  assert.match(api,/complete_sale_v7/);
});

test('ponsel memisahkan katalog dan keranjang, sedangkan tablet tetap berdampingan',async()=>{
  const [,,html,script,css]=await files();
  assert.match(html,/id="mobile-cart-back"/);
  assert.match(html,/aria-label="Buka halaman keranjang"/);
  assert.match(css,/\.mobile-cart-jump\{position:fixed/);
  assert.match(css,/\.cart-summary\{position:sticky/);
  assert.match(css,/@media\(max-width:760px\)/);
  assert.match(css,/\.pos-layout:not\(\.mobile-cart-view\) \.cart-pane\{display:none\}/);
  assert.match(css,/\.pos-layout\.mobile-cart-view \.catalog-pane\{display:none\}/);
  assert.doesNotMatch(css,/@media\(max-width:900px\) and \(min-width:761px\)\{[^}]*mobile-cart-view/);
  assert.match(script,/function setMobilePosView/);
  assert.match(script,/mobile-cart-jump'\)\.addEventListener\('click',\(\)=>setMobilePosView\('cart'\)/);
  assert.match(script,/mobile-cart-back'\)\.addEventListener\('click',\(\)=>setMobilePosView\('catalog'\)/);
  assert.match(script,/mobile-cart-count/);
});

test('desktop menjaga sidebar penuh dan daftar keranjang tetap dapat digulir',async()=>{
  const [,,html,script,css]=await files();
  assert.match(html,/id="cart-heading-count"/);
  assert.match(script,/cartQuantity[\s\S]*cart-heading-count/);
  assert.match(css,/\.sidebar\{[\s\S]*position:fixed;[\s\S]*inset:0 auto 0 0/);
  assert.match(css,/\.cart-pane\{[\s\S]*min-height:0;[\s\S]*overflow:hidden/);
  assert.match(css,/\.cart-lines\{[\s\S]*overflow-y:auto/);
  assert.match(css,/\.cart-summary\{[\s\S]*max-height:60%;[\s\S]*overflow-y:auto/);
  assert.match(css,/\.cart-line-main>div>strong\{[^}]*font-size:11px/);
  assert.match(css,/\.cart-line-meta\{[^}]*font-size:9px/);
});

test('desktop menjaga kontrol kasir tetap terlihat dan hanya daftar barang yang digulir',async()=>{
  const [,,html,script,css]=await files();
  assert.match(html,/class="pos-product-scroll"><div id="product-grid"/);
  assert.match(css,/@media\(min-width:761px\)\{[\s\S]*#page-pos \.catalog-pane\{[\s\S]*display:flex[\s\S]*overflow:hidden/);
  assert.match(css,/#page-pos \.catalog-pane>\.page-title,[\s\S]*#page-pos \.catalog-pane>\.pos-product-tools\{flex:0 0 auto\}/);
  assert.match(css,/#page-pos \.pos-product-scroll\{[\s\S]*min-height:0[\s\S]*flex:1[\s\S]*overflow-y:auto[\s\S]*scrollbar-gutter:stable/);
  assert.doesNotMatch(script,/posProductLimit|data-product-load-more/);
  assert.match(script,/innerHTML = list\.map\(\(product\)/);
});

test('ponsel mengunci kontrol kasir dan menggulir daftar produk secara mandiri',async()=>{
  const [,,,,css]=await files();
  assert.match(css,/@media\(max-width:760px\)\{[\s\S]*#page-pos \.pos-layout:not\(\.mobile-cart-view\)\{[\s\S]*height:calc\(100dvh - 64px\)[\s\S]*overflow:hidden/);
  assert.match(css,/#page-pos \.pos-layout:not\(\.mobile-cart-view\) \.catalog-pane\{[\s\S]*display:flex[\s\S]*height:100%[\s\S]*overflow:hidden/);
  assert.match(css,/#page-pos \.pos-product-scroll\{[\s\S]*flex:1[\s\S]*overflow-y:auto[\s\S]*-webkit-overflow-scrolling:touch/);
});
