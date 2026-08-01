import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('riwayat struk dapat diberikan tanpa laporan pendapatan dan keuntungan',async()=>{
  const [api,app,html,migration]=await Promise.all([
    read('api/index.mjs'),read('apps/web/app.js'),read('apps/web/index.html'),
    read('supabase/migrations/202608010002_granular_report_access.sql')
  ]);
  assert.match(app,/\['report\.transactions','Riwayat transaksi & cetak struk'/);
  assert.match(html,/data-report-view="receipts"[^>]+data-permission="report\.transactions"/);
  assert.match(api,/requireAnyPermission\(session,\['report\.transactions','report\.view'\]\)/);
  assert.match(api,/const \{grossProfit,netCost,returnCost,\.\.\.safe\}=sale/);
  assert.match(app,/metrics\.slice\(1\)\.forEach\(\(metric\)=>metric\.remove\(\)\)/);
  assert.match(api,/route === 'reports\/summary'[\s\S]{0,120}requirePermission\(session, 'report\.view'\)/);
  assert.match(migration,/'report\.transactions'/);
});
