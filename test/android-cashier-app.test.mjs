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
const androidStrings = await readFile(
  new URL('../apps/android-cashier/app/src/main/res/values/strings.xml', import.meta.url),
  'utf8',
);
const androidIcon = await readFile(
  new URL('../apps/android-cashier/app/src/main/res/drawable/ic_launcher.xml', import.meta.url),
  'utf8',
);
const pwaIcon = await readFile(new URL('../apps/web/icon-512.svg', import.meta.url), 'utf8');
const releaseApkUrl = new URL('../releases/Kasir-Nusa-POS-1.3.0-uat.apk', import.meta.url);
const publicApkUrl = new URL('../apps/web/downloads/Kasir-Nusa-POS-1.3.0-uat.apk', import.meta.url);
const finalReleaseApkUrl = new URL('../releases/Kasir-Nusa-POS-1.4.3.apk', import.meta.url);
const publicFinalApkUrl = new URL('../apps/web/downloads/Kasir-Nusa-POS-1.4.3.apk', import.meta.url);
const vercelConfig = await readFile(new URL('../vercel.json', import.meta.url), 'utf8');

test('Android cashier app locks its WebView to the production POS and blocks unsafe file access', () => {
  assert.match(androidBuild, /applicationId\s+"app\.kasirnusa\.cashier"/);
  assert.match(androidBuild, /https:\/\/app\.nusapos\.my\.id/);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(manifest, /android\.permission\.INTERNET/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_CONNECT/);
  assert.match(activity, /TRUSTED_HOST\s*=\s*"app\.nusapos\.my\.id"/);
  assert.match(activity, /setAllowFileAccess\(false\)/);
  assert.match(activity, /setAllowContentAccess\(false\)/);
  assert.match(activity, /MIXED_CONTENT_NEVER_ALLOW/);
});

test('izin lokasi Android hanya diminta saat origin produksi meminta geolokasi', () => {
  assert.match(manifest, /android\.permission\.ACCESS_COARSE_LOCATION/);
  assert.match(manifest, /android\.permission\.ACCESS_FINE_LOCATION/);
  assert.match(activity, /onGeolocationPermissionsShowPrompt/);
  assert.match(activity, /setGeolocationEnabled\(true\)/);
  assert.match(activity, /isTrustedGeolocationOrigin\(origin\)/);
  assert.match(activity, /TRUSTED_HOST\.equalsIgnoreCase\(uri\.getHost\(\)\)/);
  assert.match(activity, /port == -1 \|\| port == 443/);
  assert.match(activity, /"\/"\.equals\(uri\.getPath\(\)\)/);
  assert.match(activity, /uri\.getQuery\(\) == null/);
  assert.match(activity, /uri\.getFragment\(\) == null/);
  assert.match(activity, /callback\.invoke\(origin, false, false\)/);
  assert.match(activity, /Manifest\.permission\.ACCESS_FINE_LOCATION,[\s\S]*Manifest\.permission\.ACCESS_COARSE_LOCATION[\s\S]*REQUEST_LOCATION/);
  assert.match(activity, /requestCode == REQUEST_LOCATION[\s\S]*finishLocationPermission\(hasLocationPermission\(\)\)/);
  assert.doesNotMatch(activity, /onCreate\([\s\S]{0,1600}requestPermissions\(new String\[\]\{[\s\S]*ACCESS_(?:FINE|COARSE)_LOCATION/);
  assert.match(webApp, /Pengaturan Android > Aplikasi > Kasir Nusa POS > Izin/);
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

test('scanner HID tidak memicu navigasi saat tersambung ulang dan mengikuti halaman kerja aktif', () => {
  const dispatch = activity.match(/public boolean dispatchKeyEvent\(KeyEvent event\)[\s\S]*?private void dispatchBarcode/)?.[0] ?? '';
  assert.match(dispatch, /if \(event\.getAction\(\) != KeyEvent\.ACTION_DOWN\) return true/);
  assert.equal((dispatch.match(/super\.dispatchKeyEvent\(event\)/g) ?? []).length, 1);
  assert.match(dispatch, /barcode\.length\(\) >= 3[\s\S]*dispatchBarcode\(barcode\)[\s\S]*return true/);
  assert.match(webApp, /state\.restockWizardStep==='items'\)target='restock'/);
  assert.match(webApp, /purchase-view-order[\s\S]*target='po'/);
  assert.match(webApp, /handleBarcodeForTarget\(barcode,target\)/);
  assert.doesNotMatch(webApp.match(/async function handleNativeScannerBarcode[\s\S]*?\n\}/)?.[0] ?? '', /showPage\(/);
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
  assert.match(androidBuild, /versionCode 12/);
  assert.match(androidBuild, /versionName "1\.4\.3"/);
  assert.doesNotMatch(androidBuild, /release\s*\{[\s\S]*signingConfig signingConfigs\.debug/);
  assert.match(androidBuild, /KASIR_NUSA_KEYSTORE_FILE/);
  assert.match(androidBuild, /KASIR_NUSA_KEYSTORE_PASSWORD/);
  assert.match(androidBuild, /releaseRequested && !releaseSigningConfigured/);
  assert.match(androidBuild, /signingConfig signingConfigs\.release/);
  assert.match(activity, /KasirNusaAndroid\/" \+ BuildConfig\.VERSION_NAME/);
  assert.doesNotMatch(activity, /SCANNER_MODE|scannerSocket|scannerReader/);
});

test('label Android dikirim langsung sebagai raster ESC POS tanpa halaman A4', () => {
  assert.doesNotMatch(activity, /PrintManager|createPrintDocumentAdapter|printCurrentPage/);
  assert.match(webPrinter, /productLabelRasterLayout/);
  assert.match(webPrinter, /GS,0x76,0x30/);
  assert.match(webPrinter, /moduleDots<2/);
  assert.match(webApp, /printEscPosProductLabels/);
  assert.match(webApp, /KasirNusaAndroid\?\.printBase64/);
  assert.match(webApp, /window\.print\(\)/);
});

test('APK UAT v1.3.0 tersedia sebagai unduhan yang identik dengan hasil build', async () => {
  const [releaseApk, publicApk] = await Promise.all([readFile(releaseApkUrl), readFile(publicApkUrl)]);
  assert.deepEqual(publicApk, releaseApk);
  assert.match(vercelConfig, /\/downloads\/Kasir-Nusa-POS-1\.3\.0-uat\.apk/);
  assert.match(vercelConfig, /attachment; filename=Kasir-Nusa-POS-1\.3\.0-uat\.apk/);
});

test('APK final v1.4.3 menjaga halaman aktif saat scanner tersambung ulang', async () => {
  const [finalReleaseApk, publicFinalApk, releaseApk] = await Promise.all([
    readFile(finalReleaseApkUrl),
    readFile(publicFinalApkUrl),
    readFile(releaseApkUrl),
  ]);
  assert.deepEqual(publicFinalApk, finalReleaseApk);
  assert.notDeepEqual(finalReleaseApk, releaseApk);
  assert.match(vercelConfig, /\/downloads\/Kasir-Nusa-POS-1\.4\.3\.apk/);
  assert.match(vercelConfig, /attachment; filename=Kasir-Nusa-POS-1\.4\.3\.apk/);
});

test('APK dan PWA memakai nama serta identitas visual Kasir Nusa POS yang konsisten', () => {
  assert.match(androidStrings, /<string name="app_name">Kasir Nusa POS<\/string>/);
  assert.match(manifest, /android:icon="@drawable\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@drawable\/ic_launcher"/);
  for (const icon of [androidIcon, pwaIcon]) {
    assert.match(icon, /#12383c/i);
    assert.match(icon, /#fffaf2/i);
    assert.match(icon, /#df7a45/i);
  }
  assert.match(webHtml, /Kasir Nusa POS/);
  assert.match(webHtml, /brand-receipt/);
  assert.doesNotMatch(webHtml, />\s*KN\s*</);
  assert.doesNotMatch(`${androidStrings}\n${webHtml}`, /Kasir Nusa Kasir/);
});

test('Android startup never touches unavailable Web Serial and has a login watchdog', () => {
  assert.match(webApp, /typeof navigator !== 'undefined' && navigator\.serial/);
  assert.doesNotMatch(webApp, /if \(supportsBluetoothClassicPrinting\(\)\) \{\s*navigator\.serial/);
  assert.match(webHtml, /Pemulihan sesi terlalu lama[\s\S]*12000/);
});
