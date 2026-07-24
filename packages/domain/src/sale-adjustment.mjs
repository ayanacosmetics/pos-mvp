function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function normalizeSaleAdjustment(input = {}) {
  const scope = String(input.scope ?? '').trim().toUpperCase();
  const mode = String(input.mode ?? '').trim().toUpperCase();
  const value = Number(input.value);
  const reason = String(input.reason ?? '').trim();
  if (!['LINE', 'ORDER'].includes(scope)) throw new Error('Sasaran penyesuaian harga tidak valid');
  if (scope === 'LINE' && !['PERCENT', 'FIXED_PRICE', 'FIXED_DISCOUNT'].includes(mode)) throw new Error('Jenis penyesuaian barang tidak valid');
  if (scope === 'ORDER' && !['PERCENT', 'FIXED_DISCOUNT'].includes(mode)) throw new Error('Jenis diskon transaksi tidak valid');
  if (!Number.isFinite(value) || value <= 0) throw new Error('Nilai diskon atau harga baru harus lebih dari nol');
  if (mode === 'PERCENT' && value > 100) throw new Error('Persentase diskon maksimal 100%');
  if (reason.length < 5) throw new Error('Alasan penyesuaian minimal 5 karakter');
  const productId = scope === 'LINE' ? String(input.productId ?? '').trim() : null;
  const unitId = scope === 'LINE' ? String(input.unitId ?? '').trim() : null;
  if (scope === 'LINE' && (!productId || !unitId)) throw new Error('Barang yang disesuaikan tidak ditemukan');
  return { scope, mode, value: roundMoney(value), reason, productId, unitId };
}

export function saleAdjustmentFingerprintPayload(lines, customerGroupId, adjustment) {
  return JSON.stringify({
    customerGroupId: String(customerGroupId ?? 'retail'),
    lines: (lines ?? []).map((line) => ({
      productId: String(line.productId),
      unitId: String(line.unitId),
      qty: Number(line.qty)
    })),
    adjustment: normalizeSaleAdjustment(adjustment)
  });
}

function appendManualSnapshot(line, amount, authorization, reason) {
  line.promotions = Array.isArray(line.promotions) ? line.promotions : [];
  line.promotions.push({
    id: authorization?.id ?? null,
    code: 'MANUAL',
    version: 1,
    discount: roundMoney(amount),
    reason,
    manual: true,
    approvedBy: authorization?.approvedBy ?? null
  });
}

function adjustLine(line, amount, authorization, reason) {
  const applied = roundMoney(Number(amount));
  if (!Number.isFinite(applied) || applied === 0) return 0;
  if (applied >= Number(line.total)) throw new Error('Penyesuaian membuat total barang menjadi nol atau negatif');
  line.discount = roundMoney(Number(line.discount) + applied);
  line.total = roundMoney(Number(line.total) - applied);
  appendManualSnapshot(line, applied, authorization, reason);
  return applied;
}

export function applySaleAdjustment(baseQuote, rawAdjustment, authorization = {}) {
  const adjustment = normalizeSaleAdjustment(rawAdjustment);
  const quote = JSON.parse(JSON.stringify(baseQuote));
  let manualDiscount = 0;

  if (adjustment.scope === 'LINE') {
    const line = quote.lines.find((item) => item.productId === adjustment.productId && item.unitId === adjustment.unitId);
    if (!line) throw new Error('Barang untuk penyesuaian tidak lagi ada di keranjang');
    if (adjustment.mode === 'PERCENT') {
      manualDiscount = adjustLine(line, Number(line.total) * adjustment.value / 100, authorization, `${adjustment.value}% · ${adjustment.reason}`);
    } else if (adjustment.mode === 'FIXED_PRICE') {
      const requestedTotal = roundMoney(adjustment.value * Number(line.qty));
      if (requestedTotal === Number(line.total)) throw new Error('Harga baru sama dengan harga yang sedang aktif');
      manualDiscount = adjustLine(line, Number(line.total) - requestedTotal, authorization, `Harga ${adjustment.value} / ${line.unitName} · ${adjustment.reason}`);
    } else {
      manualDiscount = adjustLine(line, adjustment.value * Number(line.qty), authorization, `Potongan Rp${adjustment.value} / ${line.unitName} · ${adjustment.reason}`);
    }
  } else {
    const available = quote.lines.reduce((sum, line) => sum + Number(line.total), 0);
    const requested = adjustment.mode === 'PERCENT' ? available * adjustment.value / 100 : adjustment.value;
    if (requested >= available) throw new Error('Diskon transaksi harus lebih kecil dari total belanja');
    let remaining = roundMoney(requested);
    quote.lines.forEach((line, index) => {
      const share = index === quote.lines.length - 1
        ? remaining
        : roundMoney(requested * (Number(line.total) / available));
      const applied = adjustLine(line, Math.min(share, remaining), authorization, `${adjustment.mode === 'PERCENT' ? `${adjustment.value}%` : `Rp${adjustment.value}`} transaksi · ${adjustment.reason}`);
      manualDiscount = roundMoney(manualDiscount + applied);
      remaining = roundMoney(remaining - applied);
    });
  }

  if (manualDiscount === 0) throw new Error('Penyesuaian tidak mengubah harga');
  quote.discountTotal = roundMoney(Number(quote.discountTotal) + manualDiscount);
  quote.grandTotal = roundMoney(Number(quote.subtotal) - quote.discountTotal);
  quote.manualAdjustment = {
    authorizationId: authorization?.id ?? null,
    approvedBy: authorization?.approvedBy ?? null,
    discountAmount: manualDiscount,
    ...adjustment
  };
  return quote;
}
