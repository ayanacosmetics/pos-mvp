import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=(path)=>readFile(new URL(path,import.meta.url),'utf8');

test('Blueprint varian berdiri di luar UUID produk operasional dan hanya dapat diakses service role',async()=>{
  const sql=await read('../supabase/migrations/202608020012_catalog_variant_blueprint.sql');
  assert.match(sql,/create table if not exists public\.catalog_family_blueprints/);
  assert.match(sql,/create table if not exists public\.catalog_variant_blueprints/);
  assert.match(sql,/unique\(tenant_id,source_system,source_key\)/);
  assert.match(sql,/source_legacy_code text/);
  assert.match(sql,/last_product_id uuid,/);
  assert.doesNotMatch(sql,/last_product_id uuid references public\.products/);
  assert.match(sql,/alter table public\.catalog_variant_blueprints enable row level security/);
  assert.match(sql,/grant select,insert,update,delete on public\.catalog_variant_blueprints to service_role/);
});

test('reset katalog menyimpan Blueprint sebelum produk dan keluarga operasional dihapus',async()=>{
  const sql=await read('../supabase/migrations/202608020012_catalog_variant_blueprint.sql');
  const reset=sql.slice(sql.lastIndexOf('create or replace function public.reset_tenant_data_v2'));
  assert.ok(reset.indexOf('sync_catalog_variant_blueprint_v1')<reset.indexOf('reset_tenant_data_v1'));
  assert.ok(reset.indexOf('reset_tenant_data_v1')<reset.indexOf('delete from public.product_families'));
  assert.match(reset,/variantBlueprintPreserved',true/);
});

test('penerapan Blueprint mengutamakan SKU sumber dan menolak fallback legacy yang ambigu',async()=>{
  const sql=await read('../supabase/migrations/202608020012_catalog_variant_blueprint.sql');
  assert.match(sql,/upper\(sku\)=upper\(v_blueprint\.source_key\)/);
  assert.match(sql,/select count\(\*\) into v_legacy_matches/);
  assert.match(sql,/v_legacy_matches>1[\s\S]*last_match_status='AMBIGUOUS'/);
  assert.match(sql,/last_match_status='UNMATCHED'/);
  assert.match(sql,/last_match_status='MATCHED'/);
});

test('impor Kaspin menerapkan ulang Blueprint dan UI menjelaskan bahwa reset tidak menghapusnya',async()=>{
  const [api,app,html]=await Promise.all([read('../api/index.mjs'),read('../apps/web/app.js'),read('../apps/web/index.html')]);
  assert.match(api,/apply_catalog_variant_blueprint_v1/);
  assert.match(api,/sync_catalog_variant_blueprint_v1/);
  assert.match(api,/route==='imports\/catalog-blueprint'/);
  assert.match(app,/Blueprint:.*cocok/);
  assert.match(app,/Blueprint etalase\/varian tetap disimpan/);
  assert.match(html,/Blueprint etalase\/varian Kaspin/);
  assert.match(html,/id="kaspin-blueprint-status"/);
});
