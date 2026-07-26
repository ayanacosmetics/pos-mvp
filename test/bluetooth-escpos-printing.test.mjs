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
  assert.match(script, /Struk tetap tersimpan dan dapat dicetak ulang/);
  assert.match(printer, /navigator\.serial\.requestPort\(\)/);
  assert.match(printer, /activePort\.open\(\{ baudRate: 9600 \}\)/);
  assert.match(printer, /writer\.write/);
  assert.match(worker, /escpos-printer\.mjs/);
});
