import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('absensi mewajibkan geofence dan foto wajah privat',async()=>{
  const [api,app,html,sql]=await Promise.all([
    read('api/index.mjs'),read('apps/web/app.js'),read('apps/web/index.html'),
    read('supabase/migrations/202608010003_secure_attendance_and_recurring_shifts.sql')
  ]);
  assert.match(html,/id="setting-attendance-latitude"/);
  assert.match(html,/id="setting-attendance-longitude"/);
  assert.match(html,/id="attendance-camera-video"[^>]+playsinline/);
  assert.match(html,/id="retry-attendance-camera"/);
  assert.match(html,/Gunakan &amp; lanjutkan absensi/);
  assert.match(app,/getUserMedia\(\{video:\{facingMode:'user'/);
  assert.match(app,/new FaceDetector/);
  assert.match(app,/captureAttendanceCamera/);
  assert.match(app,/enableHighAccuracy:true/);
  assert.match(app,/photoDataUrl:state\.attendancePhotoDataUrl/);
  assert.match(api,/distanceMeters\(/);
  assert.match(api,/uploadAttendancePhoto/);
  assert.match(api,/signedAttendancePhotoUrl/);
  assert.match(sql,/'attendance-media','attendance-media',false/);
  assert.match(sql,/v_distance>v_tenant\.attendance_radius_m/);
  assert.match(sql,/clock_in_photo_path/);
  assert.match(sql,/clock_out_photo_path/);
});

test('jadwal sekali dan berulang dapat diedit tanpa menimpa jadwal lain',async()=>{
  const [api,app,html,sql,editSql]=await Promise.all([
    read('api/index.mjs'),read('apps/web/app.js'),read('apps/web/index.html'),
    read('supabase/migrations/202608010003_secure_attendance_and_recurring_shifts.sql'),
    read('supabase/migrations/202608010004_editable_employee_schedules.sql')
  ]);
  assert.match(html,/value="RECURRING">Berlaku terus sampai diubah/);
  assert.match(html,/id="schedule-weekdays"/);
  assert.match(app,/mode==='RECURRING'/);
  assert.match(html,/id="schedule-id"/);
  assert.match(app,/editEmployeeSchedule/);
  assert.match(api,/request\.method==='PUT'&&employeeScheduleMatch/);
  assert.match(api,/save_employee_shift_rule_v2/);
  assert.match(sql,/create table if not exists public\.employee_shift_rules/);
  assert.match(sql,/v_day=any\(weekdays\)/);
  assert.match(editSql,/p_rule_id uuid/);
  assert.match(editSql,/rule\.weekdays && p_weekdays/);
  assert.doesNotMatch(editSql,/set active=false/);
});
