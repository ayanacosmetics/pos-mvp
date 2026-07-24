import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('pemeriksaan kesehatan hanya dapat dijalankan Owner dan mencakup rekonsiliasi utama', async () => {
  const sql = await readFile(new URL('../supabase/migrations/202607230022_operational_health.sql', import.meta.url), 'utf8');
  assert.match(sql, /v_role<>'OWNER'/);
  assert.match(sql, /NEGATIVE_STOCK/);
  assert.match(sql, /STOCK_LEDGER_MISMATCH/);
  assert.match(sql, /PAYMENT_MISMATCH/);
  assert.match(sql, /CUSTOMER_BALANCE_MISMATCH/);
  assert.match(sql, /SUPPLIER_BALANCE_MISMATCH/);
  assert.match(sql, /SYNC_REVIEW/);
  assert.match(sql, /s\.grand_total-s\.credit_amount/);
  assert.match(sql, /grant execute[\s\S]*service_role/);
});

test('API kesehatan sistem dilindungi hak akses pengelolaan identitas', async () => {
  const api = await readFile(new URL('../api/index.mjs', import.meta.url), 'utf8');
  assert.match(api, /route === 'system\/health'/);
  assert.match(api, /requirePermission\(session, 'identity\.manage'\)/);
  assert.match(api, /operational_health_check/);
});

test('backoffice menyediakan pusat kesehatan dengan pemeriksaan ulang', async () => {
  const [html, script, style] = await Promise.all([
    readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8')
  ]);
  assert.match(html, /id="system-health-summary"/);
  assert.match(html, /id="refresh-system-health"/);
  assert.match(script, /loadSystemHealth/);
  assert.match(script, /Pembayaran langsung \+ piutang/);
  assert.match(style, /\.health-checks/);
});

test('PWA memiliki identitas aplikasi, ikon, cache, dan alur pemasangan Android Windows', async () => {
  const [manifestText, worker, script, icon192, icon512] = await Promise.all([
    readFile(new URL('../apps/web/manifest.webmanifest', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/service-worker.js', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/icon-192.svg', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/icon-512.svg', import.meta.url), 'utf8')
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.icons.length, 2);
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ['192x192', '512x512']);
  assert.match(worker, /icon-192\.svg/);
  assert.match(worker, /icon-512\.svg/);
  assert.match(script, /beforeinstallprompt/);
  assert.match(script, /appinstalled/);
  assert.match(icon192, /width="192"/);
  assert.match(icon512, /width="512"/);
});
