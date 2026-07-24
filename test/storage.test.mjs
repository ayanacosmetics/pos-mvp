import test from 'node:test';
import assert from 'node:assert/strict';
import { PosStore } from '../apps/api/src/storage.mjs';
import { products, promotionVersions, quoteBasket } from '../packages/domain/src/index.mjs';

const owner = { id: 'owner-test', displayName: 'Owner Test' };
const storeOf = () => new PosStore(':memory:', products);

test('penjualan tersimpan, mengurangi stok, dan idempotent', () => {
  const store = storeOf();
  const quote = quoteBasket({ lines: [{ productId: 'lip-tint-a', unitId: 'lip-tint-a-pcs', qty: 2 }], customerGroupId: 'retail', products, promotions: promotionVersions, at: new Date('2026-07-20T10:00:00+08:00') });
  const before = store.balance('outlet-utama', 'lip-tint-a').quantity;
  const first = store.recordSale({ key: 'sale-key-1', quote, cashier: owner, customerGroupId: 'retail', paymentMethod: 'Tunai' });
  const duplicate = store.recordSale({ key: 'sale-key-1', quote, cashier: owner, customerGroupId: 'retail', paymentMethod: 'Tunai' });
  assert.equal(first.id, duplicate.id);
  assert.equal(store.balance('outlet-utama', 'lip-tint-a').quantity, before - 2);
  assert.equal(store.reportSummary().metrics.transactionCount, 1);
});

test('laporan lokal mengurangi omzet dan laba ketika penjualan diretur', () => {
  const store = storeOf();
  const quote = quoteBasket({ lines: [{ productId: 'lip-tint-a', unitId: 'lip-tint-a-pcs', qty: 2 }], customerGroupId: 'retail', products, promotions: [], at: new Date() });
  const sale = store.recordSale({ key: 'sale-return-report', quote, cashier: owner, customerGroupId: 'retail', paymentMethod: 'Tunai' });
  const before = store.reportSummary().metrics;
  store.processReturn({ key:'return-report-1',saleId:sale.id,actorId:owner.id,reason:'Salah warna',refundMethod:'TRANSFER',refundReference:'TRX-1',items:[{ saleItemId:sale.lines[0].id,baseQty:1,condition:'SALEABLE' }] });
  const after = store.reportSummary().metrics;
  assert.equal(after.returnTotal, quote.grandTotal / 2);
  assert.equal(after.netSales, before.netSales - quote.grandTotal / 2);
  assert.ok(after.grossProfit < before.grossProfit);
  assert.equal(after.netUnits, 1);
});

test('penerimaan memperbarui stok dan modal rata-rata', () => {
  const store = storeOf();
  const before = store.balance('gudang-utama', 'bedak-b');
  store.receivePurchase({ key: 'buy-1', documentNo: 'INV-T1', supplierName: 'Supplier Test', locationId: 'gudang-utama', actorId: owner.id, items: [{ productId: 'bedak-b', baseQty: 10, unitCost: 20000, batchNo: 'B-T1' }] });
  const after = store.balance('gudang-utama', 'bedak-b');
  assert.equal(after.quantity, before.quantity + 10);
  assert.ok(after.avg_cost > before.avg_cost);
});

test('transfer menjaga total stok antar lokasi', () => {
  const store = storeOf();
  const totalBefore = store.balance('outlet-utama', 'sabun-cair').quantity + store.balance('gudang-utama', 'sabun-cair').quantity;
  store.transfer({ key: 'transfer-1', fromLocationId: 'gudang-utama', toLocationId: 'outlet-utama', actorId: owner.id, items: [{ productId: 'sabun-cair', baseQty: 12 }] });
  const totalAfter = store.balance('outlet-utama', 'sabun-cair').quantity + store.balance('gudang-utama', 'sabun-cair').quantity;
  assert.equal(totalAfter, totalBefore);
});

test('opname dan retur membuat jurnal yang dapat ditelusuri', () => {
  const store = storeOf();
  store.stockCount({ locationId: 'outlet-utama', actorId: owner.id, items: [{ productId: 'shampoo-c', countedQty: 60 }] });
  assert.equal(store.balance('outlet-utama', 'shampoo-c').quantity, 60);
  const quote=quoteBasket({lines:[{productId:'shampoo-c',unitId:'shampoo-c-pcs',qty:1}],customerGroupId:'retail',products:store.catalog(),promotions:[],at:new Date()});
  const sale=store.recordSale({key:'return-ledger-sale',quote,cashier:owner,customerGroupId:'retail',paymentMethod:'Transfer'});
  store.processReturn({key:'return-ledger-1',saleId:sale.id,actorId:owner.id,reason:'Salah produk',refundMethod:'TRANSFER',refundReference:'TRX-2',items:[{saleItemId:sale.lines[0].id,baseQty:1,condition:'SALEABLE'}]});
  assert.equal(store.balance('outlet-utama', 'shampoo-c').quantity, 60);
  assert.deepEqual(store.ledger(2).map((item) => item.event_type), ['CUSTOMER_RETURN', 'SALE']);
});

test('retur barang rusak tidak menambah stok jual dan tidak memulihkan HPP',()=>{
  const store=storeOf(); const quote=quoteBasket({lines:[{productId:'lip-tint-a',unitId:'lip-tint-a-pcs',qty:1}],customerGroupId:'retail',products, promotions:[],at:new Date()});
  const sale=store.recordSale({key:'damaged-sale',quote,cashier:owner,customerGroupId:'retail',paymentMethod:'Transfer'}); const stockAfterSale=store.balance('outlet-utama','lip-tint-a').quantity;
  const profitBefore=store.reportSummary().metrics.grossProfit;
  store.processReturn({key:'damaged-return',saleId:sale.id,actorId:owner.id,reason:'Barang bocor',refundMethod:'TRANSFER',refundReference:'TRX-3',items:[{saleItemId:sale.lines[0].id,baseQty:1,condition:'DAMAGED'}]});
  assert.equal(store.balance('outlet-utama','lip-tint-a').quantity,stockAfterSale);
  assert.equal(store.reportSummary().metrics.costOfGoods,quote.lines[0].baseQty*(sale.lines[0].cost_total/sale.lines[0].base_qty));
  assert.ok(store.reportSummary().metrics.grossProfit<profitBefore);
});

test('produk, pelanggan, supplier, dan promo dapat dibuat permanen', () => {
  const store = new PosStore(':memory:', products, promotionVersions);
  const product = store.createProduct({ sku: 'NEW-001', name: 'Produk Baru', category: 'Tes', brand: 'Nusa', barcode: '990000001', retailPrice: 20000, wholesalePrice: 18000, tierQty: 12, tierPrice: 17000 }, owner.id);
  assert.equal(store.catalog().some((item) => item.id === product.id), true);
  assert.equal(store.balance('outlet-utama', product.id).quantity, 0);
  assert.equal(store.createCustomer({ name: 'Toko Grosir Baru', phone: '08123', groupId: 'wholesale' }, owner.id).group_id, 'wholesale');
  assert.equal(store.createSupplier({ name: 'Supplier Baru', phone: '08456', address: 'Makassar' }, owner.id).name, 'Supplier Baru');
  const promo = store.publishPromotion({ code: 'TEST10', name: 'Promo Tes', category: 'Tes', minBaseQty: 2, discountPercent: 10, maxDiscount: 50000 }, owner.id);
  assert.equal(promo.version, 1);
  assert.equal(promo.status, 'PUBLISHED');
});

test('shift menghitung kas harapan dan selisih saat ditutup', () => {
  const store = new PosStore(':memory:', products, promotionVersions);
  const shift = store.openShift({ cashier: owner, openingCash: 100000 });
  store.addCashMovement({ shiftId: shift.id, movementType: 'CASH_IN', amount: 10000, note: 'Uang receh', actorId: owner.id });
  const quote = quoteBasket({ lines: [{ productId: 'sabun-cair', unitId: 'sabun-cair-pcs', qty: 1 }], customerGroupId: 'retail', products: store.catalog(), promotions: store.promotions(), at: new Date('2026-07-20T10:00:00+08:00') });
  store.recordSale({ key: 'shift-sale-1', quote, cashier: owner, customerGroupId: 'retail', paymentMethod: 'Tunai', shiftId: shift.id });
  assert.equal(store.shiftExpected(shift.id), 122500);
  const closed = store.closeShift({ shiftId: shift.id, closingCash: 122000, actorId: owner.id });
  assert.equal(closed.difference, -500);
  assert.equal(closed.status, 'CLOSED');
});
