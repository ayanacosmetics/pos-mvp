const money = (value) => Math.round(Number(value) * 100) / 100;

export function normalizeSafePricePolicy(input = {}) {
  const minProfit = Number(input.minProfit ?? 500);
  if (!(minProfit >= 0)) throw new Error('Keuntungan minimum tidak valid');
  const rules = (Array.isArray(input.rules) ? input.rules : []).map((rule) => ({
    customerGroupId: String(rule.customerGroupId ?? '').trim().toLowerCase(),
    minBaseQty: Number(rule.minBaseQty),
    discountAmount: Number(rule.discountAmount)
  }));
  if (!rules.length) throw new Error('Tambahkan sedikitnya satu aturan harga');
  const seen = new Set();
  for (const rule of rules) {
    const key = `${rule.customerGroupId}:${rule.minBaseQty}`;
    if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(rule.customerGroupId)
      || rule.customerGroupId === 'retail'
      || !Number.isInteger(rule.minBaseQty) || rule.minBaseQty < 1
      || !(rule.discountAmount > 0)) throw new Error('Tipe pelanggan, minimal pembelian, atau potongan tidak valid');
    if (seen.has(key)) throw new Error('Tipe dan minimal pembelian yang sama tercatat dua kali');
    seen.add(key);
  }
  return {
    minProfit,
    category: String(input.category ?? '').trim(),
    brand: String(input.brand ?? '').trim(),
    rules
  };
}

export function evaluateSafePricePolicy({ retailPrice, cost, costKnown = Number(cost) > 0, rules, minProfit = 500 }) {
  const retail = Number(retailPrice);
  const unitCost = Math.max(0,Number(cost ?? 0));
  if (!(retail > 0)) throw new Error('Harga Umum produk tidak tersedia');
  const results = rules.map((rule) => {
    const proposedPrice = money(retail - Number(rule.discountAmount));
    const profit = money(proposedPrice - unitCost);
    const safe = costKnown && proposedPrice > 0 && profit >= minProfit;
    return { ...rule, proposedPrice, profit, safe, reason: !costKnown ? 'NO_COST' : safe ? 'SAFE' : profit < 0 ? 'LOSS' : profit === 0 ? 'BEP' : 'BELOW_MINIMUM' };
  });
  const firstTier = [...results].sort((a,b)=>a.minBaseQty-b.minBaseQty || a.discountAmount-b.discountAmount)[0];
  const recommendedIncrease = !costKnown || firstTier?.safe ? 0 : Math.max(0,money(minProfit - (firstTier?.profit ?? 0)));
  return {
    retailPrice: retail,
    cost: unitCost,costKnown,
    currentMargin: money(retail-unitCost),
    results,
    safeCount: results.filter((result)=>result.safe).length,
    recommendedIncrease
  };
}
