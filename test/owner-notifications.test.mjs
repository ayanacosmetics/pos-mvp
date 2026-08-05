import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [api,app,html,css,worker,sql,staffSql]=await Promise.all([
  readFile(new URL('../api/index.mjs',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/styles.css',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/service-worker.js',import.meta.url),'utf8'),
  readFile(new URL('../supabase/migrations/202608050026_owner_notifications_web_push.sql',import.meta.url),'utf8'),
  readFile(new URL('../supabase/migrations/202608050027_staff_restock_decision_notifications.sql',import.meta.url),'utf8')
]);

test('notifikasi tersimpan khusus penerima dan subscription terisolasi per tenant',()=>{
  assert.match(sql,/create table if not exists public\.app_notifications/);
  assert.match(sql,/recipient_user_id uuid not null references public\.profiles\(user_id\)/);
  assert.match(sql,/create table if not exists public\.web_push_subscriptions/);
  assert.match(sql,/create_owner_notifications_v1/);
  assert.match(sql,/where p\.tenant_id=p_tenant_id[\s\S]*p\.role='OWNER'[\s\S]*p\.active=true/);
  assert.match(api,/route==='notifications'/);
  assert.match(api,/recipient_user_id=eq\.\$\{session\.authUser\.id\}/);
});

test('keputusan restok dikirim privat hanya kepada staff pengaju',()=>{
  assert.match(staffSql,/create_user_notification_v1/);
  assert.match(staffSql,/p\.tenant_id=p_tenant_id and p\.user_id=p_recipient_user_id and p\.active=true/);
  assert.match(api,/queueTenantUserNotification\(context\.tenantId,approval\.requester_id/);
  assert.match(api,/type:'RESTOCK_APPROVAL_DECISION'/);
  assert.match(api,/actionPage:'restock-approvals'/);
  assert.match(api,/approve:\{severity:'SUCCESS'/);
  assert.match(api,/revise:\{severity:'WARNING'/);
  assert.match(api,/reject:\{severity:'CRITICAL'/);
});

test('transaksi absensi dan persetujuan restok memberi notifikasi owner tanpa menggagalkan operasi utama',()=>{
  assert.match(api,/type:'SALE_COMPLETED'/);
  assert.match(api,/type:clockIn\?'ATTENDANCE_CLOCK_IN':'ATTENDANCE_CLOCK_OUT'/);
  assert.match(api,/type:'RESTOCK_APPROVAL'/);
  assert.match(api,/Notification delivery is deliberately isolated from sales and attendance/);
  assert.match(api,/request\.waitUntil/);
});

test('PWA memiliki pusat notifikasi dan Web Push yang hanya diaktifkan lewat tindakan owner',()=>{
  assert.match(html,/id="open-notifications"/);
  assert.match(html,/id="notification-center-dialog"/);
  assert.match(html,/id="toggle-push-notifications"/);
  assert.match(app,/Notification\.requestPermission\(\)/);
  assert.match(app,/registration\.pushManager\.subscribe/);
  assert.match(app,/function isInstalledPwa/);
  assert.match(css,/\.notification-center-dialog/);
  assert.match(worker,/addEventListener\('push'/);
  assert.match(worker,/addEventListener\('notificationclick'/);
  assert.equal((app.match(/function isInstalledPwa\s*\(/g)??[]).length,1,'helper PWA tidak boleh dideklarasikan ganda karena membuat seluruh modul gagal dimuat');
});

test('service worker membuka halaman tujuan notifikasi dan tidak mencegat API',()=>{
  assert.match(worker,/event\.request\.url\.includes\('\/api\/'\)/);
  assert.match(worker,/OPEN_NOTIFICATION/);
  assert.match(app,/event\.data\?\.type==='OPEN_NOTIFICATION'/);
});
