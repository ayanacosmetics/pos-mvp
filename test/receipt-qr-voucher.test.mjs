import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildEscPosReceipt } from '../apps/web/escpos-printer.mjs';

const root=new URL('../',import.meta.url);
const read=(path)=>readFile(new URL(path,root),'utf8');

test('receipt voucher migration creates unique ten-character one-time codes',async()=>{
  const sql=await read('supabase/migrations/202607280041_receipt_qr_vouchers.sql');
  assert.match(sql,/receipt_voucher_campaigns/);
  assert.match(sql,/generate_series\(1,10\)/);
  assert.match(sql,/usage_limit_total,usage_limit_per_customer/);
  assert.match(sql,/1,1,'ALL',true,true/);
  assert.match(sql,/receipt_voucher_sale_campaign_key/);
  assert.match(sql,/issue_receipt_voucher_v1/);
  assert.match(sql,/cancel_receipt_vouchers_for_sale_v1/);
});

test('checkout issues voucher and POS recognizes scanned QR code',async()=>{
  const [api,app,html]=await Promise.all([read('api/index.mjs'),read('apps/web/app.js'),read('apps/web/index.html')]);
  assert.match(api,/issue_receipt_voucher_v1/);
  assert.match(api,/issuedVoucher/);
  assert.match(api,/receipt-voucher-campaigns/);
  assert.match(app,/tryScannedVoucher/);
  assert.match(app,/\^\[A-Z0-9\]\{10\}\$/);
  assert.match(app,/BrowserQRCodeSvgWriter/);
  assert.match(app,/const form=event\.currentTarget/);
  assert.match(app,/form\.reset\(\)/);
  assert.match(html,/receipt-voucher-campaign-form/);
});

test('thermal receipt contains native ESC POS QR commands and readable code',()=>{
  const bytes=buildEscPosReceipt({
    receiptNo:'TEST-1',occurredAt:'2026-07-28T00:00:00.000Z',quote:{lines:[],subtotal:100000,discountTotal:0,grandTotal:100000},
    issuedVoucher:{code:'A7K9M2Q4XZ',name:'Kembali belanja',discountType:'FIXED',discountValue:10000,minPurchase:100000,startsAt:'2026-07-29T00:00:00.000Z',endsAt:'2026-08-12T00:00:00.000Z'}
  },[],{paperWidth:58},{business:{name:'Toko'},outlet:{name:'Utama'}});
  const text=new TextDecoder().decode(bytes);
  assert.match(text,/A7K9M2Q4XZ/);
  assert.match(text,/VOUCHER BELANJA BERIKUTNYA/);
  assert.ok(bytes.some((value,index)=>value===0x1d&&bytes[index+1]===0x28&&bytes[index+2]===0x6b));
});
