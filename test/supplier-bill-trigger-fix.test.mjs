import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [fix, original] = await Promise.all([
  readFile(new URL('../supabase/migrations/202607270034_supplier_bill_trigger_receipt_id_fix.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/202607230021_supplier_payables.sql', import.meta.url), 'utf8')
]);

test('hotfix mengganti fungsi trigger hutang supplier yang menyebabkan penerimaan gagal', () => {
  assert.match(original, /old\.receipt_id/);
  assert.match(fix, /create or replace function public\.sync_supplier_bill_trigger\(\)/);
  assert.match(fix, /perform public\.sync_supplier_bill\(v_receipt_id\)/);
});

test('field trigger dipilih aman sesuai tabel sumber', () => {
  for (const table of ['purchase_receipts','purchase_receipt_items','supplier_returns']) {
    assert.match(fix, new RegExp(`tg_table_name='${table}'`));
  }
  assert.match(fix, /to_jsonb\(old\)/);
  assert.match(fix, /to_jsonb\(new\)/);
  assert.doesNotMatch(fix, /\bold\.receipt_id\b|\bnew\.receipt_id\b/);
});

test('trigger tetap mengembalikan OLD untuk delete dan NEW untuk insert atau update', () => {
  assert.match(fix, /if tg_op='DELETE' then[\s\S]*return old/);
  assert.match(fix, /return new/);
  assert.match(fix, /v_receipt_id is not null/);
});
