import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { quoteBasket } from '../packages/domain/src/pricing.mjs';

const html=await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8');
const app=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
const api=await readFile(new URL('../api/index.mjs',import.meta.url),'utf8');

test('halaman promo memisahkan dashboard dari editor empat langkah',()=>{
  for(const id of ['promo-dashboard','promo-metrics','promo-search','new-promotion','promotion-form','close-promotion-editor','promo-tab-previous','promo-tab-next'])assert.match(html,new RegExp(`id="${id}"`));
  for(const tab of ['identity','target','schedule','preview']){
    assert.match(html,new RegExp(`data-promo-tab="${tab}"`));
    assert.match(html,new RegExp(`data-promo-panel="${tab}"`));
  }
  assert.match(app,/function showPromotionWorkspace/);assert.match(app,/function showPromoEditorTab/);
});

test('sasaran promo memakai kategori katalog dan pencarian multi-produk',()=>{
  assert.match(html,/id="promo-category"[^>]*><option value="">Pilih kategori/);
  assert.match(html,/id="promo-target-product-search"[^>]+nama, SKU, atau barcode/i);
  assert.match(html,/id="promo-target-product-results"/);assert.match(html,/id="promo-target-product-selected"/);
  assert.match(app,/const promoTargetProductIds=new Set\(\)/);
  assert.match(app,/product\.name} \${product\.sku} \${\(product\.units/);
  assert.match(app,/condition\.productIds=\[\.\.\.promoTargetProductIds\]/);
  assert.match(api,/function validatedPromotionInput/);assert.match(api,/Kategori sasaran tidak tersedia pada katalog produk/);
  assert.match(api,/Ada produk sasaran promo yang tidak ditemukan atau sudah tidak aktif/);
});

test('promo tanpa tanggal akhir tetap aktif sampai dihentikan manual',()=>{
  assert.match(html,/id="promo-no-end"/);assert.match(html,/Tanpa tanggal berakhir/);
  assert.match(app,/PROMO_NO_END='9999-12-31T15:59:59\.999Z'/);
  const product={id:'p',name:'Produk',category:'Tes',brand:'Nusa',units:[{id:'u',name:'pcs',factor:1}],priceRules:[{id:'r',customerGroupId:'retail',minBaseQty:1,unitPriceBase:10000}]};
  const promo={id:'promo',promotionId:'promo',code:'SELAMANYA',name:'Tanpa akhir',version:1,status:'PUBLISHED',startsAt:'2026-01-01T00:00:00Z',endsAt:'9999-12-31T15:59:59.999Z',priority:50,stackable:false,condition:{minBaseQty:1},reward:{type:'PERCENT_ITEM',value:10,maxDiscount:100000}};
  const quote=quoteBasket({lines:[{productId:'p',unitId:'u',qty:1}],customerGroupId:'retail',products:[product],promotions:[promo],at:new Date('2099-01-01T00:00:00Z')});
  assert.equal(quote.grandTotal,9000);
});

test('editor menyediakan kontrol profesional dan simulasi aman',()=>{
  for(const id of ['promo-customer-group','promo-min-qty','promo-min-basket','promo-priority','promo-limit-total','promo-limit-customer','promo-stackable','promo-days','promo-time-start','promo-time-end','simulate-promo'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/Simulasi tidak menyimpan transaksi atau mengubah stok/);
  assert.match(api,/Produk atau jumlah paket bundling tidak valid/);
  assert.match(api,/Hari berlaku promo tidak valid/);
});
