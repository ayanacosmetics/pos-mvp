import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('snapshot infrastruktur global hanya dapat dipanggil service role', async () => {
  const sql=await readFile(new URL('../supabase/migrations/202608020011_platform_infrastructure_snapshot.sql',import.meta.url),'utf8');
  assert.match(sql,/pg_database_size\(current_database\(\)\)/);
  assert.match(sql,/pg_stat_user_tables/);
  assert.match(sql,/revoke all[\s\S]*public,anon,authenticated/);
  assert.match(sql,/grant execute[\s\S]*service_role/);
});

test('API global memakai allowlist user terautentikasi dan tidak mengirim token', async () => {
  const api=await readFile(new URL('../api/index.mjs',import.meta.url),'utf8');
  assert.match(api,/PLATFORM_ADMIN_USER_IDS/);
  assert.match(api,/authenticatedUser\?\.id/);
  assert.match(api,/route === 'platform\/infrastructure'/);
  assert.match(api,/requirePlatformAdmin\(session\)/);
  assert.match(api,/CLOUDFLARE_ANALYTICS_TOKEN/);
  assert.match(api,/cloudflare:cloudflareResult\.status==='fulfilled'/);
});

test('dashboard global tersembunyi dari Owner toko dan dimuat hanya saat dibuka', async () => {
  const [html,script,style]=await Promise.all([
    readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/styles.css',import.meta.url),'utf8')
  ]);
  assert.match(html,/data-page="platform-infrastructure" data-platform-admin class="feature-nav-item hidden"/);
  assert.match(html,/id="page-platform-infrastructure"/);
  assert.match(script,/state\.session\.platformAdmin!==true/);
  assert.match(script,/name==='platform-infrastructure'[^\n]*loadPlatformInfrastructure/);
  assert.match(script,/cpuP50Over/);
  assert.match(script,/cpuP99Over/);
  assert.match(script,/1% request terberat/);
  assert.match(style,/\.infrastructure-grid/);
});
