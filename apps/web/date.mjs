export function formatExpiryValue(value) {
  const digits = String(value ?? '').replace(/\D/g, '').slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean).join('/');
}

export function parseExpiryDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value ?? '').trim());
  if (!match) throw new Error('Tanggal kedaluwarsa harus berformat DD/MM/YYYY.');
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const valid = date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day);
  if (!valid) throw new Error('Tanggal kedaluwarsa tidak valid.');
  return `${year}-${month}-${day}`;
}
