import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = await readFile(
  new URL('../apps/android-cashier/app/src/main/AndroidManifest.xml', import.meta.url),
  'utf8',
);
const activity = await readFile(
  new URL('../apps/android-cashier/app/src/main/java/app/kasirnusa/cashier/MainActivity.java', import.meta.url),
  'utf8',
);
const androidBuild = await readFile(
  new URL('../apps/android-cashier/app/build.gradle', import.meta.url),
  'utf8',
);
const webPrinter = await readFile(
  new URL('../apps/web/escpos-printer.mjs', import.meta.url),
  'utf8',
);
const webApp = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
const webHtml = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8');

test('Android cashier app locks its WebView to the production POS and blocks unsafe file access', () => {
  assert.match(androidBuild, /applicationId\s+"app\.kasirnusa\.cashier"/);
  assert.match(androidBuild, /https:\/\/kasir-nusa-pos\.vercel\.app/);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(manifest, /android\.permission\.INTERNET/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_CONNECT/);
  assert.match(activity, /TRUSTED_HOST\s*=\s*"kasir-nusa-pos\.vercel\.app"/);
  assert.match(activity, /setAllowFileAccess\(false\)/);
  assert.match(activity, /setAllowContentAccess\(false\)/);
  assert.match(activity, /MIXED_CONTENT_NEVER_ALLOW/);
});

test('Android cashier app prints ESC/POS through the Bluetooth Classic SPP profile', () => {
  assert.match(activity, /00001101-0000-1000-8000-00805f9b34fb/);
  assert.match(activity, /createInsecureRfcommSocketToServiceRecord/);
  assert.match(activity, /createRfcommSocketToServiceRecord/);
  assert.match(activity, /output\.write\(bytes\)/);
  assert.match(activity, /__kasirNusaNativePrinterResponse/);
  assert.match(webPrinter, /window\.KasirNusaAndroid/);
  assert.match(webPrinter, /nativeRequest\('connectPrinter'\)/);
  assert.match(webPrinter, /nativeRequest\('printBase64'/);
});

test('Bluetooth HID scanner input is forwarded to the active POS page', () => {
  assert.match(activity, /InputDevice\.SOURCE_KEYBOARD/);
  assert.match(activity, /kasirnusa:barcode/);
  assert.match(activity, /now - scannerLastKeyAt > 250/);
  assert.match(activity, /dispatchKeyEvent\(KeyEvent event\)/);
  assert.match(activity, /KEYCODE_ENTER/);
  assert.match(webApp, /addEventListener\('kasirnusa:barcode'/);
  assert.match(webApp, /handleNativeScannerBarcode/);
});

test('scanner dipasangkan dari Bluetooth Android dan aplikasi tidak mengambil alih koneksi SPP', () => {
  assert.doesNotMatch(manifest, /android\.software\.companion_device_setup/);
  assert.doesNotMatch(activity, /CompanionDeviceManager|AssociationRequest|connectScannerSocket/);
  assert.doesNotMatch(activity, /connectScanner\s*\(|__kasirNusaNativeScannerResponse/);
  assert.doesNotMatch(webApp, /connectSalesScanner|connectBluetoothScanner/);
  assert.doesNotMatch(webHtml, /id="connect-scanner-pos"|id="scanner-connection-card"/);
  assert.match(webHtml, /Pasangkan sebagai keyboard\/HID dari Pengaturan Bluetooth Android/);
});

test('APK pembaruan mempertahankan printer SPP tetapi scanner hanya memakai HID', () => {
  assert.match(androidBuild, /versionCode 3/);
  assert.match(androidBuild, /versionName "1\.1\.1-test"/);
  assert.match(activity, /KasirNusaAndroid\/1\.1\.1/);
  assert.doesNotMatch(activity, /SCANNER_MODE|scannerSocket|scannerReader/);
});

test('Android startup never touches unavailable Web Serial and has a login watchdog', () => {
  assert.match(webApp, /typeof navigator !== 'undefined' && navigator\.serial/);
  assert.doesNotMatch(webApp, /if \(supportsBluetoothClassicPrinting\(\)\) \{\s*navigator\.serial/);
  assert.match(webHtml, /Pemulihan sesi terlalu lama[\s\S]*12000/);
});
