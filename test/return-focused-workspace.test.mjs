import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('halaman retur fokus pada satu struk dan menyediakan pembatalan draft', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('apps/web/index.html', root), 'utf8'),
    readFile(new URL('apps/web/app.js', root), 'utf8')
  ]);

  assert.match(html, /id="cancel-return"[^>]*>Batalkan retur</);
  assert.match(app, /function cancelCustomerReturn\(\)/);
  assert.match(app, /state\.returnSale=null/);
  assert.doesNotMatch(html, /id="sale-return-history"/);
  assert.doesNotMatch(html, /id="return-recent-list"/);
  assert.doesNotMatch(html, /id="refresh-return-history"/);
  assert.doesNotMatch(app, /function loadRecentReturns\(\)/);
});
