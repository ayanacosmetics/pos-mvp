import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  meaningfulRestockDraft,
  readRestockDraft,
  removeRestockDraft,
  restockDraftStorageKey,
  writeRestockDraft
} from '../apps/web/restock-draft.mjs';

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

test('draft penerimaan terisolasi untuk setiap staf dan outlet', () => {
  assert.notEqual(restockDraftStorageKey('staff-a', 'outlet-1'), restockDraftStorageKey('staff-b', 'outlet-1'));
  assert.notEqual(restockDraftStorageKey('staff-a', 'outlet-1'), restockDraftStorageKey('staff-a', 'outlet-2'));
  assert.equal(restockDraftStorageKey(null, 'outlet-1'), null);
});

test('draft kosong tidak disimpan dan draft barang dapat dipulihkan', () => {
  const storage = memoryStorage(), key = restockDraftStorageKey('staff-a', 'outlet-1');
  assert.equal(writeRestockDraft(storage, key, { documentNo: '', lines: [] }), false);
  const draft = { documentNo: 'INV-17', wizardStep: 'items', lines: [{ productId: 'p1', qty: '4' }], updatedAt: '2026-08-07T10:00:00.000Z' };
  assert.equal(meaningfulRestockDraft(draft), true);
  assert.equal(writeRestockDraft(storage, key, draft), true);
  assert.deepEqual(readRestockDraft(storage, key), { ...draft, version: 1 });
  removeRestockDraft(storage, key);
  assert.equal(readRestockDraft(storage, key), null);
});

test('draft rusak dibuang aman dan kegagalan penyimpanan tidak merusak alur', () => {
  const key = restockDraftStorageKey('staff-a', 'outlet-1');
  const corrupt = memoryStorage({ [key]: '{rusak' });
  assert.equal(readRestockDraft(corrupt, key), null);
  const full = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  assert.equal(writeRestockDraft(full, key, { documentNo: 'INV-18', lines: [] }), false);
});

test('halaman penerimaan mempertahankan langkah, autosave saat pindah ke Kasir, dan menghapus draft hanya setelah posting', async () => {
  const [app, html, worker] = await Promise.all([
    readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/service-worker.js', import.meta.url), 'utf8')
  ]);
  assert.match(app, /showPurchaseView[\s\S]*restockDraftHasContent\(\)\?state\.restockWizardStep:'document'/);
  assert.match(app, /receiptOpen[\s\S]*saveRestockDraftNow\(\)/);
  assert.match(app, /pagehide',saveRestockDraftNow/);
  assert.match(app, /visibilitychange'[\s\S]*document\.hidden[\s\S]*saveRestockDraftNow/);
  assert.match(app, /function pauseRestockReceipt/);
  assert.match(app, /Draft tersimpan\. Silakan tutup shift, absen, atau logout/);
  assert.match(app, /const receipt = await request\(endpoint[\s\S]*clearRestockDraft\(\)[\s\S]*renderRestock\(\{preserveDraft:false\}\)/);
  assert.match(app, /submitRestockForApproval[\s\S]*clearRestockDraft\(\)/);
  assert.match(app, /window\.confirm\(`Batalkan draft penerimaan/);
  assert.match(html, /id="restock-draft-banner"[\s\S]*id="discard-restock-draft"/);
  assert.match(html, /id="pause-restock-receipt"/);
  assert.match(html, /id="pause-restock-line-dialog"/);
  assert.match(worker, /\/restock-draft\.mjs/);
});
