import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);

test('pelanggan Kaspin memakai tipe harga dinamis dan membawa poin',async()=>{
  const [sql,api,app]=await Promise.all([
    readFile(new URL('supabase/migrations/202607310054_kaspin_customer_import.sql',root),'utf8'),
    readFile(new URL('api/index.mjs',root),'utf8'),
    readFile(new URL('apps/web/app.js',root),'utf8')
  ]);
  assert.match(sql,/create or replace function public\.import_kaspin_customers_v1/);
  assert.match(sql,/customer_price_groups/);
  assert.match(sql,/group_id=v_group_id/);
  assert.match(sql,/customer_point_entries/);
  assert.match(sql,/Saldo poin awal dari Kasir Pintar/);
  assert.match(api,/import_kaspin_customers_v1/);
  assert.match(api,/input\.source.*KASPIN/);
  assert.match(app,/parseKaspinCustomerWorkbook/);
  assert.match(app,/loyaltyPoints/);
});
