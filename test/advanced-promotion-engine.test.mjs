import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { quoteBasket as serverQuote } from '../packages/domain/src/pricing.mjs';
import { quoteBasket as offlineQuote } from '../apps/web/pricing.mjs';

const products=[
  {id:'a',sku:'A',name:'Produk A',category:'Kosmetik',brand:'Nusa',units:[{id:'a-pcs',name:'pcs',factor:1}],priceRules:[{id:'a-price',customerGroupId:null,minBaseQty:1,unitPriceBase:10000}]},
  {id:'b',sku:'B',name:'Produk B',category:'Aksesori',brand:'Nusa',units:[{id:'b-pcs',name:'pcs',factor:1}],priceRules:[{id:'b-price',customerGroupId:null,minBaseQty:1,unitPriceBase:20000}]}
];
const base={promotionId:'promo',version:1,status:'PUBLISHED',startsAt:'2026-07-01T00:00:00+08:00',endsAt:'2026-07-31T23:59:59+08:00',priority:50,stackable:false};
const at=new Date('2026-07-23T12:00:00+08:00');

test('beli dua gratis satu menghitung barang gratis secara deterministik',()=>{
  const promo={...base,id:'buy-get',code:'BUY2GET1',condition:{productIds:['a'],minBaseQty:0},reward:{type:'BUY_X_GET_Y',buyQty:2,freeQty:1}};
  const input={lines:[{productId:'a',unitId:'a-pcs',qty:3}],customerGroupId:'retail',products,promotions:[promo],at};
  const quote=serverQuote(input);
  assert.equal(quote.subtotal,30000);assert.equal(quote.discountTotal,10000);assert.equal(quote.grandTotal,20000);
  assert.deepEqual(offlineQuote(input),quote);
});

test('bundling dua produk membagi diskon tanpa mengubah total akhir',()=>{
  const promo={...base,id:'bundle',code:'PAKET25',condition:{bundle:[{productId:'a',qty:1},{productId:'b',qty:1}]},reward:{type:'BUNDLE_FIXED',value:25000}};
  const input={lines:[{productId:'a',unitId:'a-pcs',qty:1},{productId:'b',unitId:'b-pcs',qty:1}],customerGroupId:'retail',products,promotions:[promo],at};
  const quote=serverQuote(input);
  assert.equal(quote.subtotal,30000);assert.equal(quote.discountTotal,5000);assert.equal(quote.grandTotal,25000);
  assert.equal(quote.lines.reduce((sum,line)=>sum+line.total,0),25000);
});

test('promo total belanja mematuhi ambang, kelompok pelanggan, dan jadwal',()=>{
  const promo={...base,id:'order',code:'MEMBER10',condition:{minBasketSubtotal:25000,customerGroupIds:['wholesale'],schedule:{daysOfWeek:[4],timeStart:'09:00',timeEnd:'17:00',timeZone:'Asia/Makassar'}},reward:{type:'PERCENT_ORDER',value:10,maxDiscount:10000}};
  const lines=[{productId:'a',unitId:'a-pcs',qty:1},{productId:'b',unitId:'b-pcs',qty:1}];
  assert.equal(serverQuote({lines,customerGroupId:'wholesale',products,promotions:[promo],at}).grandTotal,27000);
  assert.equal(serverQuote({lines,customerGroupId:'retail',products,promotions:[promo],at}).grandTotal,30000);
});

test('fondasi promo lanjutan memiliki versi, penghentian, limit atomik, dan UI simulasi',async()=>{
  const migration=await readFile(new URL('../supabase/migrations/202607230016_advanced_promotion_engine.sql',import.meta.url),'utf8');
  const api=await readFile(new URL('../api/index.mjs',import.meta.url),'utf8');
  const html=await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8');
  assert.match(migration,/publish_promotion_v2/);assert.match(migration,/promotion_redemptions/);
  assert.match(migration,/for update/);assert.match(migration,/usage_count=usage_count\+1/);
  assert.match(migration,/retire_promotion_version/);assert.match(api,/promotions\/manage/);
  assert.match(html,/Beli X gratis Y/);assert.match(html,/Paket bundling/);assert.match(html,/id="promo-days"/);
});
