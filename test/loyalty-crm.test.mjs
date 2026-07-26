import test from 'node:test';
import assert from 'node:assert/strict';
import { applyVoucher, calculatePoints, customerSegment } from '../packages/domain/src/loyalty.mjs';

test('voucher reduces final total without changing line pricing', () => {
  const quote = { subtotal: 100000, discountTotal: 10000, grandTotal: 90000, lines: [{ total: 90000 }] };
  const result = applyVoucher(quote, { id: 'v1', code: 'HEMAT', name: 'Hemat', discount: 15000 });
  assert.equal(result.discountTotal, 25000);
  assert.equal(result.grandTotal, 75000);
  assert.deepEqual(result.lines, quote.lines);
});

test('voucher cannot make a transaction total negative', () => {
  assert.equal(applyVoucher({ grandTotal: 5000, discountTotal: 0 }, { discount: 9000 }).grandTotal, 0);
});

test('points respect threshold and tier multiplier', () => {
  assert.equal(calculatePoints(125000, 10000, 1.25), 15);
});

test('customer segmentation prioritizes birthday and identifies inactive customers', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  assert.equal(customerSegment({ birth_date: '1990-07-26' }, now), 'BIRTHDAY');
  assert.equal(customerSegment({ last_purchase_at: '2026-01-01T00:00:00Z' }, now, 90), 'INACTIVE');
});
