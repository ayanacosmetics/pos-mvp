import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('akses staff dikelompokkan dan laporan dapat dipilih tersendiri',async()=>{
  const [app,html,styles]=await Promise.all([
    read('apps/web/app.js'),read('apps/web/index.html'),read('apps/web/styles.css')
  ]);
  assert.match(app,/\['reports','Laporan & Audit'/);
  assert.match(app,/\['report\.view','Laporan'/);
  assert.match(app,/data-permission-group=/);
  assert.match(app,/input\[data-permission\]:checked/);
  assert.match(html,/Hak akses per kelompok menu/);
  assert.match(styles,/\.permission-group\{/);
});

test('Admin dapat mengelola staff tanpa dapat mengubah Owner atau Admin',async()=>{
  const [api,migration]=await Promise.all([
    read('api/index.mjs'),read('supabase/migrations/202608010001_admin_staff_access.sql')
  ]);
  assert.match(api,/ADMIN: \[[^\n]*'identity\.manage_staff'/);
  assert.doesNotMatch(api,/ADMIN: \[[^\n]*'identity\.manage'/);
  assert.match(migration,/v_actor\.role not in \('OWNER','ADMIN'\)/);
  assert.match(migration,/Admin hanya dapat mengelola staff operasional/);
  assert.match(migration,/v_target\.role in \('OWNER','ADMIN'\)/);
});
