import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from '../api/index.mjs';

const ids={user:'11111111-1111-4111-8111-111111111111',tenant:'22222222-2222-4222-8222-222222222222',outlet:'33333333-3333-4333-8333-333333333333',location:'44444444-4444-4444-8444-444444444444'};
const responseOf=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
async function callApi(method,route,body){
  let payload='';
  const response={statusCode:0,setHeader(){},end(value){payload=value;}};
  await handler({method,url:`/api/index?route=${encodeURIComponent(route)}`,query:{route},headers:{authorization:'Bearer token'},body},response);
  return {status:response.statusCode,body:JSON.parse(payload)};
}

test('owner dapat mengunduh snapshot lengkap dengan checksum tanpa data Auth',async()=>{
  const originalFetch=globalThis.fetch;
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.supabase.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  const writes=[];
  globalThis.fetch=async(url,options={})=>{
    const target=String(url);
    if(target.endsWith('/auth/v1/user'))return responseOf({id:ids.user,email:'owner@example.test'});
    if(target.includes('/rest/v1/profiles?'))return responseOf([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/outlets?'))return responseOf([{id:ids.outlet,tenant_id:ids.tenant,name:'Toko Utama',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return responseOf([{id:ids.location,tenant_id:ids.tenant,outlet_id:ids.outlet,name:'Toko Utama',kind:'STORE'}]);
    if(options.method==='POST'){writes.push({target,body:JSON.parse(options.body)});return responseOf([]);}
    if(target.includes('/rest/v1/'))return responseOf([]);
    return responseOf({message:`Mock belum menangani ${target}`},500);
  };
  try{
    const exported=await callApi('POST','backups/export',{});
    assert.equal(exported.status,200);
    assert.equal(exported.body.snapshot.format,'KASIR_NUSA_BACKUP');
    assert.match(exported.body.snapshot.checksum,/^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(exported.body.snapshot.tables,'auth_users'),false);
    assert.equal(JSON.stringify(exported.body.snapshot).includes('SUPABASE_SERVICE_ROLE_KEY'),false);
    assert.ok(writes.some((write)=>write.target.endsWith('/rest/v1/backup_exports')));
    assert.ok(writes.some((write)=>write.body.action==='BACKUP_EXPORTED'));

    const verified=await callApi('POST','backups/verify',{snapshot:exported.body.snapshot});
    assert.equal(verified.status,200);
    assert.equal(verified.body.valid,true);
    exported.body.snapshot.tables.products.push({id:'changed'});
    const damaged=await callApi('POST','backups/verify',{snapshot:exported.body.snapshot});
    assert.equal(damaged.body.valid,false);
    assert.match(damaged.body.message,/checksum/i);
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(previous)){const envKey={url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY'}[key];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}
  }
});

test('fondasi backup memiliki registry, audit, checksum, dan antarmuka verifikasi',async()=>{
  const migration=await readFile(new URL('../supabase/migrations/202607230012_backup_foundation.sql',import.meta.url),'utf8');
  const api=await readFile(new URL('../api/index.mjs',import.meta.url),'utf8');
  const html=await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8');
  assert.match(migration,/create table if not exists public\.backup_exports/i);
  assert.match(migration,/checksum_sha256/);
  assert.match(api,/BACKUP_EXPORTED/);
  assert.match(api,/createHash\('sha256'\)/);
  assert.match(html,/id="page-backups"/);
  assert.match(html,/PERIKSA FILE BACKUP/);
});
