import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [api,app,html,styles]=await Promise.all([
  readFile(new URL('../api/index.mjs',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
  readFile(new URL('../apps/web/styles.css',import.meta.url),'utf8')
]);

test('Owner dapat meminta log yang dibatasi ke satu staff dalam tenant yang sama',()=>{
  assert.match(api,/users\\\/\[\^\/\]\+\\\/activity/);
  assert.match(api,/actor_id=eq\.\$\{encodeURIComponent\(userId\)\}/);
  assert.match(api,/requirePermission\(session, 'identity\.manage'\)/);
  assert.match(api,/limit=100/);
});

test('login dan aktivitas kas penting dicatat dengan actor akun',()=>{
  for(const action of ['ACCOUNT_LOGIN','SHIFT_OPENED','SHIFT_CASH_ADDED','SHIFT_CASH_REMOVED']){
    assert.ok(api.includes(action),`${action} harus dicatat`);
  }
});

test('detail staff menyediakan tab log aktivitas yang mudah dibaca',()=>{
  assert.match(html,/data-staff-detail-view="activity">Log aktivitas/);
  assert.match(html,/id="staff-activity-list"/);
  assert.match(app,/function loadStaffActivity\(\)/);
  assert.match(app,/readableActivityAction/);
  assert.match(styles,/\.staff-activity-row/);
});
