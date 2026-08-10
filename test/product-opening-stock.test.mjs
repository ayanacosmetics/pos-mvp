import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('product create form offers permission-scoped opening stock and cost',async()=>{
  const [html,app,api]=await Promise.all([read('apps/web/index.html'),read('apps/web/app.js'),read('api/index.mjs')]);
  for(const id of ['product-opening-section','new-add-opening-stock','new-opening-location','new-opening-qty','new-opening-cost','new-opening-batch','new-opening-expiry']){
    assert.match(html,new RegExp(`id="${id}"`));
  }
  assert.match(app,/!product&&state\.session\.permissions\.includes\('inventory\.manage'\)&&state\.session\.permissions\.includes\('purchasing\.view_cost'\)/);
  assert.match(app,/function productOpeningPayload\(\)/);
  assert.match(api,/requirePermission\(session,'inventory\.manage'\);requirePermission\(session,'purchasing\.view_cost'\)/);
  assert.match(api,/requireLocationAccess\(context,locationId\)/);
  assert.match(api,/rpc\('save_product_with_opening_stock_v1'/);
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
