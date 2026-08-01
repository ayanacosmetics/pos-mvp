import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);

test('impor pembelian Kaspin membangun FIFO tanpa menambah stock_balances.quantity',async()=>{
  const [sql,optimizedSql,api,html,app]=await Promise.all([
    readFile(new URL('supabase/migrations/202607300052_kaspin_fifo_purchase_import.sql',root),'utf8'),
    readFile(new URL('supabase/migrations/202608020008_optimize_kaspin_fifo_import.sql',root),'utf8'),
    readFile(new URL('api/index.mjs',root),'utf8'),
    readFile(new URL('apps/web/index.html',root),'utf8'),
    readFile(new URL('apps/web/app.js',root),'utf8')
  ]);
  assert.match(sql,/create or replace function public\.import_kaspin_fifo_v1/);
  assert.match(sql,/The stock balance quantity is never changed/);
  assert.doesNotMatch(sql,/set\s+quantity\s*=/i);
  assert.match(sql,/order by received_at desc,id desc/);
  assert.match(sql,/KASPIN_FIFO_RECONCILE/);
  assert.match(sql,/stockQuantityChanged',false/);
  assert.match(optimizedSql,/create temporary table kaspin_fifo_rows_stage/);
  assert.match(optimizedSql,/create index on kaspin_fifo_capital_stage\(product_id\)/);
  assert.match(optimizedSql,/insert into public\.purchase_receipt_items[\s\S]*from kaspin_fifo_rows_stage source/);
  assert.doesNotMatch(optimizedSql,/for v_row in select value from jsonb_array_elements\(p_rows\)/);
  assert.doesNotMatch(optimizedSql,/set\s+quantity\s*=/i);
  assert.match(api,/previewKaspinFifo/);
  assert.match(api,/import_kaspin_fifo_v1/);
  assert.match(html,/value="KASPIN_FIFO"/);
  assert.match(html,/id="import-capital-file"/);
  assert.match(app,/Pilih juga file Laporan_Modal\.xlsx/);
});
