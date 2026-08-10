import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('product create form offers permission-scoped opening stock and cost',async()=>{
  const [html,app,api]=await Promise.all([read('apps/web/index.html'),read('apps/web/app.js'),read('api/index.mjs')]);
  for(const id of ['product-opening-section','new-add-opening-stock','new-opening-location','new-opening-qty','new-opening-cost','new-opening-batch','new-opening-expiry']){
    assert.match(html,new RegExp(`id="${id}"`));
  }
  assert.match(app,/!product&&state\.session\.permissions\.includes\('inventory\.manage'\)/);
  assert.match(app,/function productOpeningPayload\(\)/);
  assert.match(api,/requirePermission\(session,'inventory\.manage'\);\s+if\(!input\.trackStock\)/);
  assert.match(api,/requireLocationAccess\(context,locationId\)/);
  assert.match(api,/rpc\('save_product_with_opening_stock_v1'/);
});

test('opening cost is write-only for inventory staff without cost visibility',async()=>{
  const [sql,api]=await Promise.all([
    read('supabase/migrations/202608100003_write_only_opening_cost.sql'),read('api/index.mjs')
  ]);
  assert.match(sql,/profile_has_permission_v1\(p_tenant_id,p_actor_id,'catalog\.manage'\)/);
  assert.match(sql,/profile_has_permission_v1\(p_tenant_id,p_actor_id,'inventory\.manage'\)/);
  assert.doesNotMatch(sql,/profile_has_permission_v1\(p_tenant_id,p_actor_id,'purchasing\.view_cost'\)/);
  assert.match(api,/includeCost:session\.permissions\.includes\('purchasing\.view_cost'\)/);
  assert.match(api,/const canViewCost=session\.permissions\.includes\('purchasing\.view_cost'\)/);
});

test('opening stock SQL is atomic, new-product-only, and audited through stock adjustment',async()=>{
  const sql=await read('supabase/migrations/202608100002_product_opening_stock.sql');
  assert.match(sql,/function public\.save_product_with_opening_stock_v1/);
  assert.match(sql,/Stok awal hanya dapat diisi saat membuat produk baru/);
  assert.match(sql,/profile_has_permission_v1\(p_tenant_id,p_actor_id,'inventory\.manage'\)/);
  assert.match(sql,/profile_has_permission_v1\(p_tenant_id,p_actor_id,'purchasing\.view_cost'\)/);
  assert.match(sql,/v_result:=public\.save_product_v6/);
  assert.match(sql,/v_adjustment:=public\.adjust_product_stock_v1/);
  assert.match(sql,/begin;[\s\S]*commit;/);
});

test('new catalog products expose their main barcode and receive a server-generated SKU',async()=>{
  const [html,app,api]=await Promise.all([read('apps/web/index.html'),read('apps/web/app.js'),read('api/index.mjs')]);
  assert.match(html,/Barcode utama<input id="new-barcode"/);
  assert.doesNotMatch(html,/id="new-sku" required/);
  assert.match(app,/el\('new-sku'\)\.readOnly=!product/);
  assert.match(app,/baseUnit\.barcode=el\('new-barcode'\)\.value\.trim\(\)/);
  assert.match(api,/rawInput\.sku=`PRD-\$\{crypto\.randomUUID\(\)/);
});

test('product editor puts a compact photo block before identity and removes verbose guidance',async()=>{
  const [html,css]=await Promise.all([read('apps/web/index.html'),read('apps/web/styles.css')]);
  assert.ok(html.indexOf('product-editor-media-section')<html.indexOf('IDENTITAS BARANG'));
  assert.match(html,/FOTO PRODUK[\s\S]*Pilih foto/);
  assert.doesNotMatch(html,/Setiap varian mempunyai SKU, barcode, harga, dan stok sendiri/);
  assert.doesNotMatch(html,/Setiap tipe dimulai dari minimal 1 pcs/);
  assert.match(css,/\.product-editor-media-section\.product-photo-editor/);
});
