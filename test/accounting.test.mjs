import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateJournalLines, summarizeAccountingBalances } from '../packages/domain/src/ledger.mjs';

const text = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('jurnal manual wajib seimbang dan hanya mengisi satu sisi per baris', () => {
  const valid = validateJournalLines([
    { accountId: 'cash', debit: 500000, credit: 0 },
    { accountId: 'equity', debit: 0, credit: 500000 }
  ]);
  assert.equal(valid.debit, 500000);
  assert.equal(valid.credit, 500000);
  assert.throws(() => validateJournalLines([
    { accountId: 'cash', debit: 500000, credit: 0 },
    { accountId: 'equity', debit: 0, credit: 400000 }
  ]), /harus sama/);
  assert.throws(() => validateJournalLines([
    { accountId: 'cash', debit: 1, credit: 1 },
    { accountId: 'equity', debit: 0, credit: 1 }
  ]), /debit atau kredit/);
});

test('ringkasan neraca memasukkan laba berjalan ke sisi modal', () => {
  const summary = summarizeAccountingBalances([
    { type: 'ASSET', ending: 1500000 },
    { type: 'LIABILITY', ending: -400000 },
    { type: 'EQUITY', ending: -600000 },
    { type: 'REVENUE', ending: -700000 },
    { type: 'EXPENSE', ending: 200000 }
  ]);
  assert.deepEqual(summary, {
    assets: 1500000, liabilities: 400000, equity: 600000,
    revenue: 700000, expenses: 200000, netIncome: 500000, difference: 0
  });
});

test('migration v2.1 menyediakan buku besar tenant-safe dan sinkronisasi operasional idempoten', async () => {
  const sql = await text('../supabase/migrations/202607270033_core_accounting.sql');
  for (const table of ['chart_of_accounts','accounting_periods','journal_entries','journal_lines']) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  for (const fn of ['sync_accounting_v1','post_manual_journal_v1','reverse_manual_journal_v1','close_accounting_period_v1','report_core_accounting_v1']) {
    assert.match(sql, new RegExp(`function public\\.${fn}`));
  }
  for (const source of ['SALE','SALE_VOID','CUSTOMER_RETURN','PURCHASE_RECEIPT','CUSTOMER_PAYMENT','SUPPLIER_PAYMENT','SUPPLIER_RETURN','OUTLET_EXPENSE']) {
    assert.ok(sql.includes(`'${source}'`), `${source} harus disinkronkan`);
  }
  assert.match(sql, /journal_entries_source_once/);
  assert.match(sql, /role='OWNER'/);
  assert.match(sql, /round\(v_total_debit,2\)<>round\(v_total_credit,2\)/);
  assert.match(sql, /Transaksi bertanggal pada periode akuntansi yang sudah ditutup/);
  assert.match(sql, /perform sync_accounting_v1\(p_tenant_id,p_actor_id\)/);
});

test('API dan sidebar menyediakan enam halaman akuntansi Owner yang terpisah', async () => {
  const [api, html, worker, pkg] = await Promise.all([
    text('../api/index.mjs'), text('../apps/web/index.html'),
    text('../apps/web/service-worker.js'), text('../package.json')
  ]);
  for (const page of ['accounting-accounts','accounting-journals','accounting-ledger','accounting-trial-balance','accounting-balance-sheet','accounting-periods']) {
    assert.match(html, new RegExp(`data-page="${page}"[\\s\\S]*data-permission="finance\\.owner"`));
    assert.match(html, new RegExp(`id="page-${page}"`));
  }
  for (const route of ['accounting/dashboard','accounting/sync','accounting/journals','accounting/periods']) {
    assert.ok(api.includes(route));
  }
  assert.match(api, /requirePermission\(session,'finance\.owner'\)/);
  assert.ok(api.includes("version: '2.17.1-cloud'"));
  assert.match(worker, /nusa-pos-shell-v169/);
  assert.equal(JSON.parse(pkg).version, '2.17.1');
});
