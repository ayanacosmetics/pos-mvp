import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  applySaleAdjustment,
  normalizeSaleAdjustment,
  saleAdjustmentFingerprintPayload
} from '../packages/domain/src/sale-adjustment.mjs';
import { customerReceiptView } from '../apps/web/receipt.mjs';

const baseQuote = {
  lines: [
    { productId:'p1',unitId:'u1',productName:'Lip Tint',unitName:'pcs',qty:2,gross:100000,discount:10000,total:90000,promotions:[] },
    { productId:'p2',unitId:'u2',productName:'Sabun',unitName:'pcs',qty:1,gross:20000,discount:0,total:20000,promotions:[] }
  ],
  subtotal:120000,
  discountTotal:10000,
  grandTotal:110000
};
const simpleQuote = {
  lines: [
    { productId:'p1',unitId:'u1',productName:'Lip Tint',unitName:'pcs',qty:1,gross:100000,discount:0,total:100000,promotions:[] }
  ],
  subtotal:100000,
  discountTotal:0,
  grandTotal:100000
};

test('diskon manual barang diterapkan setelah promo aktif dan menyimpan supervisor', () => {
  const adjustment = normalizeSaleAdjustment({ scope:'LINE',mode:'PERCENT',value:10,reason:'Kemasan sedikit penyok',productId:'p1',unitId:'u1' });
  const quote = applySaleAdjustment(baseQuote, adjustment, { id:'approval-1',approvedBy:'Owner' });
  assert.equal(quote.lines[0].total,81000);
  assert.equal(quote.manualAdjustment.discountAmount,9000);
  assert.equal(quote.discountTotal,19000);
  assert.equal(quote.grandTotal,101000);
  assert.equal(quote.lines[0].promotions[0].approvedBy,'Owner');
});

test('harga manual per satuan dapat diturunkan atau dinaikkan secara terkontrol', () => {
  const lowered = applySaleAdjustment(baseQuote, { scope:'LINE',mode:'FIXED_PRICE',value:40000,reason:'Harga khusus pelanggan',productId:'p1',unitId:'u1' }, { approvedBy:'Admin' });
  assert.equal(lowered.lines[0].total,80000);
  assert.equal(lowered.manualAdjustment.discountAmount,10000);

  const raised = applySaleAdjustment(baseQuote, { scope:'LINE',mode:'FIXED_PRICE',value:50000,reason:'Koreksi harga rak terbaru',productId:'p1',unitId:'u1' }, { approvedBy:'Owner' });
  assert.equal(raised.lines[0].total,100000);
  assert.equal(raised.manualAdjustment.discountAmount,-10000);
  assert.equal(raised.discountTotal,0);
  assert.equal(raised.grandTotal,120000);
  assert.equal(raised.lines[0].promotions.at(-1).approvedBy,'Owner');
});

test('diskon transaksi dibagi proporsional tanpa mengubah total akhir', () => {
  const quote = applySaleAdjustment(baseQuote, { scope:'ORDER',mode:'FIXED_DISCOUNT',value:11000,reason:'Kompensasi pelanggan tetap' }, { approvedBy:'Owner' });
  assert.equal(quote.manualAdjustment.discountAmount,11000);
  assert.equal(quote.lines.reduce((sum,line)=>sum+line.total,0),99000);
  assert.equal(quote.grandTotal,99000);
});

test('struk menyamarkan harga internal sebagai harga jual final', () => {
  const quote = applySaleAdjustment(simpleQuote, {
    scope:'LINE', mode:'FIXED_PRICE', value:80000, reason:'Harga khusus internal',
    productId:'p1', unitId:'u1'
  }, { id:'approval-secret', approvedBy:'Owner' });
  const receipt = customerReceiptView(quote);
  assert.equal(receipt.lines[0].customerUnitPrice,80000);
  assert.equal(receipt.subtotal,80000);
  assert.equal(receipt.discountTotal,0);
  assert.equal(receipt.grandTotal,80000);
  assert.equal(receipt.internalPriceAdjustment,20000);
});

test('diskon pelanggan tetap dicantumkan terpisah pada struk', () => {
  const quote = applySaleAdjustment(simpleQuote, {
    scope:'ORDER', mode:'PERCENT', value:10, reason:'Diskon pelanggan tetap'
  }, { id:'approval-discount', approvedBy:'Owner' });
  const receipt = customerReceiptView(quote);
  assert.equal(receipt.subtotal,100000);
  assert.equal(receipt.discountTotal,10000);
  assert.equal(receipt.grandTotal,90000);
  assert.equal(receipt.internalPriceAdjustment,0);
});

test('promo pelanggan tidak digabung dengan penyesuaian harga internal', () => {
  const promotedQuote = {
    lines:[{
      productId:'p1',unitId:'u1',productName:'Lip Tint',unitName:'pcs',qty:1,
      gross:100000,discount:10000,total:90000,
      promotions:[{id:'promo',code:'PROMO10',version:1,discount:10000}]
    }],
    subtotal:100000,discountTotal:10000,grandTotal:90000
  };
  const quote = applySaleAdjustment(promotedQuote, {
    scope:'LINE',mode:'FIXED_PRICE',value:80000,reason:'Harga akhir internal',
    productId:'p1',unitId:'u1'
  }, {id:'approval-combined',approvedBy:'Owner'});
  const receipt = customerReceiptView(quote);
  assert.equal(receipt.lines[0].customerUnitPrice,90000);
  assert.equal(receipt.subtotal,90000);
  assert.equal(receipt.discountTotal,10000);
  assert.equal(receipt.grandTotal,80000);
  assert.equal(receipt.internalPriceAdjustment,10000);
});

test('sidik jari berubah ketika jumlah, kelompok pelanggan, atau aturan berubah', () => {
  const adjustment = { scope:'ORDER',mode:'PERCENT',value:5,reason:'Persetujuan pelanggan grosir' };
  const original = saleAdjustmentFingerprintPayload([{productId:'p1',unitId:'u1',qty:1}],'retail',adjustment);
  assert.notEqual(original,saleAdjustmentFingerprintPayload([{productId:'p1',unitId:'u1',qty:2}],'retail',adjustment));
  assert.notEqual(original,saleAdjustmentFingerprintPayload([{productId:'p1',unitId:'u1',qty:1}],'wholesale',adjustment));
  assert.notEqual(original,saleAdjustmentFingerprintPayload([{productId:'p1',unitId:'u1',qty:1}],'retail',{...adjustment,value:6}));
});

test('fondasi v1.13 mengikat persetujuan ke kasir, outlet, keranjang, masa berlaku, transaksi, dan audit', async () => {
  const migration = await readFile(new URL('../supabase/migrations/202607230018_sale_adjustment_authorization.sql',import.meta.url),'utf8');
  const api = await readFile(new URL('../api/index.mjs',import.meta.url),'utf8');
  const html = await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8');
  const script = await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
  assert.match(migration,/sale_adjustment_authorizations/);
  assert.match(migration,/complete_sale_v4/);
  assert.match(migration,/basket_fingerprint/);
  assert.match(migration,/expires_at<=now\(\)/);
  assert.match(migration,/SALE_ADJUSTMENT_CONSUMED/);
  assert.match(api,/sale-authorizations/);
  assert.match(api,/verifySaleAuthorization/);
  assert.match(html,/Persetujuan Owner\/Admin/);
  assert.match(script,/invalidateSaleAuthorization/);
});

test('UI memisahkan harga internal dari diskon pelanggan dan struk', async () => {
  const html = await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8');
  const script = await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
  assert.match(html,/PENYESUAIAN HARGA INTERNAL/);
  assert.match(html,/id="price-adjustment-summary"/);
  assert.match(script,/isLine\s*\?\s*'<option value="FIXED_PRICE">Harga jual akhir per satuan<\/option>'/);
  assert.doesNotMatch(script,/Promo & penyesuaian/);
  assert.match(script,/customerView\.discountTotal/);
});
