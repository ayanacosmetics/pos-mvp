import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeExpiryBatches, todayInTimeZone } from '../packages/domain/src/expiry.mjs';

test('tanggal operasional mengikuti zona waktu toko', () => {
  assert.equal(todayInTimeZone(new Date('2026-07-20T18:30:00Z'), 'Asia/Makassar'), '2026-07-21');
});

test('dashboard EXP membagi batch 30/60/90 hari dan mengurutkan FEFO', () => {
  const base = { tenant_id: 'tenant', location_id: 'store', product_id: 'product', supplier_name: 'Supplier A', received_qty: 10, available_qty: 10, unit_cost: 5000, received_at: '2026-07-01T00:00:00Z' };
  const rows = [
    { ...base, id: 'safe', batch_no: 'SAFE', expires_on: '2026-11-01' },
    { ...base, id: 'notice', batch_no: '90', expires_on: '2026-10-01' },
    { ...base, id: 'warning', batch_no: '60', expires_on: '2026-09-01' },
    { ...base, id: 'critical', batch_no: '30', expires_on: '2026-08-01' },
    { ...base, id: 'expired', batch_no: 'OLD', expires_on: '2026-07-01' },
    { ...base, id: 'missing', batch_no: 'NOEXP', expires_on: null }
  ];
  const result = summarizeExpiryBatches({
    rows,
    products: [{ id: 'product', name: 'Serum Wajah', sku: 'SRM-01', brand: 'Nusa' }],
    locations: [{ id: 'store', name: 'Toko Utama' }],
    today: '2026-07-21'
  });
  assert.deepEqual(result.batches.map((item) => item.status), ['EXPIRED', 'CRITICAL', 'WARNING', 'NOTICE', 'NO_EXPIRY', 'SAFE']);
  assert.equal(result.metrics.expiredBatches, 1);
  assert.equal(result.metrics.due30Batches, 1);
  assert.equal(result.metrics.due60Batches, 1);
  assert.equal(result.metrics.due90Batches, 1);
  assert.equal(result.metrics.noExpiryBatches, 1);
  assert.equal(result.metrics.totalQty, 60);
  assert.equal(result.metrics.stockValue, 300000);
});
