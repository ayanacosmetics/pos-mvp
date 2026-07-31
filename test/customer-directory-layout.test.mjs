import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('halaman pelanggan menjaga ringkasan dan kepala kolom saat daftar digulir', async () => {
  const [app,styles] = await Promise.all([
    read('../apps/web/app.js'),
    read('../apps/web/styles.css')
  ]);
  assert.match(app,/customer-directory-table/);
  assert.match(styles,/#page-customers>\.content-width\{[\s\S]*height:calc\(100dvh - 74px\)[\s\S]*overflow:hidden/);
  assert.match(styles,/#page-customers>\.content-width\{[\s\S]*padding:14px 32px 0/);
  assert.match(styles,/#page-customers>\.content-width>\.page-title\{margin-bottom:9px\}/);
  assert.match(styles,/#page-customers #crm-metrics \.metric\{[\s\S]*min-height:48px/);
  assert.match(styles,/\.customer-account-list\{min-height:0;flex:1;margin:0;overflow:hidden\}/);
  assert.match(styles,/\.customer-table-wrap\{[\s\S]*height:100%[\s\S]*overflow:auto[\s\S]*scrollbar-gutter:stable/);
  assert.match(styles,/\.customer-directory-table th\{position:sticky;[\s\S]*top:0/);
});
