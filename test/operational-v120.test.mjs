import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { quoteBasket as serverQuote } from '../packages/domain/src/pricing.mjs';
import { quoteBasket as offlineQuote } from '../apps/web/pricing.mjs';
import { applySaleAdjustment } from '../packages/domain/src/sale-adjustment.mjs';

const products=[{
  id:'serum',sku:'SERUM',name:'Serum Wajah',category:'Kosmetik',brand:'Nusa',
  units:[{id:'serum-pcs',name:'pcs',factor:1}],
  priceRules:[{id:'serum-retail',customerGroupId:null,minBaseQty:1,unitPriceBase:60000}]
}];
const at=new Date('2026-07-23T12:00:00+08:00');
const basePromo={
  promotionId:'promo',version:1,status:'PUBLISHED',
  startsAt:'2026-07-01T00:00:00+08:00',endsAt:'2026-07-31T23:59:59+08:00',
  priority:50,stackable:false,code:'HEMAT8',condition:{minBaseQty:1,minBasketSubtotal:100000}
};

test('potongan Rp8.000 berlaku sekali walau jumlah barang bertambah',()=>{
  const promo={...basePromo,id:'once',reward:{type:'FIXED_ORDER',value:8000,repeatMode:'ONCE'}};
  const input={lines:[{productId:'serum',unitId:'serum-pcs',qty:2}],customerGroupId:'retail',products,promotions:[promo],at};
  const quote=serverQuote(input);
  assert.equal(quote.subtotal,120000);
  assert.equal(quote.discountTotal,8000);
  assert.equal(quote.grandTotal,112000);
  assert.equal(quote.promotionEngineVersion,'2.1.0');
  assert.deepEqual(offlineQuote(input),quote);
});

test('potongan total dapat berlaku kelipatan syarat dan dibatasi',()=>{
  const promo={...basePromo,id:'multiple',reward:{type:'FIXED_ORDER',value:8000,repeatMode:'MULTIPLE',repeatCap:2}};
  const input={lines:[{productId:'serum',unitId:'serum-pcs',qty:6}],customerGroupId:'retail',products,promotions:[promo],at};
  const quote=serverQuote(input);
  assert.equal(quote.subtotal,360000);
  assert.equal(quote.discountTotal,16000);
  assert.equal(quote.grandTotal,344000);
  assert.match(quote.lines[0].promotions[0].reason,/2 kelipatan/);
  assert.deepEqual(offlineQuote(input),quote);
});

test('diskon rupiah per item dikalikan jumlah satuan jual',()=>{
  const quote={
    lines:[{productId:'serum',unitId:'serum-pcs',productName:'Serum Wajah',unitName:'pcs',qty:2,gross:120000,discount:0,total:120000,promotions:[]}],
    subtotal:120000,discountTotal:0,grandTotal:120000
  };
  const adjusted=applySaleAdjustment(quote,{
    scope:'LINE',mode:'FIXED_DISCOUNT',value:5000,reason:'Diskon nominal pelanggan',
    productId:'serum',unitId:'serum-pcs'
  },{approvedBy:'Owner'});
  assert.equal(adjusted.lines[0].total,110000);
  assert.equal(adjusted.discountTotal,10000);
});

test('UI operasional memulai transaksi tanpa member dan menjaga stok kosong',async()=>{
  const [html,script]=await Promise.all([
    readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8')
  ]);
  assert.match(html,/id="new-pos-customer"/);
  assert.match(html,/id="clear-pos-customer"/);
  assert.match(html,/id="customer-group".*value="retail"/s);
  assert.match(script,/function resetPosCustomer/);
  assert.match(script,/stok tidak cukup/);
  assert.match(script,/jumlah melebihi stok tersedia/);
  assert.match(script,/product-card \$\{empty \? 'out-of-stock'/);
});

test('kamera barcode tersedia pada POS, PO, dan restok',async()=>{
  const [html,script]=await Promise.all([
    readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8')
  ]);
  for(const id of ['scan-camera-pos','camera-po-product','camera-restock-product','barcode-camera-dialog']) {
    assert.match(html,new RegExp(`id="${id}"`));
  }
  assert.match(script,/new BarcodeDetector/);
  assert.match(script,/getUserMedia/);
  assert.match(script,/stopBarcodeCamera/);
});

test('SQL dan tampilan v1.20 memuat promo sekali atau kelipatan serta saran harga',async()=>{
  const [migration,html,script]=await Promise.all([
    readFile(new URL('../supabase/migrations/202607230024_operational_v120.sql',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8')
  ]);
  assert.match(migration,/FIXED_ORDER/);
  assert.match(migration,/engineVersion','2\.1\.0/);
  assert.match(migration,/prevent_duplicate_customer_phone/);
  assert.match(html,/Berlaku sekali/);
  assert.match(html,/Berlaku kelipatan syarat/);
  assert.match(script,/markupPreservingRecommendation/);
  assert.match(script,/newCost\+previousProfit/);
  assert.match(script,/Harga saran sudah diisikan/);
});
