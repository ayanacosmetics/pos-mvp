import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { clearStoredAuth, loadAuth, saveAuth, shouldRefreshAuth } from '../apps/web/auth-store.mjs';

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    keys: () => [...values.keys()]
  };
}

test('sesi disimpan utuh dan dapat dipulihkan setelah reload', () => {
  const storage = memoryStorage();
  saveAuth({ token: 'access', refreshToken: 'refresh', expiresAt: 12345 }, {}, storage);
  assert.deepEqual(loadAuth(storage), { token: 'access', refreshToken: 'refresh', expiresAt: 12345 });
  assert.deepEqual(storage.keys(), ['pos_auth_v2']);
});

test('penyimpanan sesi lama dimigrasikan tanpa meminta login ulang', () => {
  const storage = memoryStorage({ pos_token: 'legacy-access', pos_refresh_token: 'legacy-refresh' });
  const auth = loadAuth(storage);
  assert.equal(auth.token, 'legacy-access');
  assert.equal(auth.refreshToken, 'legacy-refresh');
  assert.ok(storage.getItem('pos_auth_v2'));
  assert.equal(storage.getItem('pos_token'), null);
  assert.equal(storage.getItem('pos_refresh_token'), null);
});

test('keluar menghapus sesi baru dan lama', () => {
  const storage = memoryStorage({ pos_auth_v2: '{}', pos_token: 'access', pos_refresh_token: 'refresh' });
  clearStoredAuth(storage);
  assert.deepEqual(loadAuth(storage), { token: null, refreshToken: null, expiresAt: null });
});

test('sesi diperbarui sebelum access token kedaluwarsa', () => {
  assert.equal(shouldRefreshAuth({ token: 'access', refreshToken: 'refresh', expiresAt: 1060 }, 1000), true);
  assert.equal(shouldRefreshAuth({ token: 'access', refreshToken: 'refresh', expiresAt: 1061 }, 1000), false);
  assert.equal(shouldRefreshAuth({ token: null, refreshToken: 'refresh', expiresAt: null }, 1000), true);
  assert.equal(shouldRefreshAuth({ token: 'access', refreshToken: null, expiresAt: 999 }, 1000), false);
});

test('permintaan API menyegarkan token secara proaktif dan mengulang respons 401', async () => {
  const script = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
  const api = await readFile(new URL('../api/index.mjs', import.meta.url), 'utf8');
  assert.match(script, /shouldRefreshAuth\(state\)/);
  assert.match(script, /await refreshSession\(\)/);
  assert.match(script, /response\.status === 401[\s\S]*return request\(path, options, false\)/);
  assert.match(api, /\[401,403\]\.includes\(error\.status\)[\s\S]*error\.status = 401/);
});

test('bootstrap menampilkan cache dan katalog dasar sebelum memuat modul berat', async () => {
  const script = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
  assert.match(script, /const cached = localStorage\.getItem\('pos_bootstrap_cache'\)[\s\S]*applyBootstrap\(JSON\.parse\(cached\), \{ offline: true \}\)[\s\S]*Promise\.all\(\[request\('\/api\/bootstrap\?catalog=false'\),request\('\/api\/catalog'\)\]\)/);
  assert.match(script, /state\.managedProducts = state\.products\.map/);
  assert.match(script, /if \(!offline\) startDeferredBootstrapLoads\(\)/);
  assert.match(script, /Math\.min\(3,tasks\.length\)/);
  assert.match(script, /if\(target==='products'\)loadProductManagement\(\)/);
  assert.doesNotMatch(script, /can\('catalog\.manage'\) \? \[loadProductManagement\]/);
  assert.doesNotMatch(script, /if \(!offline[\s\S]{0,120}await loadPurchaseOrders/);
});

test('form login disembunyikan selama aplikasi memulihkan sesi', async () => {
  const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="session-view"/);
  assert.match(html, /id="login-view" class="login-view hidden"/);
  assert.match(script, /el\('session-view'\)\.classList\.add\('hidden'\)/);
});

test('logout mencabut sesi server, membersihkan cache pengguna, dan diteruskan ke tab lain', async () => {
  const script = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
  assert.match(script, /request\('\/api\/logout'/);
  assert.match(script, /JSON\.stringify\(\{ refreshToken: state\.refreshToken \}\)/);
  assert.match(script, /state\.session = null/);
  assert.match(script, /localStorage\.removeItem\('pos_bootstrap_cache'\)/);
  assert.match(script, /window\.addEventListener\('storage'[\s\S]*location\.reload\(\)/);
});
