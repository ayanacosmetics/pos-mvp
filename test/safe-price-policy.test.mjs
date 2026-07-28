import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateSafePricePolicy, normalizeSafePricePolicy } from '../packages/domain/src/safe-price-policy.mjs';

const rules=[
  {customerGroupId:'member',minBaseQty:1,discountAmount:500},
  {customerGroupId:'wholesale',minBaseQty:1,discountAmount:500},
  {customerGroupId:'wholesale',minBaseQty:3,discountAmount:1000}
];

test('margin 1000 hanya menerapkan tingkat yang menyisakan laba minimum 500',()=>{
  const result=evaluateSafePricePolicy({retailPrice:25000,cost:24000,rules,minProfit:500});
  assert.equal(result.safeCount,2);
  assert.equal(result.results.find((rule)=>rule.minBaseQty===3).reason,'BEP');
  assert.equal(result.recommendedIncrease,0);
});

test('margin 500 menolak seluruh tingkatan dan menyarankan kenaikan harga umum 500',()=>{
  const result=evaluateSafePricePolicy({retailPrice:24500,cost:24000,rules,minProfit:500});
  assert.equal(result.safeCount,0);
  assert.equal(result.results.find((rule)=>rule.minBaseQty===3).reason,'LOSS');
  assert.equal(result.recommendedIncrease,500);
});

test('produk tanpa modal ditolak agar harga otomatis tidak mengira modalnya nol',()=>{
  const result=evaluateSafePricePolicy({retailPrice:25000,cost:0,rules,minProfit:500});
  assert.equal(result.safeCount,0);
  assert.equal(result.results[0].reason,'NO_COST');
  assert.equal(result.recommendedIncrease,0);
});

test('konfigurasi menolak aturan duplikat dan tipe umum',()=>{
  assert.throws(()=>normalizeSafePricePolicy({rules:[
    {customerGroupId:'member',minBaseQty:1,discountAmount:500},
    {customerGroupId:'member',minBaseQty:1,discountAmount:1000}
  ]}),/tercatat dua kali/);
  assert.throws(()=>normalizeSafePricePolicy({rules:[
    {customerGroupId:'retail',minBaseQty:1,discountAmount:500}
  ]}),/tidak valid/);
});

test('database, API, dan UI menyediakan kebijakan harga aman yang selalu diperbarui',async()=>{
  const [sql,api,html,app]=await Promise.all([
    readFile(new URL('../supabase/migrations/202607280040_safe_customer_price_policy.sql',import.meta.url),'utf8'),
    readFile(new URL('../api/index.mjs',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8')
  ]);
  assert.match(sql,/create table if not exists public\.safe_customer_price_policies/);
  assert.match(sql,/function public\.refresh_safe_customer_prices_v1/);
  assert.match(sql,/stock_balances_refresh_safe_prices/);
  assert.match(sql,/function public\.save_product_v6/);
  assert.match(api,/route==='price-policy\/preview'/);
  assert.match(api,/route==='price-policy\/apply'/);
  assert.match(api,/rpc\('save_product_v6'/);
  assert.match(html,/id="open-price-policy"/);
  assert.match(html,/id="price-policy-preview"/);
  assert.match(app,/Saran: naikkan Harga Umum minimal/);
});
