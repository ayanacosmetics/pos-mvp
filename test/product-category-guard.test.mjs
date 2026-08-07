import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { canonicalProductCategories, canonicalProductCategory, normalizeProductCategory } from '../apps/web/product-categories.mjs';

test('kategori produk merapikan spasi dan menyatukan perbedaan huruf',()=>{
  const products=[
    {category:'Lip Tint'},{category:' lip   tint '},{category:'LIP TINT'},
    {category:'Bedak'},{category:'bedak'},{category:'Bedak'}
  ];
  assert.equal(normalizeProductCategory('  Lip   Tint  '),'Lip Tint');
  assert.deepEqual(canonicalProductCategories(products),['Bedak','Lainnya','Lip Tint']);
  assert.equal(canonicalProductCategory(' LIP  TINT ',canonicalProductCategories(products)),'Lip Tint');
  assert.equal(canonicalProductCategory('Kategori Baru',canonicalProductCategories(products)),null);
});

test('semua menu pembuat barang memakai pilihan kategori, termasuk import dan restok',async()=>{
  const [html,app,api,worker]=await Promise.all([
    readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
    readFile(new URL('../api/index.mjs',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/service-worker.js',import.meta.url),'utf8')
  ]);
  assert.match(html,/<select id="new-category" required><\/select>/);
  assert.match(html,/<select id="restock-new-category" required><\/select>/);
  assert.doesNotMatch(html,/id="(?:new-category|restock-new-category)"[^>]*list=/);
  assert.match(app,/renderProductCategorySelect\('new-category'/);
  assert.match(app,/renderProductCategorySelect\('restock-new-category'/);
  assert.match(app,/createTemplateWorkbook\(window\.XLSX,kind,\{categories:availableProductCategories\(\)\}\)/);
  assert.match(api,/canonicalizeProductInputCategory\(context\.tenantId,normalizeProductInput/);
  assert.match(api,/normalized\.rows[\s\S]*requireCanonicalProductCategory\(row\.category,existing\)/);
  assert.match(api,/canonicalizeRestockNewProductCategories\(context\.tenantId,requirePositiveReceiptItems/);
  assert.match(worker,/product-categories\.mjs/);
});
