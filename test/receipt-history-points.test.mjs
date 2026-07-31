import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildEscPosReceipt } from '../apps/web/escpos-printer.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('API riwayat struk menyertakan poin transaksi dan saldo pelanggan', async () => {
  const api = await read('../api/index.mjs');
  assert.match(api, /byChunks\('customer_point_entries','sale_id',saleIds/);
  assert.match(api, /entry_type==='EARN'/);
  assert.match(api, /pointsEarned:Number\(sale\.points_earned\?\?pointEntry\?\.points\?\?0\)/);
  assert.match(api, /pointsBalanceIsCurrent:!pointEntry&&Boolean\(customer\)/);
  assert.match(api, /sourceSystem:sale\.source_system\?\?'NUSA'/);
});

test('struk thermal membedakan poin Nusa dan saldo impor Kaspin', () => {
  const base = {
    receiptNo:'UTM-1',
    occurredAt:'2026-07-31T00:00:00.000Z',
    cashier:'Ayu',
    customer:{name:'Budi',group_id:'member'},
    business:{name:'Nusa POS',receiptLayout:{showLoyaltyPoints:true}},
    outlet:{name:'Toko Utama'},
    quote:{lines:[],subtotal:0,discountTotal:0,grandTotal:0}
  };
  const earned = new TextDecoder().decode(buildEscPosReceipt({
    ...base,pointsEarned:5,pointsBalance:25,pointsBalanceIsCurrent:false,sourceSystem:'NUSA'
  }));
  const kaspin = new TextDecoder().decode(buildEscPosReceipt({
    ...base,pointsEarned:0,pointsBalance:20,pointsBalanceIsCurrent:true,sourceSystem:'KASPIN'
  }));
  assert.match(earned, /Poin \+5 \| Saldo 25/);
  assert.match(kaspin, /Saldo poin saat ini 20 \(Kaspin\)/);
});

test('tampilan riwayat menjelaskan saldo pelanggan Kaspin', async () => {
  const app = await read('../apps/web/app.js');
  assert.match(app, /Saldo poin saat ini/);
  assert.match(app, /Saldo setelah transaksi/);
  assert.match(app, /data pelanggan Kaspin/);
});
