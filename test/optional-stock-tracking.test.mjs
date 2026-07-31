import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('database menyimpan aturan stok dan transaksi melewati mutasi untuk barang tanpa stok',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/202607310057_optional_stock_tracking.sql',import.meta.url),'utf8');
  assert.match(sql,/track_stock boolean not null default true/);
  assert.match(sql,/if v_product\.track_stock then/);
  assert.match(sql,/track_stock=true\) then continue/);
  assert.match(sql,/jsonb_build_object\('priceRuleId'.*'trackStock',v_product\.track_stock\)/s);
});

test('antarmuka produk dan Excel menjelaskan 0 tanpa stok serta 1 pakai stok',async()=>{
  const [html,app,workbook]=await Promise.all([
    readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/product-workbook.mjs',import.meta.url),'utf8')
  ]);
  assert.match(html,/id="new-track-stock"/);assert.match(html,/Tanpa stok/);
  assert.match(app,/aturan_stok:'trackStock'/);assert.match(app,/product\.trackStock!==false/);
  assert.match(workbook,/0 untuk barang\/jasa tanpa stok dan 1 untuk barang yang memakai stok/);
});
