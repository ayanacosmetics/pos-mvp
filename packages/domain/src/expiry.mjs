const DAY_MS = 86_400_000;

export function todayInTimeZone(date = new Date(), timeZone = 'Asia/Makassar') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function daysUntilExpiry(expiresOn, today) {
  if (!expiresOn) return null;
  const expiry = Date.parse(`${expiresOn}T00:00:00Z`);
  const current = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(expiry) || !Number.isFinite(current)) return null;
  return Math.round((expiry - current) / DAY_MS);
}

export function expiryStatus(daysToExpiry, expiresOn) {
  if (!expiresOn || daysToExpiry === null) return 'NO_EXPIRY';
  if (daysToExpiry < 0) return 'EXPIRED';
  if (daysToExpiry <= 30) return 'CRITICAL';
  if (daysToExpiry <= 60) return 'WARNING';
  if (daysToExpiry <= 90) return 'NOTICE';
  return 'SAFE';
}

export function summarizeExpiryBatches({ rows, products = [], locations = [], today }) {
  const productMap = new Map(products.map((item) => [item.id, item]));
  const locationMap = new Map(locations.map((item) => [item.id, item]));
  const metrics = {
    totalBatches: 0, totalQty: 0, stockValue: 0,
    expiredBatches: 0, expiredQty: 0,
    due30Batches: 0, due30Qty: 0,
    due60Batches: 0, due60Qty: 0,
    due90Batches: 0, due90Qty: 0,
    noExpiryBatches: 0, noExpiryQty: 0
  };
  const batches = rows.map((row) => {
    const availableQty = Number(row.available_qty ?? 0);
    const unitCost = Number(row.unit_cost ?? 0);
    const daysToExpiry = daysUntilExpiry(row.expires_on, today);
    const status = expiryStatus(daysToExpiry, row.expires_on);
    const product = productMap.get(row.product_id);
    const location = locationMap.get(row.location_id);
    metrics.totalBatches += 1;
    metrics.totalQty += availableQty;
    metrics.stockValue += availableQty * unitCost;
    if (status === 'EXPIRED') { metrics.expiredBatches += 1; metrics.expiredQty += availableQty; }
    if (status === 'CRITICAL') { metrics.due30Batches += 1; metrics.due30Qty += availableQty; }
    if (status === 'WARNING') { metrics.due60Batches += 1; metrics.due60Qty += availableQty; }
    if (status === 'NOTICE') { metrics.due90Batches += 1; metrics.due90Qty += availableQty; }
    if (status === 'NO_EXPIRY') { metrics.noExpiryBatches += 1; metrics.noExpiryQty += availableQty; }
    return {
      id: row.id,
      productId: row.product_id,
      productName: product?.name ?? 'Produk tidak ditemukan',
      sku: product?.sku ?? '-',
      brand: product?.brand ?? null,
      locationId: row.location_id,
      locationName: location?.name ?? 'Lokasi tidak ditemukan',
      supplierId: row.supplier_id,
      supplierName: row.supplier_name ?? '-',
      batchNo: row.batch_no ?? '-',
      expiresOn: row.expires_on,
      daysToExpiry,
      status,
      availableQty,
      receivedQty: Number(row.received_qty ?? 0),
      unitCost,
      stockValue: availableQty * unitCost,
      receivedAt: row.received_at
    };
  });
  const rank = { EXPIRED: 0, CRITICAL: 1, WARNING: 2, NOTICE: 3, NO_EXPIRY: 4, SAFE: 5 };
  batches.sort((a, b) => (rank[a.status] - rank[b.status]) || ((a.daysToExpiry ?? 999999) - (b.daysToExpiry ?? 999999)) || a.productName.localeCompare(b.productName, 'id'));
  return { today, metrics, batches };
}
