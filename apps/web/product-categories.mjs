export function normalizeProductCategory(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function productCategoryKey(value) {
  return normalizeProductCategory(value).toLocaleLowerCase('id');
}

export function canonicalProductCategories(products = []) {
  const groups = new Map();
  for (const product of products) {
    const label = normalizeProductCategory(product?.category ?? product);
    if (!label) continue;
    const key = productCategoryKey(label), labels = groups.get(key) ?? new Map();
    labels.set(label, (labels.get(label) ?? 0) + 1); groups.set(key, labels);
  }
  const otherKey = productCategoryKey('Lainnya');
  if (!groups.has(otherKey)) groups.set(otherKey, new Map([['Lainnya', 1]]));
  return [...groups.values()]
    .map((labels) => [...labels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'id', { sensitivity: 'base' }))[0][0])
    .sort((a, b) => a.localeCompare(b, 'id', { sensitivity: 'base' }));
}

export function canonicalProductCategory(value, categories) {
  const key = productCategoryKey(value || 'Lainnya');
  return canonicalProductCategories(categories).find((category) => productCategoryKey(category) === key) ?? null;
}
