import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('halaman supplier menyediakan direktori, pencarian, dan formulir tambah/edit', async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL('apps/web/index.html', root), 'utf8'),
    readFile(new URL('apps/web/app.js', root), 'utf8'),
    readFile(new URL('apps/web/styles.css', root), 'utf8'),
  ]);

  for (const id of ['supplier-metrics', 'supplier-search', 'supplier-list', 'supplier-form', 'supplier-edit-id']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(app, /function renderSupplierDirectory\(\)/);
  assert.match(app, /function openSupplierEditor\(supplierId/);
  assert.match(app, /method:id\?'PUT':'POST'/);
  assert.match(css, /\.supplier-directory-layout/);
  assert.match(css, /\.supplier-profile-form/);
});

test('API supplier memperbarui baris yang sama dan mencatat audit', async () => {
  const api = await readFile(new URL('api/index.mjs', root), 'utf8');
  assert.match(api, /request\.method==='PUT'&&\/\^suppliers\\\/\[\^\/\]\+\$\//);
  assert.match(api, /method:'PATCH',prefer:'return=representation'/);
  assert.match(api, /action:'SUPPLIER_UPDATED'/);
  assert.match(api, /Supplier dengan nama tersebut sudah terdaftar/);
});
