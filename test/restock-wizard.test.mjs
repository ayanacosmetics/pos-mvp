import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, app, css] = await Promise.all([
  readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8')
]);

test('penerimaan restok dibagi menjadi empat layar bertahap', () => {
  for (const step of ['document','items','review','history']) {
    assert.match(html, new RegExp(`data-restock-step-target="${step}"`));
    assert.match(html, new RegExp(`data-restock-step="${step}"`));
  }
  assert.match(html, /id="restock-wizard-back"/);
  assert.match(html, /id="restock-wizard-next"/);
  assert.match(html, /Langkah 1 dari 4/);
});

test('wizard memvalidasi dokumen dan barang sebelum maju', () => {
  assert.match(app, /function restockStepIsValid/);
  assert.match(app, /Isi nomor faktur sebelum melanjutkan/);
  assert.match(app, /Tambahkan minimal satu barang sebelum melanjutkan/);
  assert.match(app, /Periksa jumlah, modal, dan tanggal EXP setiap barang/);
  assert.match(app, /function moveRestockWizard/);
});

test('tahap periksa membangun ringkasan tanpa memindahkan input transaksi', () => {
  assert.match(html, /id="restock-review-list"/);
  assert.match(app, /function renderRestockReview/);
  assert.match(app, /restock-review-row/);
  assert.match(app, /setRestockWizardStep\('history'\)/);
});

test('pemilih barang tambahan ringkas dan dapat membuat draft produk tanpa scan', () => {
  assert.match(html, /id="toggle-restock-extra-product"/);
  assert.match(html, /id="restock-extra-product-picker" class="purchase-product-picker hidden"/);
  assert.match(html, /id="restock-new-product-dialog"/);
  assert.match(html, /id="open-restock-new-product"/);
  assert.match(html, /Tambahkan ke draft/);
  assert.match(app, /function setRestockExtraPicker/);
  assert.match(app, /function openRestockNewProduct/);
  assert.match(app, /function saveRestockNewProduct/);
  assert.match(app, /SKU atau barcode sudah dipakai/);
  assert.match(app, /appendRestockNewLine\(productKey,payload\)/);
  assert.match(app, /function generateInternalBarcode/);
  assert.match(app, /barcodeCameraTarget==='restock'[\s\S]*openRestockNewProduct\(value\)/);
});

test('desktop membatasi daftar di panel dan mobile mempertahankan navigasi lanjut', () => {
  assert.match(css, /\.restock-wizard-panel\{min-height:/);
  assert.match(css, /\.restock-wizard-panel \.restock-list\{[\s\S]*max-height:calc\(100dvh - 420px\)/);
  assert.match(css, /\.restock-wizard-actions\{[\s\S]*position:sticky/);
  assert.match(css, /@media\(max-width:760px\)[\s\S]*\.restock-wizard-steps\{display:flex;overflow-x:auto/);
  assert.match(app, /steps\?\.scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/);
  assert.match(css, /scroll-margin-top:76px/);
});

test('pesan gagal penerimaan tidak tertutup aksi wizard pada mobile', () => {
  assert.match(html, /id="restock-receive-error"[\s\S]*role="alert"/);
  assert.match(app, /targetIndex === 2 \? \(\[\.\.\.document\.querySelectorAll\('\.restock-line'\)\]/);
  assert.match(app, /state\.restockWizardStep === 'review'\) return receivePurchase\(\)/);
  assert.match(app, /function showRestockReceiveError/);
  assert.match(css, /\.toast\{z-index:100\}/);
  assert.match(css, /bottom:calc\(82px \+ env\(safe-area-inset-bottom\)\)/);
});
