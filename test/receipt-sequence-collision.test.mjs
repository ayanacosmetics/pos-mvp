import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../supabase/migrations/202607260026_receipt_sequence_collision_fix.sql',
  import.meta.url
);

test('receipt collision migration repairs counters and installs an insert guard', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /create or replace function public\.guard_sale_receipt_number_v1\(\)/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /before insert on public\.sales/i);
  assert.match(sql, /where tenant_id=new\.tenant_id\s+and receipt_no=new\.receipt_no/i);
  assert.match(sql, /new\.receipt_no:=v_prefix\|\|'-'\|\|lpad\(v_next::text,6,'0'\)/i);
  assert.match(sql, /greatest\(public\.document_sequences\.next_value,excluded\.next_value\)/i);
});
