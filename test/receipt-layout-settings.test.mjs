import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildEscPosReceipt } from '../apps/web/escpos-printer.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const sampleReceipt = (receiptLayout = {}) => ({
  receiptNo:'UTM-000128',
  occurredAt:'2026-07-28T10:00:00.000Z',
  cashier:'Ayu',
  customer:{name:'Budi',group_id:'member'},
  customerGroupId:'member',
  notes:'Titip diambil sore',
  pointsEarned:2,
  pointsBalance:48,
  business:{
    name:'Kasir Nusa POS',
    phone:'08123456789',
    address:'Jalan Melati 1',
    receiptFooter:'Terima kasih',
    receiptLayout
  },
  outlet:{name:'Toko Utama'},
  quote:{
    lines:[{productName:'Lip Tint Rose',qty:1,unitName:'pcs',gross:25000,total:25000}],
    subtotal:25000,
    discountTotal:0,
    grandTotal:25000
  }
});

test('pengaturan desain struk tersedia, tervalidasi, dan disimpan per usaha', async () => {
  const [sql, api, html, app] = await Promise.all([
    read('../supabase/migrations/202607280039_receipt_layout_settings.sql'),
    read('../api/index.mjs'),
    read('../apps/web/index.html'),
    read('../apps/web/app.js')
  ]);
  assert.match(sql, /add column if not exists receipt_layout_json jsonb/);
  assert.match(sql, /function public\.save_receipt_layout_v1/);
  assert.match(sql, /v_actor\.role<>'OWNER'/);
  assert.match(api, /route === 'settings\/receipt'/);
  assert.match(api, /normalizeReceiptLayout/);
  assert.match(api, /normalizeReceiptLogo/);
  for (const id of [
    'receipt-settings-form','setting-receipt-logo-file','setting-receipt-logo-size',
    'receipt-show-business','receipt-show-price-type','receipt-design-preview'
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /receiptLogoFromFile/);
  assert.match(app, /buildReceiptMarkup/);
});

test('layout thermal menyembunyikan informasi yang dimatikan dan memakai kepala khusus', () => {
  const bytes = buildEscPosReceipt(sampleReceipt({
    customHeader:'Grosir & Eceran',
    headerAlignment:'left',
    separator:'double',
    showBusinessName:false,
    showOutletName:false,
    showAddress:false,
    showPhone:false,
    showDate:false,
    showReceiptNumber:false,
    showCashier:false,
    showCustomer:false,
    showPriceType:false,
    showPaymentDetail:false,
    showTransactionNote:false,
    showLoyaltyPoints:false
  }), [{method:'CASH',amount:25000}], {paperWidth:58}, {
    customerGroups:[{id:'member',name:'Member'}]
  });
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /Grosir & Eceran/);
  assert.match(text, /=+/);
  assert.doesNotMatch(text, /Kasir Nusa POS|Toko Utama|Jalan Melati|081234|UTM-000128/);
  assert.doesNotMatch(text, /Kasir|Pelanggan|Harga Member|CASH|Catatan|Poin/);
});

test('perintah raster logo ikut dalam data ESC/POS saat logo diaktifkan', () => {
  const raster = new Uint8Array([0x1d,0x76,0x30,0x00,0x01,0x00,0x01,0x00,0xff,0x0a]);
  const bytes = buildEscPosReceipt(sampleReceipt({showLogo:true}), [], {paperWidth:58}, {logoRaster:raster});
  const start = bytes.findIndex((value,index) => value===0x1d && bytes[index+1]===0x76 && bytes[index+2]===0x30);
  assert.ok(start > 0);
  assert.deepEqual([...bytes.slice(start,start+raster.length)],[...raster]);
});
