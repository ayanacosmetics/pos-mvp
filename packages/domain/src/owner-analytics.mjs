function amount(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} tidak valid`);
  return number;
}

export function operatingProfitSummary({
  netSales = 0,
  costOfGoods = 0,
  operatingExpenses = 0,
} = {}) {
  const sales = amount(netSales, 'Penjualan bersih');
  const cost = amount(costOfGoods, 'HPP');
  const expenses = amount(operatingExpenses, 'Biaya operasional');
  const grossProfit = sales - cost;
  const operatingProfit = grossProfit - expenses;
  return {
    netSales: sales,
    costOfGoods: cost,
    grossProfit,
    operatingExpenses: expenses,
    operatingProfit,
    operatingMarginPercent: sales === 0 ? 0 : Math.round(operatingProfit / sales * 10_000) / 100,
  };
}

export function agingBucket(dueOn, asOf = new Date()) {
  if (!dueOn) return 'current';
  const due = new Date(`${dueOn}T12:00:00Z`);
  const current = new Date(`${new Date(asOf).toISOString().slice(0, 10)}T12:00:00Z`);
  const days = Math.floor((current - due) / 86_400_000);
  if (days <= 0) return 'current';
  if (days <= 30) return 'days1To30';
  if (days <= 60) return 'days31To60';
  return 'daysOver60';
}

export function productHealth({
  stockQty = 0,
  netQty = 0,
  netRevenue = 0,
  grossProfit = 0,
  lastSaleOn = null,
  asOf = new Date(),
  fastMoving = false,
} = {}) {
  const stock = amount(stockQty, 'Stok');
  const quantity = Number(netQty);
  if (!Number.isFinite(quantity)) throw new Error('Penjualan tidak valid');
  const revenue = amount(netRevenue, 'Omzet');
  const profit = Number(grossProfit);
  if (!Number.isFinite(profit)) throw new Error('Laba produk tidak valid');
  const marginPercent = revenue === 0 ? 0 : Math.round(profit / revenue * 10_000) / 100;
  const daysSinceSale = lastSaleOn
    ? Math.max(0, Math.floor((new Date(`${new Date(asOf).toISOString().slice(0, 10)}T12:00:00Z`) - new Date(`${lastSaleOn}T12:00:00Z`)) / 86_400_000))
    : null;
  return {
    marginPercent,
    lowMargin: revenue > 0 && marginPercent < 15,
    deadStock: stock > 0 && (daysSinceSale === null || daysSinceSale > 90),
    slowMoving: stock > 0 && (quantity === 0 || daysSinceSale === null || daysSinceSale > 30),
    fastMoving: quantity > 0 && Boolean(fastMoving),
  };
}
