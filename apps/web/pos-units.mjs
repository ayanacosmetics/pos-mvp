export function sortedProductUnits(product) {
  return [...(product?.units ?? [])].sort((a, b) =>
    Number(a.factor ?? 0) - Number(b.factor ?? 0) || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'id')
  );
}

export function shouldChooseUnitAfterScan(product, scannedUnit) {
  const units = sortedProductUnits(product);
  if (!scannedUnit || units.length <= 1) return false;
  if (Number(scannedUnit.factor) > 1) return false;
  return units.some((unit) => unit.id !== scannedUnit.id && !String(unit.barcode ?? '').trim());
}

export function productBaseQuantity(cart, product, excludeIndex = -1) {
  return (cart ?? []).reduce((sum, line, index) => {
    if (index === excludeIndex || line.productId !== product?.id) return sum;
    const unit = product.units.find((candidate) => candidate.id === line.unitId);
    return sum + Number(line.qty ?? 0) * Number(unit?.factor ?? 0);
  }, 0);
}

export function unitFitsStock({ cart, product, unit, qty = 1, excludeIndex = -1 }) {
  if (!product || !unit) return false;
  if (product.trackStock === false) return true;
  return productBaseQuantity(cart, product, excludeIndex)
    + Number(qty) * Number(unit.factor ?? 0)
    <= Number(product.stockBase ?? 0);
}
