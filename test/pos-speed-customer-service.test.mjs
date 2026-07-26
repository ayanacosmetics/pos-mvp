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
  assert.match(api,/approvedSupervisor/);
  assert.match(api,/rpc\('void_sale_v1'/);
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

test('POS v1.21 menyediakan produk cepat, filter, shortcut, riwayat, cetak ulang, dan catatan',async()=>{
  const [,api,html,script]=await files();
  for(const id of ['pos-category-filters','favorite-filter','open-shortcuts','open-pos-history','pos-history-search','sale-note','customer-service-note','mobile-cart-jump'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(script,/pos_favorites:/);
  assert.match(script,/function handlePosShortcut/);
  assert.match(script,/event\.key==='F9'/);
  assert.match(script,/reprint-pos-sale/);
  assert.match(script,/notes:el\('sale-note'\)\.value\.trim\(\)/);
  assert.match(api,/route === 'pos-sales'/);
  assert.match(api,/complete_sale_v6/);
});

test('tampilan satu tangan menjaga akses keranjang dan aksi checkout pada mobile',async()=>{
  const [,,,script,css]=await files();
  assert.match(css,/\.mobile-cart-jump\{position:fixed/);
  assert.match(css,/\.cart-summary\{position:sticky/);
  assert.match(css,/@media\(max-width:760px\)/);
  assert.match(script,/mobile-cart-jump'\)\.addEventListener\('click'/);
  assert.match(script,/mobile-cart-count/);
});
