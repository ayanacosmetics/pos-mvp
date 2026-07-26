import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('fondasi piutang memakai jurnal, plafon, jatuh tempo, dan pelunasan FIFO',async()=>{
  const migration=await readFile(new URL('../supabase/migrations/202607230019_customer_credit_account.sql',import.meta.url),'utf8');
  assert.match(migration,/create table if not exists public\.customer_account_entries/);
  assert.match(migration,/create table if not exists public\.customer_payment_receipts/);
  assert.match(migration,/complete_sale_v5/);
  assert.match(migration,/v_balance\+v_credit>v_customer\.credit_limit/);
  assert.match(migration,/order by due_on asc nulls last,occurred_at asc/);
  assert.match(migration,/CUSTOMER_CREDIT_CREATED/);
  assert.match(migration,/CUSTOMER_PAYMENT_RECORDED/);
});

test('kas tunai pembayaran piutang masuk ke shift dan pembayaran non-tunai wajib bereferensi',async()=>{
  const migration=await readFile(new URL('../supabase/migrations/202607230019_customer_credit_account.sql',import.meta.url),'utf8');
  assert.match(migration,/Pembayaran tunai wajib memakai shift aktif pengguna/);
  assert.match(migration,/Pembayaran piutang/);
  assert.match(migration,/'CASH_IN'/);
  assert.match(migration,/Referensi pembayaran non-tunai wajib diisi/);
});

test('antarmuka menyediakan profil kredit, rekening pelanggan, faktur, dan pembayaran',async()=>{
  const html=await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
  const api=await readFile(new URL('../api/index.mjs',import.meta.url),'utf8');
  assert.match(html,/id="customer-credit-enabled"/);
  assert.match(html,/id="customer-statement-dialog"/);
  assert.match(html,/FAKTUR BELUM LUNAS/);
  assert.match(script,/openCustomerStatement/);
  assert.match(script,/recordCustomerPayment/);
  assert.match(api,/customer-payments/);
  assert.match(api,/complete_sale_v7/);
});
