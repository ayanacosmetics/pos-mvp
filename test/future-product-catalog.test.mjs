import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('katalog masa depan memisahkan etalase, barcode bersama, opsi, dan SKU jual',async()=>{
  const [sql,api,app,html]=await Promise.all([
    read('supabase/migrations/202608010005_future_product_catalog.sql'),
    read('api/index.mjs'),read('apps/web/app.js'),read('apps/web/index.html')
  ]);
  for(const table of ['product_families','product_family_barcodes','product_variant_options'])assert.match(sql,new RegExp(`create table if not exists public\\.${table}`));
  assert.match(sql,/alter table public\.products add column if not exists family_id/);
  assert.match(sql,/alter table public\.products add column if not exists legacy_code/);
  assert.match(sql,/create or replace function public\.import_product_catalog_v1/);
  assert.match(sql,/create or replace function public\.reset_tenant_data_v2/);
  assert.match(sql,/create or replace function public\.save_employee_shift_rule_v2/);
  assert.match(api,/PRODUCT_FAMILIES','PRODUCT_UNITS','PRODUCT_VARIANTS','PRODUCT_OPTIONS/);
  assert.match(api,/import_product_catalog_v1/);
  assert.match(api,/familyBarcodes:/);
  assert.match(api,/variantOptions:/);
  assert.match(api,/function kaspinProductResolver/);
  assert.match(api,/resolveProduct\(productCode,raw\.productName\)/);
  assert.match(app,/function sharedBarcodeProducts/);
  assert.match(app,/function openVariantPicker/);
  assert.match(app,/data-family=/);
  for(const id of ['variant-picker-dialog','variant-picker-options','kaspin-use-internal-sku'])assert.ok(html.includes(`id="${id}"`));
});

test('barcode SKU selalu dicari sebelum barcode bersama dan pemindaian bersama meminta pilihan',async()=>{
  const [app,api]=await Promise.all([read('apps/web/app.js'),read('api/index.mjs')]);
  const camera=app.slice(app.indexOf('async function handleCameraBarcode'),app.indexOf('function stopBarcodeCamera'));
  assert.ok(camera.indexOf('barcodeMatch(value)')<camera.indexOf('sharedBarcodeProducts(value)'));
  assert.match(camera,/openVariantPicker\(familyMatches,\{target:barcodeCameraTarget,sharedBarcode:true\}\)/);
  assert.match(api,/Barcode .* adalah barcode bersama etalase/);
});
