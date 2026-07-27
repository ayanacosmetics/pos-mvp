const amount = (value) => {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) throw new Error('Nominal jurnal tidak valid');
  return Math.round(number * 100) / 100;
};

export function validateJournalLines(input) {
  if (!Array.isArray(input) || input.length < 2 || input.length > 100) {
    throw new Error('Jurnal harus memiliki 2–100 baris');
  }
  const lines = input.map((line) => {
    if (!line?.accountId) throw new Error('Akun jurnal wajib dipilih');
    const debit = amount(line.debit);
    const credit = amount(line.credit);
    if ((debit > 0) === (credit > 0)) throw new Error('Setiap baris harus memiliki debit atau kredit positif');
    return { ...line, debit, credit };
  });
  const debit = Math.round(lines.reduce((sum, line) => sum + line.debit, 0) * 100) / 100;
  const credit = Math.round(lines.reduce((sum, line) => sum + line.credit, 0) * 100) / 100;
  if (debit <= 0 || debit !== credit) throw new Error('Total debit dan kredit harus sama');
  return { lines, debit, credit };
}

export function summarizeAccountingBalances(rows) {
  const summary = { assets: 0, liabilities: 0, equity: 0, revenue: 0, expenses: 0 };
  for (const row of rows ?? []) {
    const ending = Number(row.ending ?? 0);
    if (row.type === 'ASSET') summary.assets += ending;
    if (row.type === 'LIABILITY') summary.liabilities -= ending;
    if (row.type === 'EQUITY') summary.equity -= ending;
    if (row.type === 'REVENUE') summary.revenue -= ending;
    if (row.type === 'EXPENSE') summary.expenses += ending;
  }
  summary.netIncome = summary.revenue - summary.expenses;
  summary.difference = summary.assets - (summary.liabilities + summary.equity + summary.netIncome);
  return Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, Math.round(value * 100) / 100]));
}
