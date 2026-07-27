import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readProject = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('keranjang memakai harga lokal seketika lalu memverifikasi server tanpa menahan klik', async () => {
  const script = await readProject('apps/web/app.js');
  const localQuote = script.indexOf('state.quote = quoteOffline');
  const serverQuote = script.indexOf("request('/api/quote'");
  assert.ok(localQuote >= 0);
  assert.ok(serverQuote > localQuote);
  assert.match(script, /quoteRevision/);
  assert.match(script, /quoteVerificationTimer = setTimeout/);
  assert.match(script, /revision !== quoteRevision/);
});

test('pelanggan POS dapat dicari menurut nama, kode, atau nomor telepon', async () => {
  const [html, script] = await Promise.all([
    readProject('apps/web/index.html'),
    readProject('apps/web/app.js')
  ]);
  assert.match(html, /id="customer-search"/);
  assert.match(html, /id="customer-search-results"/);
  assert.match(script, /function matchingCustomers/);
  assert.match(script, /customer\.name.*customer\.code.*customer\.phone/s);
  assert.match(script, /phoneDigits\.includes\(digits\)/);
});

test('kasir menampilkan satu tombol Member dan memindahkan daftar serta tambah member ke dialog', async () => {
  const [html, script] = await Promise.all([
    readProject('apps/web/index.html'),
    readProject('apps/web/app.js')
  ]);
  const searchRow = html.match(/<div class="search-row">([\s\S]*?)<\/div>\s*<div id="customer-service-note"/)?.[1] ?? '';
  const dialog = html.match(/<dialog id="pos-customer-dialog">([\s\S]*?)<\/dialog>/)?.[1] ?? '';
  assert.match(searchRow, /id="open-pos-customer"/);
  assert.doesNotMatch(searchRow, /id="customer-search"/);
  assert.match(dialog, /id="customer-search"/);
  assert.match(dialog, /id="customer-search-results"/);
  assert.match(dialog, /id="new-pos-customer"/);
  assert.match(script, /function openPosCustomerPicker/);
  assert.match(script, /pos-member-label.*customer\?\.name.*Member/);
});

test('PO dan restok menyediakan cari, scan, stok kosong teratas, serta baris instan', async () => {
  const [html, script] = await Promise.all([
    readProject('apps/web/index.html'),
    readProject('apps/web/app.js')
  ]);
  for (const id of ['po-product-search', 'scan-po-product', 'restock-product-search', 'scan-restock-product']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /function sortedPurchaseProducts/);
  assert.match(script, /aZero - bZero/);
  assert.ok(script.indexOf('state.poLines.push(line)') < script.indexOf('await purchaseCostSnapshot(productId, 0)'));
  const appendRestock = script.indexOf("el('restock-body').append(row)");
  assert.ok(appendRestock >= 0);
  assert.ok(script.indexOf('updateRestockComparison(row)', appendRestock) > appendRestock);
});

test('harga manual naik atau turun tetap memerlukan otorisasi dan tercatat di audit', async () => {
  const [migration, api, html, script] = await Promise.all([
    readProject('supabase/migrations/202607230023_manual_price_override.sql'),
    readProject('api/index.mjs'),
    readProject('apps/web/index.html'),
    readProject('apps/web/app.js')
  ]);
  assert.match(migration, /discount_amount <> 0/);
  assert.match(migration, /SALE_PRICE_OVERRIDE_APPROVED/);
  assert.match(migration, /'direction'.*'DECREASE'.*'INCREASE'/s);
  assert.match(api, /requirePermission\(session, 'sale\.adjust'\)/);
  assert.doesNotMatch(api, /Email dan kata sandi Owner\/Admin wajib diisi/);
  assert.match(html, /PENYESUAIAN HARGA INTERNAL/);
  assert.match(script, /DISKON PELANGGAN/);
});
