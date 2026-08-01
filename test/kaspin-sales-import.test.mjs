import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);

test('impor riwayat penjualan Kaspin membuat detail struk tanpa mengubah stok',async()=>{
  const [sql,completeSql,api,html,app]=await Promise.all([
    readFile(new URL('supabase/migrations/202607310053_kaspin_sales_import.sql',root),'utf8'),
    readFile(new URL('supabase/migrations/202608020006_kaspin_complete_sales_history.sql',root),'utf8'),
    readFile(new URL('api/index.mjs',root),'utf8'),
    readFile(new URL('apps/web/index.html',root),'utf8'),
    readFile(new URL('apps/web/app.js',root),'utf8')
  ]);
  assert.match(sql,/create or replace function public\.import_kaspin_sales_v1/);
  assert.match(sql,/source_system='KASPIN'/);
  assert.match(sql,/external_reference/);
  assert.match(sql,/insert into public\.sale_items/);
  assert.match(sql,/insert into public\.payments/);
  assert.match(sql,/'stockQuantityChanged',false/);
  assert.doesNotMatch(sql,/insert into public\.stock_ledger/i);
  assert.doesNotMatch(sql,/update public\.stock_balances/i);
  assert.match(completeSql,/receiptOnly/);
  assert.match(completeSql,/legacyLines/);
  assert.match(completeSql,/sourceProfit/);
  assert.match(completeSql,/v_status='VOIDED'/);
  assert.doesNotMatch(completeSql,/insert into public\.stock_ledger/i);
  assert.doesNotMatch(completeSql,/update public\.stock_balances/i);
  assert.match(api,/previewKaspinSales/);
  assert.match(api,/import_kaspin_sales_v1/);
  assert.match(html,/value="KASPIN_SALES"/);
  assert.match(app,/Laporan Data Penjualan yang memuat ID Struk/);
});
