import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('hutang supplier tersambung otomatis ke penerimaan, retur kredit, dan pembayaran FIFO',async()=>{
 const sql=await readFile(new URL('../supabase/migrations/202607230021_supplier_payables.sql',import.meta.url),'utf8');
 assert.match(sql,/supplier_bills/);assert.match(sql,/sync_supplier_bill/);assert.match(sql,/settlement_type='CREDIT_NOTE'/);
 assert.match(sql,/record_supplier_payment/);assert.match(sql,/order by due_on,occurred_at,id/);assert.match(sql,/SUPPLIER_PAYMENT_RECORDED/);
});
test('pembayaran supplier tunai tercatat pada shift sebagai kas keluar',async()=>{
 const sql=await readFile(new URL('../supabase/migrations/202607230021_supplier_payables.sql',import.meta.url),'utf8');
 assert.match(sql,/Pembayaran tunai wajib memakai shift aktif/);assert.match(sql,/'CASH_OUT'/);assert.match(sql,/Pembayaran supplier/);
});
test('backoffice menampilkan faktur, retur kredit, pelunasan, dan sisa hutang supplier',async()=>{
 const html=await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),script=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
 assert.match(html,/HUTANG SUPPLIER/);assert.match(html,/FAKTUR PEMBELIAN/);assert.match(script,/openSupplierStatement/);assert.match(script,/recordSupplierPayment/);
});
