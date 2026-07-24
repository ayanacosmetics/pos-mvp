import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSIONS, can, permissionsFor } from '../packages/domain/src/index.mjs';

test('kasir dapat menjual tetapi tidak melihat modal', () => {
  const session = { permissions: permissionsFor('CASHIER') };
  assert.equal(can(session, PERMISSIONS.POS_SELL), true);
  assert.equal(can(session, PERMISSIONS.VIEW_COST), false);
});

test('pembelian dapat melihat modal dan menerima barang', () => {
  const session = { permissions: permissionsFor('PURCHASING') };
  assert.equal(can(session, PERMISSIONS.VIEW_COST), true);
  assert.equal(can(session, PERMISSIONS.RECEIVE_PURCHASE), true);
  assert.equal(can(session, PERMISSIONS.MANAGE_USERS), false);
});
