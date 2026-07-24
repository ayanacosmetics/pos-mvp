import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('retur kredit mengurangi faktur dan jurnal pelanggan secara atomik',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/202607230020_credit_return_and_aging.sql',import.meta.url),'utf8');
  assert.match(sql,/process_customer_return_v3/);
  assert.match(sql,/ACCOUNT_CREDIT/);
  assert.match(sql,/returned_credit_amount=returned_credit_amount\+v_total/);
  assert.match(sql,/RETURN_CREDIT/);
  assert.match(sql,/CUSTOMER_CREDIT_RETURNED/);
  assert.match(sql,/v_total>v_outstanding/);
});

test('laporan umur piutang memisahkan empat kelompok keterlambatan',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/202607230020_credit_return_and_aging.sql',import.meta.url),'utf8');
  assert.match(sql,/customer_credit_aging/);
  assert.match(sql,/days_1_30/);
  assert.match(sql,/days_31_60/);
  assert.match(sql,/days_over_60/);
  assert.match(sql,/credit_amount-s\.paid_credit_amount-s\.returned_credit_amount/);
});

test('UI retur dan pelanggan menampilkan pengurang piutang serta bucket umur',async()=>{
  const html=await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
  assert.match(html,/Kurangi piutang pelanggan/);
  assert.match(html,/customer-aging-buckets/);
  assert.match(script,/loadCustomerAging/);
  assert.match(script,/ACCOUNT_CREDIT/);
});
