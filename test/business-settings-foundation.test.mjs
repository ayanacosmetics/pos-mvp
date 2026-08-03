import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('fondasi pengaturan menghubungkan identitas, outlet, lokasi, perangkat, dan nomor struk', async () => {
  const migration=await readFile(new URL('../supabase/migrations/202607230015_business_outlet_device_settings.sql',import.meta.url),'utf8');
  const api=await readFile(new URL('../api/index.mjs',import.meta.url),'utf8');
  const html=await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
  assert.match(migration,/save_business_settings/);
  assert.match(migration,/save_outlet_settings/);
  assert.match(migration,/save_stock_location_settings/);
  assert.match(migration,/save_pos_device_settings/);
  assert.match(migration,/complete_sale_v3/);
  assert.match(migration,/'SALE:'\|\|p_outlet_id::text/);
  assert.match(migration,/v_outlet\.receipt_prefix\|\|'-'/);
  assert.match(api,/route === 'settings'/);
  assert.match(api,/complete_sale_v7/);
  assert.match(html,/id="page-settings"/);
  assert.match(html,/id="current-outlet-select"/);
  assert.match(script,/switchActiveOutlet/);
  assert.match(script,/business\.receiptFooter/);
  assert.match(html,/data-page="settings-device"[^>]+data-permission="device\.configure"/);
  assert.match(api,/requireAnyPermission\(session, \['identity\.manage','device\.configure'\]\)/);
});
