import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [api,app,activity,service,manifest,build,rootBuild,sql]=await Promise.all([
  readFile(new URL('../api/index.mjs',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
  readFile(new URL('../apps/android-cashier/app/src/main/java/app/kasirnusa/cashier/MainActivity.java',import.meta.url),'utf8'),
  readFile(new URL('../apps/android-cashier/app/src/main/java/app/kasirnusa/cashier/NusaFirebaseMessagingService.java',import.meta.url),'utf8'),
  readFile(new URL('../apps/android-cashier/app/src/main/AndroidManifest.xml',import.meta.url),'utf8'),
  readFile(new URL('../apps/android-cashier/app/build.gradle',import.meta.url),'utf8'),
  readFile(new URL('../apps/android-cashier/build.gradle',import.meta.url),'utf8'),
  readFile(new URL('../supabase/migrations/202608050028_android_fcm_devices.sql',import.meta.url),'utf8')
]);

test('token FCM terikat unik pada instalasi, tenant, dan user',()=>{
  assert.match(sql,/create table if not exists public\.native_push_devices/);
  assert.match(sql,/installation_id uuid not null unique/);
  assert.match(sql,/push_token text not null unique/);
  assert.match(sql,/enable row level security/);
  assert.match(api,/route==='notifications\/native-devices'/);
  assert.match(api,/tenant_id:context\.tenantId,user_id:session\.authUser\.id/);
  assert.match(api,/user_id=eq\.\$\{session\.authUser\.id\}.*installation_id=eq/);
  assert.match(app,/deactivateNativePushDevice\(\)/);
  assert.match(app,/if\(nativePushStatus\(\)\)await deactivateNativePushDevice/);
});

test('server memakai FCM HTTP v1 dan pengiriman tetap best effort',()=>{
  assert.match(api,/https:\/\/www\.googleapis\.com\/auth\/firebase\.messaging/);
  assert.match(api,/fcm\.googleapis\.com\/v1\/projects/);
  assert.match(api,/Promise\.allSettled\(tasks\)/);
  assert.match(api,/deliverDevicePushes\(tenantId,userIds,notification\)/);
  assert.match(api,/deliverDevicePushes\(tenantId,recipientIds,notification\)/);
});

test('APK meminta izin lewat tindakan pengguna dan menerima FCM saat ditutup',()=>{
  assert.match(rootBuild,/com\.google\.gms\.google-services.*4\.5\.0/);
  assert.match(build,/firebase-bom:34\.16\.0/);
  assert.match(build,/firebase-messaging/);
  assert.match(manifest,/android\.permission\.POST_NOTIFICATIONS/);
  assert.match(manifest,/NusaFirebaseMessagingService/);
  assert.match(manifest,/com\.google\.firebase\.MESSAGING_EVENT/);
  assert.match(activity,/requestNativePushPermission/);
  assert.match(activity,/requestPermissions\(new String\[\]\{Manifest\.permission\.POST_NOTIFICATIONS\}/);
  assert.match(service,/extends FirebaseMessagingService/);
  assert.match(service,/onNewToken/);
  assert.match(service,/nusa_important/);
});

test('WebView mendaftarkan token memakai sesi login dan membuka tujuan notifikasi',()=>{
  assert.match(activity,/kasirnusa:native-push-token/);
  assert.match(activity,/kasirnusa:native-notification/);
  assert.match(app,/registerNativePushDevice/);
  assert.match(app,/kasirnusa:native-push-token/);
  assert.match(app,/kasirnusa:native-notification/);
  assert.match(app,/Kabar penting dapat muncul walaupun APK diminimalkan atau ditutup/);
});
