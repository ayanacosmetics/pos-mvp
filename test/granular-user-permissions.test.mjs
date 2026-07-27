import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('hak akses per akun tersimpan aman dan tidak dapat memberi hak khusus Owner',async()=>{
  const [migration,api]=await Promise.all([
    read('supabase/migrations/202607270037_custom_permissions.sql'),
    read('api/index.mjs')
  ]);
  assert.match(migration,/add column if not exists custom_permissions text\[\]/);
  assert.match(migration,/manage_profile_access_v2/);
  assert.match(migration,/Hanya Owner yang dapat mengelola user|manage_profile_access\(/);
  assert.doesNotMatch(migration,/finance\.owner|identity\.manage|pilot\.manage/);
  assert.match(api,/function effectivePermissions/);
  assert.match(api,/ASSIGNABLE_PERMISSIONS/);
  assert.match(api,/rpc\('manage_profile_access_v2'/);
  assert.match(api,/customPermissions:profile\.custom_permissions/);
});

test('diskon dan void memakai izin akun tanpa meminta sandi Owner',async()=>{
  const [html,script,api]=await Promise.all([
    read('apps/web/index.html'),read('apps/web/app.js'),read('api/index.mjs')
  ]);
  for(const id of ['new-user-permissions','edit-user-permissions'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(script,/\['sale\.adjust','Ubah harga & diskon manual'/);
  assert.match(script,/\['sale\.void','Void transaksi'/);
  assert.match(api,/requirePermission\(session, 'sale\.adjust'\)/);
  assert.match(api,/requirePermission\(session, 'sale\.void'\)/);
  assert.doesNotMatch(html,/id="approver-password"|id="void-approver-password"/);
  assert.doesNotMatch(script,/approverPassword|void-approver-password/);
  assert.doesNotMatch(api,/grant_type=password[\s\S]{0,500}sale-authorizations/);
});
