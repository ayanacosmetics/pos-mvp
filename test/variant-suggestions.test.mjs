import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildVariantSuggestions} from '../apps/web/variant-suggestions.mjs';

const product=(id,name,extra={})=>({id,sku:`KP-${id}`,name,active:true,...extra});

test('saran etalase memisahkan keluarga bertingkat dan mempertahankan SKU jual',()=>{
  const suggestions=buildVariantSuggestions([
    product('1','IMPLORA HAIR COLOR 01'),product('2','IMPLORA HAIR COLOR 02'),product('3','IMPLORA HAIR COLOR 04'),
    product('4','IMPLORA HAIR COLOR SHAMPOO BLACK'),product('5','IMPLORA HAIR COLOR SHAMPOO BROWN'),
    product('6','IMPLORA LIP CREAM MATTE 01 DUSKY NUDE'),product('7','IMPLORA LIP CREAM MATTE 02'),product('8','IMPLORA LIP CREAM MATTE 03')
  ]);
  const hair=suggestions.find((item)=>item.familyName==='IMPLORA HAIR COLOR');
  const shampoo=suggestions.find((item)=>item.familyName==='IMPLORA HAIR COLOR SHAMPOO');
  const lip=suggestions.find((item)=>item.familyName==='IMPLORA LIP CREAM MATTE');
  assert.deepEqual(hair.products.map((item)=>item.variantName),['01','02','04']);
  assert.deepEqual(shampoo.products.map((item)=>item.variantName),['BLACK','BROWN']);
  assert.deepEqual(lip.products.map((item)=>item.sku),['KP-6','KP-7','KP-8']);
  assert.equal(lip.products[0].variantName,'01 DUSKY NUDE');
});

test('saran menghindari pasangan dengan nama dasar terlalu umum dan produk yang sudah dipetakan',()=>{
  const suggestions=buildVariantSuggestions([
    product('1','IMPLORA SERUM ACNE'),product('2','IMPLORA SERUM GOLD'),
    product('3','SEA MAKEUP GLEAM LUSTER TINTED LIP BALM AURORA',{familyId:'existing'}),
    product('4','SEA MAKEUP GLEAM LUSTER TINTED LIP BALM LUNA')
  ]);
  assert.deepEqual(suggestions,[]);
});

test('kode etalase otomatis stabil, unik, dan memenuhi batas database',()=>{
  const input=[product('1','TIME PHORIA TIMELESS LUMINA PERFECTION CUSHION 01 BARE'),product('2','TIME PHORIA TIMELESS LUMINA PERFECTION CUSHION 02 BIRCH')];
  const first=buildVariantSuggestions(input)[0],second=buildVariantSuggestions(input)[0];
  assert.equal(first.familyCode,second.familyCode);
  assert.match(first.familyCode,/^[A-Z0-9-]{2,50}$/);
});

test('kemasan berbeda yang terselip pada kelompok ukuran wajib ditinjau',()=>{
  const suggestion=buildVariantSuggestions([
    product('1','LIFEBUOY 170 ML BIRU'),product('2','LIFEBUOY 170 ML HIJAU'),product('3','LIFEBUOY 170 ML 340 ML')
  ])[0];
  assert.equal(suggestion.familyName,'LIFEBUOY 170 ML');
  assert.equal(suggestion.safe,false);
});

test('halaman produk menyediakan pratinjau dan commit etalase tanpa reset data',async()=>{
  const [html,app,worker]=await Promise.all([
    readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/service-worker.js',import.meta.url),'utf8')
  ]);
  for(const id of ['open-variant-suggestions','variant-suggestions-dialog','variant-suggestion-list','apply-variant-suggestions'])assert.ok(html.includes(`id="${id}"`));
  assert.match(app,/kind:'PRODUCT_VARIANTS',mode:'UPDATE_ONLY'/);
  assert.match(app,/selectedVariantSuggestions\.clear\(\);[\s\S]*renderVariantSuggestions\(\)/);
  assert.match(worker,/variant-suggestions\.mjs/);
});
