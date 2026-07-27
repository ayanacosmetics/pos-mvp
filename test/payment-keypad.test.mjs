import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appendMoneyKey, suggestedCashAmounts } from '../apps/web/payment-keypad.mjs';

test('keypad nominal menambah, menghapus, dan membersihkan angka secara deterministik', () => {
  assert.equal(appendMoneyKey(0, '5'), 5);
  assert.equal(appendMoneyKey(5, '000'), 5000);
  assert.equal(appendMoneyKey(5000, 'BACKSPACE'), 500);
  assert.equal(appendMoneyKey(500, 'CLEAR'), 0);
  assert.equal(appendMoneyKey(999999999, '9'), 999999999);
});

test('saran tunai selalu memuat uang pas dan pembulatan pecahan praktis', () => {
  assert.deepEqual(suggestedCashAmounts(25000), [25000, 30000, 40000, 50000]);
  assert.deepEqual(suggestedCashAmounts(37000), [37000, 40000, 50000, 100000]);
});

test('keranjang dan pembayaran menyediakan uang pas serta keypad sentuh offline', async () => {
  const [html, app, css, worker] = await Promise.all([
    readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/service-worker.js', import.meta.url), 'utf8')
  ]);
  assert.match(html, /id="exact-cash-button"[^>]*>Uang pas/);
  assert.match(html, /id="cash-keypad"/);
  assert.match(html, /data-cash-key="000"/);
  assert.match(app, /function renderCashKeypad/);
  assert.match(app, /appendMoneyKey/);
  assert.match(app, /exact-cash-button.*openPaymentDialog/);
  assert.match(css, /\.cash-key-grid\{/);
  assert.match(css, /\.exact-cash-button\{/);
  assert.match(worker, /\/payment-keypad\.mjs/);
});
