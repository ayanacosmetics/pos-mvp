export function appendMoneyKey(current, key, maximum = 999999999) {
  const normalized = Math.max(0, Math.trunc(Number(current) || 0));
  if (key === 'CLEAR') return 0;
  if (key === 'BACKSPACE') return Math.floor(normalized / 10);
  if (!/^\d{1,3}$/.test(String(key))) return normalized;
  return Math.min(maximum, Number(`${normalized || ''}${key}`));
}

export function suggestedCashAmounts(total) {
  const amount = Math.max(0, Math.ceil(Number(total) || 0));
  const steps = [10000, 20000, 50000, 100000];
  const rounded = steps.map((step) => Math.ceil(amount / step) * step).filter((value) => value > amount);
  return [...new Set([amount, ...rounded])].slice(0, 4);
}
