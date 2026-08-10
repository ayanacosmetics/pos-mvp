import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [html,app,api,migration]=await Promise.all([
  readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
  readFile(new URL('../api/index.mjs',import.meta.url),'utf8'),
  readFile(new URL('../supabase/migrations/202608100001_quick_sale_products.sql',import.meta.url),'utf8')
]);

test('kasir menyediakan alur singkat barang belum terdaftar',()=>{
  for(const id of ['open-quick-product','quick-product-dialog','quick-product-form','quick-product-name','quick-product-price','quick-product-barcode','save-quick-product']){
    assert.match(html,new RegExp(`id="${id}"`));
  }
  assert.match(html,/Perlu dilengkapi/);
  assert.match(app,/function openQuickProduct/);
  assert.match(app,/function saveQuickProduct/);
  assert.match(app,/\/api\/products\/quick/);
  assert.match(app,/await addToCart\(catalogProduct\.id,unit\.id\)/);
});

test('barang cepat permanen, non-stok, terbatas POS, dan diaudit',()=>{
  assert.match(api,/route==='products\/quick'/);
  assert.match(api,/requirePermission\(session,'pos\.sell'\)/);
  assert.match(api,/QUICK_PRODUCT_CREATED/);
  assert.match(migration,/profile_has_permission_v1\(p_tenant_id,p_actor_id,'pos\.sell'\)/);
  assert.match(migration,/insert into public\.products/);
  assert.match(migration,/'Perlu dilengkapi',null,0,false,false,true/);
  assert.match(migration,/QUICK_PRODUCT_CREATED/);
  assert.match(migration,/grant execute on function public\.create_quick_sale_product_v1[\s\S]*to service_role/);
  assert.doesNotMatch(migration,/grant execute[\s\S]*to authenticated/);
});

test('barcode barang cepat tetap unik dan katalog menyediakan antrean review',()=>{
  assert.match(migration,/Barcode sudah digunakan barang lain/);
  assert.match(migration,/unique|product_units/);
  assert.match(html,/value="NEEDS_REVIEW">Perlu dilengkapi/);
  assert.match(app,/status==='NEEDS_REVIEW'/);
  assert.match(app,/\['Perlu dilengkapi',needsReview\]/);
});
