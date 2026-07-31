import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readUi = async () => Promise.all([
  readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8')
]);

test('tombol member, scanner restok, dan kamera memakai ikon persegi tanpa teks visual', async () => {
  const [html, css] = await readUi();
  for (const id of ['scan-po-product', 'camera-po-product', 'scan-restock-product', 'camera-restock-product', 'open-pos-customer', 'scan-camera-pos']) {
    const button = html.match(new RegExp(`<button id="${id}"[^>]*>([\\s\\S]*?)<\\/button>`))?.[0] ?? '';
    assert.match(button, /scan-icon-button/);
    assert.match(button, /aria-label="[^"]+"/);
    assert.match(button, /<svg /);
    assert.doesNotMatch(button, />\s*(Scanner|Kamera|Scan kamera)\s*</);
  }
  for (const id of ['scan-po-product', 'scan-restock-product']) {
    const button = html.match(new RegExp(`<button id="${id}"[^>]*>([\\s\\S]*?)<\\/button>`))?.[0] ?? '';
    assert.match(button, /hardware-scan-button[^>]*aria-label="Aktifkan scanner barcode"/);
  }
  assert.match(html, /id="open-pos-customer"[^>]*aria-label="Pilih atau tambah pelanggan"[^>]*>[\s\S]*M14 12h8/);
  assert.doesNotMatch(html, /id="connect-scanner-pos"/);
  assert.match(css, /\.scan-icon-button\{[^}]*width:44px!important;[^}]*height:44px/);
});

test('navigasi PWA mobile memakai drawer kiri dengan hamburger dan tidak menimpa konten saat tertutup', async () => {
  const [html, css] = await readUi();
  const script = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="app-sidebar"/);
  assert.match(html, /id="sidebar-toggle"[^>]*aria-controls="app-sidebar"[^>]*aria-expanded="false"/);
  assert.match(html, /id="sidebar-backdrop"/);
  assert.match(css, /\.sidebar\{position:fixed;[^}]*inset:0 auto 0 0;[^}]*transform:translateX\(-105%\)/);
  assert.match(css, /\.app\.sidebar-open \.sidebar\{transform:translateX\(0\)\}/);
  assert.match(css, /\.brand>span:last-child,\.nav-item\{font-size:0\}/);
  assert.match(css, /\.nav-item,\.nav-item:not\(\.active\)\{[^}]*font-size:inherit/);
  assert.match(script, /function setSidebarOpen/);
  assert.match(script, /sidebar\.inert = mobile && !open/);
  assert.match(script, /event\.key === 'Escape'/);
  assert.match(script, /showPage\(button\.dataset\.page\);[\s\S]*if\(mobileSidebarMedia\.matches\)setSidebarOpen\(false\);/);
});

test('kamera PWA memakai BarcodeDetector dengan fallback ZXing lokal dan kebijakan izin kamera', async () => {
  const [html, script, worker, vendor, vercelText] = await Promise.all([
    readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/service-worker.js', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/vendor/zxing-browser.min.js', import.meta.url), 'utf8'),
    readFile(new URL('../vercel.json', import.meta.url), 'utf8')
  ]);
  assert.match(html, /src="\/vendor\/zxing-browser\.min\.js"/);
  assert.ok(vendor.length > 300000);
  assert.match(script, /'BarcodeDetector' in window/);
  assert.match(script, /window\.ZXingBrowser\?\.BrowserMultiFormatReader/);
  assert.match(script, /decodeFromStream\(barcodeCameraStream/);
  assert.match(script, /window\.isSecureContext/);
  assert.match(script, /NotAllowedError/);
  assert.match(script, /barcode-camera-dialog'\)\.addEventListener\('close', stopBarcodeCamera\)/);
  assert.match(script, /window\.addEventListener\('pagehide', stopBarcodeCamera\)/);
  assert.match(worker, /nusa-pos-shell-v160/);
  assert.match(worker, /\/vendor\/zxing-browser\.min\.js/);
  const vercel = JSON.parse(vercelText);
  assert.ok(vercel.headers.some((entry) => entry.headers?.some((header) => header.key === 'Permissions-Policy' && header.value === 'camera=(self)')));
});
