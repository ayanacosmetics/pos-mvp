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
    return {
      ...line,
      customerUnitPrice: roundMoney((Number(line.gross) - lineInternal) / Number(line.qty || 1))
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
