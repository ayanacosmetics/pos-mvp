import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('sidebar memakai accordion subfitur untuk seluruh modul', async () => {
  const [html, script, css] = await Promise.all([
    read('../apps/web/index.html'), read('../apps/web/app.js'), read('../apps/web/styles.css')
  ]);
  for (const group of ['sales','inventory','restock','relations','growth','insights','system']) {
    assert.match(html, new RegExp(`data-nav-group="${group}"`));
    assert.match(html, new RegExp(`data-nav-panel="${group}"`));
  }
  assert.doesNotMatch(html, /id="feature-nav"/);
  assert.match(html, /<nav id="nav">[\s\S]*data-nav-group="sales"[\s\S]*data-nav-panel="sales"[\s\S]*data-nav-group="inventory"/);
  assert.match(script, /function openNavGroup/);
  assert.match(script, /function syncNavigationPermissions/);
  assert.match(script, /aria-expanded/);
  assert.match(css, /\.feature-nav-panel\.active\{display:grid\}/);
  assert.match(css, /\.feature-nav-panel\{[^}]*border-left/);
});

test('fitur gabungan dipisahkan menjadi tujuan halaman sendiri', async () => {
  const [html, script] = await Promise.all([
    read('../apps/web/index.html'), read('../apps/web/app.js')
  ]);
  assert.match(html, /id="page-promotions"/);
  assert.match(html, /id="page-loyalty"/);
  assert.match(html, /id="page-customers"/);
  assert.match(html, /id="page-suppliers"/);
  for (const view of ['list','expiry','count','ledger']) assert.match(html, new RegExp(`data-stock-view="${view}"`));
  assert.match(html,/data-page="outlet-transfer-request"/);
  assert.match(html,/data-page="outlet-transfer-approval"/);
  assert.match(html,/data-page="outlet-in-transit"/);
  for (const view of ['planning','documents','receipt','supplier-return']) assert.match(html, new RegExp(`data-purchase-view-target="${view}"`));
  assert.match(html, /id="purchase-view-order"/);
  for (const view of ['summary','performance','purchases','purchases-history','sales','audit']) assert.match(html, new RegExp(`data-report-view="${view}"`));
  assert.doesNotMatch(html,/data-report-view="sales-history"/);
  for (const view of ['business','outlets','locations','device','health']) assert.match(html, new RegExp(`data-settings-view="${view}"`));
  assert.match(script, /function showStockView/);
  assert.match(script, /function showReportView/);
  assert.match(script, /function showSettingsView/);
});
