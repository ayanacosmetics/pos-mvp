import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  calculateEmployeeCommission,
  employeeTargetProgress,
  reconcilePaymentMethods,
} from '../packages/domain/src/employee-operations.mjs';

const migration = await readFile(
  new URL('../supabase/migrations/202607270029_employee_operations.sql', import.meta.url),
  'utf8',
);
const api = await readFile(new URL('../api/index.mjs', import.meta.url), 'utf8');
const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');

test('komisi mendukung persen penjualan dan nominal per transaksi', () => {
  assert.equal(calculateEmployeeCommission({
    salesTotal: 10_000_000,
    transactions: 80,
    commissionType: 'SALES_PERCENT',
    commissionValue: 1.5,
  }), 150_000);
  assert.equal(calculateEmployeeCommission({
    salesTotal: 10_000_000,
    transactions: 80,
    commissionType: 'FIXED_PER_TRANSACTION',
    commissionValue: 2_000,
  }), 160_000);
  assert.equal(employeeTargetProgress(7_500_000, 10_000_000), 75);
  assert.throws(() => calculateEmployeeCommission({
    commissionType: 'SALES_PERCENT',
    commissionValue: 101,
  }), /maksimal 100/);
});

test('rekonsiliasi shift membandingkan setiap metode dan mewajibkan tunai', () => {
  assert.deepEqual(reconcilePaymentMethods(
    [{ method: 'CASH', expectedAmount: 500_000 }, { method: 'QRIS', expectedAmount: 250_000 }],
    [{ method: 'cash', declaredAmount: 499_000 }, { method: 'QRIS', declaredAmount: 250_000 }],
  ), [
    { method: 'CASH', expectedAmount: 500_000, declaredAmount: 499_000, difference: -1_000 },
    { method: 'QRIS', expectedAmount: 250_000, declaredAmount: 250_000, difference: 0 },
  ]);
  assert.throws(() => reconcilePaymentMethods(
    [{ method: 'QRIS', expectedAmount: 1 }],
    [{ method: 'QRIS', declaredAmount: 1 }],
  ), /tunai wajib/);
});

test('fondasi operasional karyawan mencakup database, API, hak akses, dan halaman terpisah', () => {
  for (const table of [
    'employee_schedules',
    'attendance_records',
    'employee_targets',
    'approval_policies',
    'approval_requests',
    'shift_reconciliations',
  ]) assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
  assert.match(migration, /clock_employee_attendance/);
  assert.match(migration, /decide_approval_request/);
  assert.match(migration, /close_shift_with_reconciliation/);
  assert.match(migration, /Pemohon tidak dapat menyetujui permintaan sendiri/);
  assert.match(api, /workforce\/overview/);
  assert.match(api, /workforce\/attendance/);
  assert.match(api, /workforce\/reconciliations/);
  assert.match(api, /approval\.manage/);
  for (const page of [
    'workforce-schedule',
    'workforce-targets',
    'workforce-approvals',
    'workforce-activity',
    'workforce-reconciliation',
  ]) assert.match(html, new RegExp(`id="page-${page}"`));
  assert.match(app, /shift-declared-payment/);
  assert.match(app, /loadWorkforceOverview/);
});
