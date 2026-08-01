import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [migration,api,app]=await Promise.all([
  readFile(new URL('../supabase/migrations/202607310055_kaspin_customer_sales_reconciliation.sql',import.meta.url),'utf8'),
  readFile(new URL('../api/index.mjs',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/app.js',import.meta.url),'utf8')
]);

test('struk Kaspin dicocokkan aman dengan email unik lalu nama unik tanpa email',()=>{
  assert.match(migration,/lower\(trim\(c\.email\)\)=lower\(trim\(s\.source_payload->>'customerEmail'\)\)/);
  assert.match(migration,/having count\(\*\)=1/);
  assert.match(migration,/nullif\(trim\(s\.source_payload->>'customerEmail'\),''\) is null/);
  assert.match(migration,/lower\(trim\(c\.name\)\)=lower\(trim\(s\.source_payload->>'customerName'\)\)/);
});

test('rekonsiliasi mengisi relasi dan menghitung ulang nilai transaksi pelanggan',()=>{
  assert.match(migration,/set customer_id=m\.customer_id,customer_group_id=c\.group_id/);
  assert.match(migration,/sum\(grand_total\) lifetime_spend,max\(occurred_at\) last_purchase_at/);
  assert.match(migration,/set lifetime_spend=t\.lifetime_spend,last_purchase_at=t\.last_purchase_at/);
  assert.match(migration,/set tier_id=/);
  assert.match(migration,/Repair tenants that imported sales before importing their customer directory/);
});

test('impor pelanggan berikutnya otomatis menjalankan rekonsiliasi dan memberi hasil',()=>{
  assert.match(api,/reconcile_kaspin_customer_sales_v1/);
  assert.match(api,/reconciliation/);
  assert.match(app,/struk lama terhubung ke pelanggan/);
});

test('impor penjualan dan alat migrasi dapat merekonsiliasi pelanggan setelah struk tersedia',()=>{
  assert.match(api,/preview\.kind==='KASPIN_SALES'[\s\S]*reconcileKaspinCustomerHistory\(context,session\)/);
  assert.match(api,/imports\/kaspin\/reconcile-customers/);
  assert.match(app,/reconcileKaspinCustomers/);
  assert.match(app,/Hubungkan riwayat pelanggan/);
});
