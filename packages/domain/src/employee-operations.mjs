function nonNegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} tidak valid`);
  return number;
}

export function calculateEmployeeCommission({
  salesTotal = 0,
  transactions = 0,
  commissionType = 'SALES_PERCENT',
  commissionValue = 0,
} = {}) {
  const sales = nonNegative(salesTotal, 'Total penjualan');
  const count = Math.trunc(nonNegative(transactions, 'Jumlah transaksi'));
  const value = nonNegative(commissionValue, 'Nilai komisi');
  if (commissionType === 'SALES_PERCENT') {
    if (value > 100) throw new Error('Persentase komisi maksimal 100');
    return Math.round((sales * value / 100) * 100) / 100;
  }
  if (commissionType === 'FIXED_PER_TRANSACTION') return Math.round((count * value) * 100) / 100;
  throw new Error('Jenis komisi tidak valid');
}

export function employeeTargetProgress(actual = 0, target = 0) {
  const actualValue = nonNegative(actual, 'Realisasi');
  const targetValue = nonNegative(target, 'Target');
  return targetValue === 0 ? 0 : Math.min(100, Math.round(actualValue / targetValue * 10000) / 100);
}

export function reconcilePaymentMethods(expectedRows = [], declaredRows = []) {
  const declared = new Map(declaredRows.map((row) => [
    String(row.method ?? '').trim().toUpperCase(),
    nonNegative(row.declaredAmount, 'Jumlah deklarasi'),
  ]));
  const result = expectedRows.map((row) => {
    const method = String(row.method ?? '').trim().toUpperCase();
    if (!method || !declared.has(method)) throw new Error(`Deklarasi ${method || 'pembayaran'} wajib diisi`);
    const expectedAmount = nonNegative(row.expectedAmount, 'Jumlah sistem');
    const declaredAmount = declared.get(method);
    return { method, expectedAmount, declaredAmount, difference: declaredAmount - expectedAmount };
  });
  if (!result.some((row) => ['CASH', 'TUNAI'].includes(row.method))) throw new Error('Rekonsiliasi tunai wajib tersedia');
  return result;
}
