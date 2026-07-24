import test from 'node:test';
import assert from 'node:assert/strict';
import { formatExpiryValue, parseExpiryDate } from '../apps/web/date.mjs';

test('tanggal kedaluwarsa otomatis memakai format DD/MM/YYYY', () => {
  assert.equal(formatExpiryValue('31122028'), '31/12/2028');
  assert.equal(formatExpiryValue('31-12-2028'), '31/12/2028');
});

test('tanggal kedaluwarsa dikonversi ke format database dan divalidasi', () => {
  assert.equal(parseExpiryDate('29/02/2028'), '2028-02-29');
  assert.throws(() => parseExpiryDate('31/02/2028'), /tidak valid/);
  assert.throws(() => parseExpiryDate('2028-12-31'), /DD\/MM\/YYYY/);
});
