import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCost, products, promotionVersions, quoteBasket, selectPriceRule } from '../packages/domain/src/index.mjs';

test('harga bertingkat menang saat jumlah mencapai satu lusin', () => {
  const product = products.find((item) => item.id === 'lip-tint-a');
  const rule = selectPriceRule(product, 'retail', 12);
  assert.equal(rule.id, 'price-lta-tier-12');
  assert.equal(rule.unitPriceBase, 40500);
});

test('harga khusus pelanggan grosir digunakan untuk satu pcs', () => {
  const product = products.find((item) => item.id === 'lip-tint-a');
  assert.equal(selectPriceRule(product, 'wholesale', 1).id, 'price-lta-wholesale');
});

test('promo terversi menghasilkan total deterministik', () => {
  const quote = quoteBasket({
    lines: [{ productId: 'lip-tint-a', unitId: 'lip-tint-a-lusin', qty: 1 }],
    customerGroupId: 'retail', products, promotions: promotionVersions, at: new Date('2026-07-20T10:00:00+08:00')
  });
  assert.equal(quote.subtotal, 486000);
  assert.equal(quote.discountTotal, 24300);
  assert.equal(quote.grandTotal, 461700);
  assert.deepEqual(quote.lines[0].promotions[0], { id: 'promo-lip-july-v3', code: 'GROSIR5', version: 3, discount: 24300, reason: '5% untuk minimal 12 satuan dasar' });
});

test('promo di luar periode tidak diterapkan', () => {
  const quote = quoteBasket({ lines: [{ productId: 'lip-tint-a', unitId: 'lip-tint-a-lusin', qty: 1 }], customerGroupId: 'retail', products, promotions: promotionVersions, at: new Date('2026-08-01T10:00:00+08:00') });
  assert.equal(quote.discountTotal, 0);
});

test('indikator modal merah jika kenaikan di atas lima persen', () => {
  const result = compareCost(18200, [{ occurredAt: '2026-05-01', costPerBase: 17000, supplier: 'Supplier A', batch: 'B1' }]);
  assert.equal(result.percentage, 7.06);
  assert.equal(result.level, 'DANGER');
});
