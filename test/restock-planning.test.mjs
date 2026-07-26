import test from 'node:test';
import assert from 'node:assert/strict';
import { restockPriority, restockRecommendation } from '../packages/domain/src/restock-planning.mjs';

test('saran restok mengurangi stok tersedia dan sisa PO yang sedang datang', () => {
  const result = restockRecommendation({
    stock: 8, onOrder: 7, averageDailySales: 2, minimumStock: 10,
    maximumStock: 30, safetyStock: 5, leadTimeDays: 4
  });
  assert.equal(result.reorderPoint, 13);
  assert.equal(result.targetStock, 30);
  assert.equal(result.suggestedQty, 15);
  assert.equal(result.daysOfCover, 7.5);
});

test('stok nol selalu menjadi prioritas tertinggi walau masih ada PO terbuka', () => {
  const empty = restockRecommendation({ stock: 0, onOrder: 20, maximumStock: 20 });
  const critical = restockRecommendation({ stock: 2, averageDailySales: 1, safetyStock: 3, leadTimeDays: 4 });
  assert.equal(empty.urgency, 'OUT_OF_STOCK');
  assert.ok(restockPriority(empty) < restockPriority(critical));
});

test('batas pemesanan memakai kebutuhan lead time ketika melampaui minimum', () => {
  const result = restockRecommendation({
    stock: 4, averageDailySales: 3, minimumStock: 5,
    maximumStock: 0, safetyStock: 6, leadTimeDays: 7
  });
  assert.equal(result.reorderPoint, 27);
  assert.equal(result.targetStock, 27);
  assert.equal(result.suggestedQty, 23);
});
