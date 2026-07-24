import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { clearStoredAuth, loadAuth, saveAuth } from '../apps/web/auth-store.mjs';

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

test('sesi disimpan utuh dan dapat dipulihkan setelah reload', () => {
  const storage = memoryStorage();
  saveAuth({ token: 'access', refreshToken: 'refresh', expiresAt: 12345 }, {}, storage);
  assert.deepEqual(loadAuth(storage), { token: 'access', refreshToken: 'refresh', expiresAt: 12345 });
});

test('penyimpanan sesi lama dimigrasikan tanpa meminta login ulang', () => {
  const storage = memoryStorage({ pos_token: 'legacy-access', pos_refresh_token: 'legacy-refresh' });
  const auth = loadAuth(storage);
  assert.equal(auth.token, 'legacy-access');
  assert.equal(auth.refreshToken, 'legacy-refresh');
  assert.ok(storage.getItem('pos_auth_v2'));
});

test('keluar menghapus sesi baru dan lama', () => {
  const storage = memoryStorage({ pos_auth_v2: '{}', pos_token: 'access', pos_refresh_token: 'refresh' });
  clearStoredAuth(storage);
  assert.deepEqual(loadAuth(storage), { token: null, refreshToken: null, expiresAt: null });
});

test('form login disembunyikan selama aplikasi memulihkan sesi', async () => {
  const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="session-view"/);
  assert.match(html, /id="login-view" class="login-view hidden"/);
  assert.match(script, /el\('session-view'\)\.classList\.add\('hidden'\)/);
});
