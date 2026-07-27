import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('Kasir, restok, dan stok memakai daftar produk memanjang dengan thumbnail', async () => {
  const [script, css] = await Promise.all([
    read('../apps/web/app.js'),
    read('../apps/web/styles.css')
  ]);
  assert.match(script, /function productThumbnail\(product\)/);
  assert.match(script, /loading="lazy" decoding="async"/);
  assert.match(script, /class="product-card[^"]*"[\s\S]*productThumbnail\(product\)/);
  assert.match(script, /class="planning-compact-row[\s\S]*productThumbnail\(product \?\?/);
  assert.match(script, /class="inventory-product-row"[\s\S]*productThumbnail\(product\)/);
  assert.match(css, /\.product-grid\{display:grid;grid-template-columns:minmax\(0,1fr\)!important/);
  assert.match(css, /\.product-card-shell \.product-card\{display:grid;grid-template-columns:60px minmax\(0,1fr\) auto/);
  assert.match(css, /\.planning-compact-row\{grid-template-columns:60px minmax\(200px,1fr\)/);
  assert.match(css, /\.inventory-list-heading,\.inventory-product-row\{display:grid/);
});

test('foto produk dapat diatur dari editor dan URL yang rusak kembali ke placeholder', async () => {
  const [html, script] = await Promise.all([
    read('../apps/web/index.html'),
    read('../apps/web/app.js')
  ]);
  assert.match(html, /id="new-image-url" type="url"/);
  assert.match(html, /foto tampil di Kasir, Restok, dan Stok/);
  assert.match(script, /imageUrl:el\('new-image-url'\)\.value/);
  assert.match(script, /function bindProductImageFallbacks/);
  assert.match(script, /image\.addEventListener\('error', \(\) => image\.remove\(\)/);
});

test('migrasi foto produk menyimpan URL tervalidasi melalui transaksi produk v3', async () => {
  const [sql, api] = await Promise.all([
    read('../supabase/migrations/202607270036_product_images.sql'),
    read('../api/index.mjs')
  ]);
  assert.match(sql, /add column if not exists image_url text/);
  assert.match(sql, /products_image_url_check/);
  assert.match(sql, /function public\.save_product_v3/);
  assert.match(sql, /v_result:=public\.save_product_v2/);
  assert.match(sql, /grant execute on function public\.save_product_v3[\s\S]*to service_role/);
  assert.match(api, /imageUrl:product\.image_url/);
  assert.match(api, /rpc\('save_product_v3'/);
  assert.match(api, /URL foto produk harus memakai http atau https/);
});
