import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const migration=await readFile(new URL('../supabase/migrations/202608070001_catalog_manage_product_permissions.sql',import.meta.url),'utf8');
const api=await readFile(new URL('../api/index.mjs',import.meta.url),'utf8');

test('izin Produk & harga berlaku sampai fungsi database simpan produk',()=>{
  assert.match(migration,/create or replace function public\.can_manage_product_catalog_v1/);
  assert.match(migration,/tenant_id=p_tenant_id[\s\S]*user_id=p_actor_id[\s\S]*active=true/);
  assert.match(migration,/when custom_permissions is null then role='MANAGER'/);
  assert.match(migration,/'catalog\.manage'=any\(custom_permissions\)/);
  assert.match(migration,/function public\.save_product_v2[\s\S]*can_manage_product_catalog_v1\(p_tenant_id,p_actor_id\)/);
  assert.match(migration,/function public\.set_product_active[\s\S]*can_manage_product_catalog_v1\(p_tenant_id,p_actor_id\)/);
  assert.match(migration,/revoke all on function public\.can_manage_product_catalog_v1[\s\S]*grant execute[\s\S]*to service_role/);
});

test('operasi destruktif hapus massal tetap khusus Owner atau Admin',()=>{
  assert.match(api,/route==='products\/bulk-delete'[\s\S]*\['OWNER','ADMIN'\]\.includes\(session\.profile\.role\)/);
});
