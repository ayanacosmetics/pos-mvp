import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { productBaseQuantity, shouldChooseUnitAfterScan, sortedProductUnits, unitFitsStock } from '../apps/web/pos-units.mjs';

const product = {
  id: 'p1',
  stockBase: 30,
  units: [
    { id: 'box', name: 'Dus', factor: 24, barcode: '' },
    { id: 'piece', name: 'Pcs', factor: 1, barcode: '8990001' },
    { id: 'dozen', name: 'Lusin', factor: 12, barcode: '' }
  ]
};

test('scan barcode dasar membuka pilihan jika satuan lain tidak memiliki barcode', () => {
  assert.equal(shouldChooseUnitAfterScan(product, product.units[1]), true);
  assert.deepEqual(sortedProductUnits(product).map((unit) => unit.id), ['piece', 'dozen', 'box']);
});

test('scan barcode satuan besar selalu memilih satuan tersebut secara langsung', () => {
  const withBoxBarcode = { ...product.units[0], barcode: '8990024' };
  assert.equal(shouldChooseUnitAfterScan({ ...product, units: [withBoxBarcode, ...product.units.slice(1)] }, withBoxBarcode), false);
});

test('scan barcode dasar langsung memilih pcs bila semua satuan mempunyai barcode', () => {
  const complete = {
    ...product,
    units: product.units.map((unit, index) => ({ ...unit, barcode: unit.barcode || `bulk-${index}` }))
  };
  assert.equal(shouldChooseUnitAfterScan(complete, complete.units[1]), false);
});

test('pergantian satuan menghitung stok dengan mengecualikan baris yang sedang diubah', () => {
  const cart = [
    { productId: 'p1', unitId: 'piece', qty: 6 },
    { productId: 'other', unitId: 'piece', qty: 99 }
  ];
  assert.equal(productBaseQuantity(cart, product), 6);
  assert.equal(unitFitsStock({ cart, product, unit: product.units[0], qty: 1 }), true);
  assert.equal(unitFitsStock({ cart, product, unit: product.units[0], qty: 2 }), false);
  assert.equal(unitFitsStock({ cart, product, unit: product.units[0], qty: 1, excludeIndex: 0 }), true);
});

test('produk tanpa stok tidak dibatasi saldo persediaan',()=>{
  const unlimited={...product,trackStock:false,stockBase:0};
  assert.equal(unitFitsStock({cart:[],product:unlimited,unit:unlimited.units[0],qty:999}),true);
});

test('UI menyediakan pemilih satuan untuk kartu, scan, keranjang, dan mode offline', async () => {
  const [html, app, css, worker] = await Promise.all([
    readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/service-worker.js', import.meta.url), 'utf8')
  ]);
  assert.match(html, /id="unit-picker-dialog"/);
  assert.match(html, /id="unit-picker-options"/);
  assert.match(app, /function choosePosProduct/);
  assert.match(app, /shouldChooseUnitAfterScan/);
  assert.match(app, /function changeCartUnit/);
  assert.match(app, /class="cart-unit-change"/);
  assert.match(css, /\.unit-picker-option\{/);
  assert.match(css, /\.cart-unit-change\{/);
  assert.match(worker, /\/pos-units\.mjs/);
});
