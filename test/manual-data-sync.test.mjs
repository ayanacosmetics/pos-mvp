import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('sidebar menyediakan sinkronisasi manual dengan waktu terakhir per akun dan outlet', async () => {
  const [html, script, css] = await Promise.all([
    readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8')
  ]);

  assert.match(html, /class="brand"[\s\S]*id="sync-now"[\s\S]*<nav id="nav">/);
  assert.match(html, /id="sync-last-time">Belum disinkronkan/);
  assert.match(script, /function lastSyncStorageKey\(\)/);
  assert.match(script, /pos_last_manual_sync:[^`]*state\.session\?\.user\?\.id[^`]*state\.activeOutletId/);
  assert.match(script, /async function synchronizeData\(\)/);
  assert.match(script, /await refreshCatalog\(\)/);
  assert.match(script, /await updateQuote\(\)/);
  assert.match(script, /function recordLastSync\(value = new Date\(\)\.toISOString\(\)\)/);
  assert.match(script, /localStorage\.setItem\(lastSyncStorageKey\(\), value\)/);
  assert.match(script, /await applyBootstrap\(data\);\s*recordLastSync\(\)/);
  assert.match(script, /el\('sync-now'\)\.addEventListener\('click', synchronizeData\)/);
  assert.match(css, /\.sidebar-sync\{/);
  assert.match(css, /\.sidebar-sync\.syncing/);
});
