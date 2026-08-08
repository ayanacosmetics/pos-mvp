import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildEscPosReceipt } from '../apps/web/escpos-printer.mjs';

test('struk ESC/POS berisi data pelanggan tanpa membocorkan penyesuaian harga internal', () => {
  const bytes = buildEscPosReceipt({
    receiptNo: 'UTM-000123',
    occurredAt: '2026-07-26T10:00:00.000Z',
    cashier: 'Owner',
    customer: { name: 'Ayu' },
    quote: {
      lines: [{
        productName: 'Lip Tint Rose', qty: 1, unitName: 'pcs',
        gross: 25000, total: 23000,
        promotions: [{ manual: true, discount: 2000, name: 'RAHASIA MODAL' }]
      }],
      subtotal: 25000, discountTotal: 2000, grandTotal: 23000,
      manualAdjustment: { scope: 'LINE' }
    }
  }, [{ method: 'CASH', amount: 23000 }], { paperWidth: 58 }, {
    business: { name: 'Ayana Cosmetics', receiptFooter: 'Terima kasih' },
    outlet: { name: 'Toko Utama' }
  });
  const text = new TextDecoder().decode(bytes);
  assert.equal(bytes[0], 0x1b);
  assert.equal(bytes[1], 0x40);
  assert.match(text, /UTM-000123/);
  assert.match(text, /Lip Tint Rose/);
  assert.match(text, /Rp 23\.000/);
  assert.doesNotMatch(text, /RAHASIA|penyesuaian|modal/i);
});

test('struk ESC/POS mencantumkan kode dan potongan promo pada produk terkait', () => {
  const bytes = buildEscPosReceipt({
    receiptNo:'UTM-000126',occurredAt:'2026-08-08T10:00:00.000Z',cashier:'Kasir',
    quote:{lines:[{
      productName:'Lip Tint Rose',qty:2,unitName:'pcs',gross:50000,discount:10000,total:40000,
      promotions:[{id:'promo-1',code:'LIP20',version:1,discount:10000,reason:'Diskon produk'}]
    }],subtotal:50000,discountTotal:10000,grandTotal:40000}
  },[],{paperWidth:58},{business:{name:'Ayana Cosmetics'},outlet:{name:'Toko Utama'}});
  const text=new TextDecoder().decode(bytes);
  assert.match(text,/Promo LIP20: -Rp 10\.000/);
  assert.match(text,/Promo & diskon\s+-Rp 10\.000/);
});

test('cetak ulang ESC/POS menandai barang dan total yang sudah diretur', () => {
  const bytes=buildEscPosReceipt({
    receiptNo:'UTM-000124',occurredAt:'2026-07-28T10:00:00.000Z',cashier:'Kasir',
    returnStatus:'PARTIALLY_RETURNED',returnTotal:25000,netTotal:25000,
    quote:{lines:[{productName:'Lip Tint Rose',qty:2,unitName:'pcs',gross:50000,total:50000,returnedQty:1,returnedTotal:25000}],subtotal:50000,discountTotal:0,grandTotal:50000}
  },[],{paperWidth:58},{business:{name:'Ayana Cosmetics'},outlet:{name:'Toko Utama'}});
  const text=new TextDecoder().decode(bytes);
  assert.match(text,/DIRETUR SEBAGIAN/);
  assert.match(text,/Diretur 1 pcs/);
  assert.match(text,/RETUR \/ REFUND/);
  assert.match(text,/TOTAL SETELAH RETUR/);
  assert.match(text,/Rp 25\.000/);
});

test('struk tunai membedakan total, uang diterima, dan kembalian dengan benar', () => {
  const bytes=buildEscPosReceipt({
    receiptNo:'UTM-000125',occurredAt:'2026-08-06T11:42:22.000Z',cashier:'Alya',change:30000,
    quote:{lines:[{productName:'Minyak Kayu Putih',qty:1,unitName:'pcs',gross:22000,total:22000}],subtotal:22000,discountTotal:0,grandTotal:22000}
  },[{method:'CASH',amount:22000,tendered:30000}],{paperWidth:58},{business:{name:'Ayana Cosmetics'},outlet:{name:'Toko Utama'}});
  const text=new TextDecoder().decode(bytes);
  assert.match(text,/Tunai\s+Rp 22\.000/);
  assert.match(text,/Uang diterima\s+Rp 30\.000/);
  assert.match(text,/Kembalian\s+Rp 8\.000/);
  assert.doesNotMatch(text,/Kembalian\s+Rp 30\.000/);
});

test('UI printer Bluetooth Classic menyediakan koneksi, tes, status, dan fallback aman', async () => {
  const [html, script, worker, printer] = await Promise.all([
    readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/service-worker.js', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/escpos-printer.mjs', import.meta.url), 'utf8')
  ]);
  for (const id of ['printer-status','connect-printer','test-printer','disconnect-printer']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /printReceiptDirect/);
  assert.match(script, /receipt-line-promotion/);
  assert.match(script, /receiptPromotionLabel/);
  assert.match(script, /Struk tetap tersimpan dan dapat dicetak ulang/);
  assert.match(printer, /navigator\.serial\.requestPort\(\)/);
  assert.match(printer, /activePort\.open\(\{ baudRate: 9600 \}\)/);
  assert.match(printer, /writer\.write/);
  assert.match(worker, /escpos-printer\.mjs/);
});
