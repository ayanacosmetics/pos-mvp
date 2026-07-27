import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = await readFile(
  new URL('../apps/android-cashier/app/src/main/AndroidManifest.xml', import.meta.url),
  'utf8',
);
const activity = await readFile(
  new URL(
    '../apps/android-cashier/app/src/main/java/app/kasirnusa/cashier/MainActivity.java',
    import.meta.url,
  ),
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
const webScanner = await readFile(
  new URL('../apps/web/bluetooth-scanner.mjs', import.meta.url),
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
  assert.match(webApp, /addEventListener\('kasirnusa:barcode'/);
  assert.match(webApp, /handleNativeScannerBarcode/);
});

test('scanner dapat dipilih langsung dari aplikasi Android dan membaca mode SPP', () => {
  assert.match(manifest, /android\.software\.companion_device_setup/);
  assert.match(activity, /CompanionDeviceManager/);
  assert.match(activity, /AssociationRequest/);
  assert.match(activity, /REQUEST_SCANNER_ASSOCIATION/);
  assert.match(activity, /connectScannerSocket/);
  assert.match(activity, /socket\.getInputStream\(\)/);
  assert.match(activity, /__kasirNusaNativeScannerResponse/);
  assert.match(webScanner, /nativeRequest\('connectScanner'\)/);
  assert.match(webScanner, /nativeRequest\('disconnectScanner'\)/);
  assert.match(webApp, /connectSalesScanner/);
  assert.match(webHtml, /id="connect-scanner-pos"/);
  assert.match(webHtml, /id="scanner-connection-card"/);
});

test('scanner HID tetap menjadi fallback ketika profil SPP tidak tersedia', () => {
  assert.match(activity, /putString\(SCANNER_MODE, "HID"\)/);
  assert.match(activity, /dipasangkan sebagai scanner HID/);
  assert.match(activity, /"HID"\.equals\(preferences\.getString\(SCANNER_MODE/);
  assert.match(webApp, /Tes aktif · scan satu barcode sekarang/);
});

test('Android startup never touches unavailable Web Serial and has a login watchdog', () => {
  assert.match(webApp, /typeof navigator !== 'undefined' && navigator\.serial/);
  assert.doesNotMatch(webApp, /if \(supportsBluetoothClassicPrinting\(\)\) \{\s*navigator\.serial/);
  assert.match(webHtml, /Pemulihan sesi terlalu lama[\s\S]*12000/);
});
