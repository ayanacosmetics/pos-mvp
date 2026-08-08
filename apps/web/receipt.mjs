const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export function customerReceiptView(quote = {}) {
  const hideInternalPrice = quote.manualAdjustment?.scope === 'LINE';
  let internalPriceAdjustment = 0;
  const lines = (quote.lines ?? []).map((line) => {
    const lineInternal = hideInternalPrice
      ? (line.promotions ?? [])
        .filter((promotion) => promotion.manual)
        .reduce((sum, promotion) => roundMoney(sum + Number(promotion.discount ?? 0)), 0)
      : 0;
    internalPriceAdjustment = roundMoney(internalPriceAdjustment + lineInternal);
    const customerPromotions = (line.promotions ?? [])
      .filter((promotion) => !promotion.manual && Number(promotion.discount ?? 0) > 0)
      .map((promotion) => ({
        code: String(promotion.code ?? promotion.name ?? 'PROMO'),
        discount: roundMoney(Number(promotion.discount)),
        reason: String(promotion.reason ?? '')
      }));
    return {
      ...line,
      customerUnitPrice: roundMoney((Number(line.gross) - lineInternal) / Number(line.qty || 1)),
      customerPromotions,
      customerPromotionDiscount: roundMoney(customerPromotions.reduce((sum, promotion) => sum + promotion.discount, 0))
    };
  });
  return {
    lines,
    subtotal: roundMoney(Number(quote.subtotal ?? 0) - internalPriceAdjustment),
    discountTotal: roundMoney(Number(quote.discountTotal ?? 0) - internalPriceAdjustment),
    grandTotal: roundMoney(Number(quote.grandTotal ?? 0)),
    internalPriceAdjustment
  };
}

const validMoney = (value) => value !== null && value !== '' && Number.isFinite(Number(value));

export function receiptPaymentLabel(method = '') {
  const normalized = String(method).trim().toUpperCase();
  if (['CASH', 'TUNAI'].includes(normalized)) return 'Tunai';
  if (normalized === 'QRIS') return 'QRIS';
  if (normalized === 'TRANSFER') return 'Transfer';
  if (['CARD', 'EDC'].includes(normalized)) return 'Kartu / EDC';
  if (['CREDIT', 'PIUTANG'].includes(normalized)) return 'Piutang';
  return String(method || 'Pembayaran');
}

export function receiptPaymentSummary(payments = [], fallbackChange = 0) {
  const cashPayments = payments.filter((payment) => ['CASH', 'TUNAI'].includes(String(payment.method).trim().toUpperCase()));
  const cashApplied = cashPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const hasTendered = cashPayments.some((payment) => validMoney(payment.tendered));
  const cashReceived = cashPayments.reduce((sum, payment) => (
    sum + (validMoney(payment.tendered) ? Number(payment.tendered) : Number(payment.amount || 0))
  ), 0);
  const storedChange = cashPayments.reduce((sum, payment) => sum + Number(payment.change || 0), 0);
  const change = hasTendered
    ? Math.max(0, cashReceived - cashApplied)
    : Math.max(0, storedChange || Number(fallbackChange || 0));
  return {
    hasCash: cashPayments.length > 0,
    cashApplied: roundMoney(cashApplied),
    cashReceived: roundMoney(hasTendered ? cashReceived : cashApplied + change),
    change: roundMoney(change)
  };
}
