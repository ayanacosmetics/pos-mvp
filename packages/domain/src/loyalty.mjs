const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export function applyVoucher(quote, voucher) {
  if (!voucher) return quote;
  const discount = Math.max(0, Math.min(Number(voucher.discount ?? 0), Number(quote.grandTotal ?? 0)));
  return {
    ...quote,
    discountTotal: roundMoney(Number(quote.discountTotal ?? 0) + discount),
    grandTotal: roundMoney(Number(quote.grandTotal ?? 0) - discount),
    voucher: {
      id: voucher.id,
      code: voucher.code,
      name: voucher.name,
      discount: roundMoney(discount)
    }
  };
}

export function calculatePoints(grandTotal, amountPerPoint = 10000, multiplier = 1) {
  const threshold = Math.max(1, Number(amountPerPoint));
  return Math.max(0, Math.floor((Number(grandTotal) / threshold) * Math.max(0, Number(multiplier))));
}

export function customerSegment(customer, now = new Date(), inactivityDays = 90) {
  if (customer?.birth_date) {
    const birth = String(customer.birth_date).slice(5, 10);
    const current = now.toISOString().slice(5, 10);
    if (birth === current) return 'BIRTHDAY';
  }
  if (Number(customer?.lifetime_spend ?? 0) >= 5000000) return 'HIGH_VALUE';
  if (!customer?.last_purchase_at) return 'INACTIVE';
  return now.getTime() - new Date(customer.last_purchase_at).getTime() > Number(inactivityDays) * 86400000
    ? 'INACTIVE'
    : 'ACTIVE';
}
