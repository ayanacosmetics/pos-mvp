const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function restockRecommendation(input = {}) {
  const stock = Math.max(0, finite(input.stock));
  const onOrder = Math.max(0, finite(input.onOrder));
  const averageDailySales = Math.max(0, finite(input.averageDailySales));
  const minimumStock = Math.max(0, finite(input.minimumStock));
  const maximumStock = Math.max(0, finite(input.maximumStock));
  const safetyStock = Math.max(0, finite(input.safetyStock));
  const leadTimeDays = Math.max(0, Math.round(finite(input.leadTimeDays)));
  const reorderPoint = Math.max(minimumStock, safetyStock + (averageDailySales * leadTimeDays));
  const targetStock = Math.max(maximumStock, reorderPoint);
  const projectedStock = stock + onOrder;
  const suggestedQty = Math.ceil(Math.max(0, targetStock - projectedStock));
  const daysOfCover = averageDailySales > 0 ? Math.round((projectedStock / averageDailySales) * 10) / 10 : null;
  const urgency = stock <= 0
    ? 'OUT_OF_STOCK'
    : projectedStock <= reorderPoint
      ? 'CRITICAL'
      : projectedStock < targetStock
        ? 'WATCH'
        : 'HEALTHY';
  return {
    stock, onOrder, projectedStock, averageDailySales, minimumStock, maximumStock,
    safetyStock, leadTimeDays, reorderPoint, targetStock, suggestedQty, daysOfCover, urgency
  };
}

export function restockPriority(recommendation) {
  const order = { OUT_OF_STOCK: 0, CRITICAL: 1, WATCH: 2, HEALTHY: 3 };
  return order[recommendation?.urgency] ?? 4;
}
