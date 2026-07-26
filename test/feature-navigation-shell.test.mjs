import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('sidebar memakai kelompok dan panel fitur kedua untuk seluruh modul', async () => {
  const [html, script, css] = await Promise.all([
    read('../apps/web/index.html'), read('../apps/web/app.js'), read('../apps/web/styles.css')
  ]);
  for (const group of ['sales','inventory','relations','growth','insights','system']) {
    assert.match(html, new RegExp(`data-nav-group="${group}"`));
    assert.match(html, new RegExp(`data-nav-panel="${group}"`));
  }
  assert.match(html, /id="feature-nav"/);
  assert.match(script, /function openNavGroup/);
  assert.match(script, /function syncNavigationPermissions/);
  assert.match(css, /\.app\.feature-nav-open/);
});

test('fitur gabungan dipisahkan menjadi tujuan halaman sendiri', async () => {
  const [html, script] = await Promise.all([
    read('../apps/web/index.html'), read('../apps/web/app.js')
  ]);
  assert.match(html, /id="page-promotions"/);
  assert.match(html, /id="page-loyalty"/);
  assert.match(html, /id="page-customers"/);
  assert.match(html, /id="page-suppliers"/);
  for (const view of ['list','expiry','transfer','count','ledger']) assert.match(html, new RegExp(`data-stock-view="${view}"`));
  for (const view of ['planning','documents','order','receipt','supplier-return']) assert.match(html, new RegExp(`data-purchase-view-target="${view}"`));
  for (const view of ['summary','performance','purchases','sales','audit']) assert.match(html, new RegExp(`data-report-view="${view}"`));
  for (const view of ['business','outlets','locations','device','health']) assert.match(html, new RegExp(`data-settings-view="${view}"`));
  assert.match(script, /function showStockView/);
  assert.match(script, /function showReportView/);
  assert.match(script, /function showSettingsView/);
});
