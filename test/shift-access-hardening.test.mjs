import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('API shift memvalidasi nominal dan membatasi shift pada kasir serta outlet aktif', async () => {
  const api = await readFile(new URL('../api/index.mjs', import.meta.url), 'utf8');
  assert.match(api, /function moneyInput/);
  assert.match(api, /Modal awal[\s\S]*allowZero: true/);
  assert.match(api, /Jenis pergerakan kas tidak valid/);
  assert.match(api, /Shift aktif milik pengguna ini tidak ditemukan/);
  assert.match(api, /cashier_id=eq\.\$\{session\.authUser\.id\}/);
  assert.match(api, /outlet_id=eq\.\$\{context\.outlet\.id\}[\s\S]*cashier_id=eq\.\$\{session\.authUser\.id\}[\s\S]*status=eq\.OPEN/);
});

test('versi kandidat final tampil pada API, aplikasi, dan cache PWA', async () => {
  const [api, html, worker, pkgText] = await Promise.all([
    readFile(new URL('../api/index.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/service-worker.js', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8')
  ]);
  assert.match(api, /2\.16\.21-cloud/);
  assert.match(html, /Migrasi Kaspin .* v2\.16\.21/);
  assert.match(worker, /nusa-pos-shell-v132/);
  assert.equal(JSON.parse(pkgText).version, '2.16.21');
});
