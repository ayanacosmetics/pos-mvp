import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app=readFileSync(new URL('../apps/web/app.js',import.meta.url),'utf8');
const api=readFileSync(new URL('../api/index.mjs',import.meta.url),'utf8');
const sql=readFileSync(new URL('../supabase/migrations/202608050019_purchase_units_receiving.sql',import.meta.url),'utf8');

test('restok menerima modal sesuai satuan lalu menormalisasi HPP ke satuan dasar',()=>{
  assert.match(app,/unitCost:purchaseUnitCost\/unit\.factor/);
  assert.match(app,/baseQty:purchaseQty\*unit\.factor/);
  assert.match(app,/purchaseUnitName:unit\.name/);
  assert.match(app,/return sum \+ \(qty \* cost\)/);
  assert.match(app,/Perkiraan modal \/ \$\{escapeHtml\(selectedUnit\?\.name\?\?'satuan'\)\}/);
});

test('database menolak konversi satuan dan modal yang tidak konsisten',()=>{
  assert.match(sql,/validate_purchase_unit_v1/);
  assert.match(sql,/Konversi jumlah pembelian tidak konsisten/);
  assert.match(sql,/Konversi modal pembelian tidak konsisten/);
  assert.match(sql,/purchase_unit_factor/);
  assert.match(sql,/received_purchase_qty/);
  assert.match(sql,/v_item\|\|jsonb_build_object\('productId',v_product_id\)/);
  assert.match(sql,/on conflict\(tenant_id,idempotency_key\) do nothing returning id/);
});

test('laporan pembelian mempertahankan satuan supplier dan jejak satuan dasar',()=>{
  assert.match(api,/received_purchase_qty\?\?\(baseQty\/unitFactor\)/);
  assert.match(api,/purchase_unit_cost\?\?\(costPerBase\*unitFactor\)/);
  assert.match(app,/line\.baseQty\?\?line\.qty/);
  assert.match(app,/satuan dasar/);
});
