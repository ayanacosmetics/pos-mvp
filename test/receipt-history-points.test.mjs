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
  assert.match(api, /reconstructedPointBalance==null&&!pointEntry&&Boolean\(customer\)/);
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
  assert.match(earned, /Poin bertambah\s+\+5/);
  assert.match(earned, /Saldo setelah transaksi\s+25/);
  assert.match(kaspin, /Poin bertambah\s+-/);
  assert.match(kaspin, /Saldo impor saat ini\s+20/);
});

test('tampilan riwayat menjelaskan saldo pelanggan Kaspin', async () => {
  const app = await read('../apps/web/app.js');
  assert.match(app, /Saldo poin saat ini/);
  assert.match(app, /Saldo poin setelah transaksi/);
  assert.match(app, /Saldo poin impor saat ini/);
});

test('detail pelanggan menampilkan riwayat mutasi poin beserta struk dan pelaku', async () => {
  const [api,app,html] = await Promise.all([
    read('../api/index.mjs'),read('../apps/web/app.js'),read('../apps/web/index.html')
  ]);
  assert.match(api, /receiptNo:sales\.find/);
  assert.match(api, /actor:actors\.find/);
  assert.match(html, /id="statement-points"/);
  assert.match(app, /Detail & log poin/);
  assert.match(app, /Saldo setelah mutasi/);
  assert.match(app, /Pembalikan transaksi/);
});

test('poin impor Kaspin direkonstruksi per struk tanpa mengubah saldo akhir', async () => {
  const migration = await read('../supabase/migrations/202607310056_kaspin_point_history_reconstruction.sql');
  assert.match(migration, /floor\(greatest\(v_sale\.grand_total,0\)\/10000\)/);
  assert.match(migration, /pointsBalanceAfter/);
  assert.match(migration, /v_difference:=v_target_balance-v_running_balance/);
  assert.match(migration, /Penyesuaian selisih saldo impor Kasir Pintar/);
  assert.match(migration, /not exists\([\s\S]*ps\.source_system='KASPIN'/);
});
