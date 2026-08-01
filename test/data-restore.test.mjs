import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import handler from '../api/index.mjs';

const read=(path)=>readFile(new URL(path,import.meta.url),'utf8');
const reply=(body,status=200)=>new Response(JSON.stringify(body),{
  status,headers:{'content-type':'application/json'}
});
const ids={
  user:'11111111-1111-4111-8111-111111111111',
  tenant:'22222222-2222-4222-8222-222222222222',
  outlet:'33333333-3333-4333-8333-333333333333',
  location:'44444444-4444-4444-8444-444444444444'
};

function backupSnapshot() {
  const payload={
    format:'KASIR_NUSA_BACKUP',
    schemaVersion:1,
    createdAt:'2026-07-29T12:00:00.000Z',
    tenantId:ids.tenant,
    createdBy:{userId:ids.user,displayName:'Owner'},
    tables:{
      products:[{id:'55555555-5555-4555-8555-555555555555',tenant_id:ids.tenant}],
      sales:[{id:'66666666-6666-4666-8666-666666666666',tenant_id:ids.tenant}],
      stock_balances:[{tenant_id:ids.tenant,location_id:ids.location,product_id:'55555555-5555-4555-8555-555555555555'}]
    }
  };
  return {...payload,checksum:createHash('sha256').update(JSON.stringify(payload)).digest('hex')};
}

async function call(route,body={}) {
  let payload='';
  const request={method:'POST',url:`/api/index?route=${route}`,query:{route},headers:{authorization:'Bearer owner-token'},body};
  const response={statusCode:0,setHeader(){},end(value){payload=value;}};
  await handler(request,response);
  return {status:response.statusCode,body:JSON.parse(payload)};
}

function installOwnerMock(snapshot,{simulate=true}={}) {
  const originalFetch=globalThis.fetch;
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://restore.supabase.test';
  process.env.SUPABASE_ANON_KEY='anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  const calls=[];
  globalThis.fetch=async(url,options={})=>{
    const target=String(url),body=options.body?JSON.parse(options.body):null;
    calls.push({target,body});
    if(target.endsWith('/auth/v1/user'))return reply({id:ids.user,email:'owner@example.com'});
    if(target.includes('/rest/v1/profiles?'))return reply([{user_id:ids.user,tenant_id:ids.tenant,display_name:'Owner',role:'OWNER',active:true}]);
    if(target.includes('/rest/v1/user_outlets?'))return reply([{outlet_id:ids.outlet}]);
    if(target.includes('/rest/v1/outlets?'))return reply([{id:ids.outlet,name:'Toko Utama',active:true}]);
    if(target.includes('/rest/v1/stock_locations?'))return reply([{id:ids.location,outlet_id:ids.outlet,name:'Toko',kind:'STORE',active:true}]);
    if(target.includes('/rest/v1/backup_exports?'))return reply([{id:'77777777-7777-4777-8777-777777777777',checksum_sha256:snapshot.checksum}]);
    if(target.endsWith('/rest/v1/rpc/dry_run_restore_tenant_backup_v2'))return reply({valid:simulate,restoredRows:3,error:simulate?undefined:'relasi rusak'});
    if(target.endsWith('/auth/v1/otp'))return reply({});
    if(target.endsWith('/rest/v1/audit_logs'))return reply([]);
    return reply({message:`Mock belum menangani ${target}`},500);
  };
  return {
    calls,
    restore(){
      globalThis.fetch=originalFetch;
      if(previous.url===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=previous.url;
      if(previous.anon===undefined)delete process.env.SUPABASE_ANON_KEY;else process.env.SUPABASE_ANON_KEY=previous.anon;
      if(previous.service===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=previous.service;
    }
  };
}

test('halaman Reset & pulihkan data memakai dua tampilan dalam satu menu',async()=>{
  const [html,app,api,sql]=await Promise.all([
    read('../apps/web/index.html'),read('../apps/web/app.js'),read('../api/index.mjs'),
    read('../supabase/migrations/202607290050_atomic_backup_restore.sql')
  ]);
  assert.match(html,/Reset & pulihkan data/);
  for(const id of ['data-reset-panel','data-restore-panel','data-restore-file','data-restore-preview','request-data-restore-otp','data-restore-form','data-restore-otp','data-restore-phrase'])assert.ok(html.includes(`id="${id}"`));
  for(const fn of ['showDataMaintenanceMode','inspectDataRestoreFile','requestDataRestoreOtp','executeDataRestore'])assert.ok(app.includes(`function ${fn}`));
  for(const route of ['data-restore/preview','data-restore/otp','data-restore/execute'])assert.ok(api.includes(`route==='${route}'`));
  assert.match(api,/requireRegisteredBackup/);
  assert.match(sql,/security definer/i);
  assert.match(sql,/role='OWNER'/);
  assert.match(sql,/perform public\.reset_tenant_data_v1/);
  assert.match(sql,/jsonb_populate_recordset/);
  assert.doesNotMatch(sql,/on conflict do nothing/i);
  assert.match(sql,/disable trigger user/i);
  assert.match(sql,/enable trigger user/i);
  assert.match(sql,/dry_run_restore_tenant_backup_v1/);
  assert.match(sql,/__RESTORE_DRY_RUN_OK__/);
  assert.match(sql,/TENANT_BACKUP_RESTORED/);
});

test('pratinjau hanya menerima backup resmi untuk tenant Owner yang sama',async()=>{
  const snapshot=backupSnapshot(),mock=installOwnerMock(snapshot);
  try{
    const result=await call('data-restore/preview',{snapshot});
    assert.equal(result.status,200);
    assert.equal(result.body.valid,true);
    assert.equal(result.body.preview.totalRows,3);
    assert.equal(result.body.preview.groups.catalog,1);
    assert.equal(result.body.preview.groups.transactions,1);
    assert.equal(result.body.preview.groups.inventory,1);
    assert.ok(mock.calls.some((entry)=>entry.target.includes('/rest/v1/backup_exports?')));
  }finally{mock.restore();}
});

test('OTP pemulihan baru dikirim setelah simulasi atomik berhasil',async()=>{
  const snapshot=backupSnapshot(),mock=installOwnerMock(snapshot);
  try{
    const result=await call('data-restore/otp',{snapshot});
    assert.equal(result.status,200);
    assert.equal(result.body.emailMasked,'ow***@example.com');
    const simulation=mock.calls.find((entry)=>entry.target.endsWith('/rest/v1/rpc/dry_run_restore_tenant_backup_v2'));
    assert.equal(simulation.body.p_tenant_id,ids.tenant);
    assert.ok(mock.calls.some((entry)=>entry.target.endsWith('/auth/v1/otp')));
  }finally{mock.restore();}
});

test('OTP tidak dikirim bila simulasi pemulihan gagal',async()=>{
  const snapshot=backupSnapshot(),mock=installOwnerMock(snapshot,{simulate:false});
  try{
    const result=await call('data-restore/otp',{snapshot});
    assert.equal(result.status,409);
    assert.match(result.body.error,/relasi rusak/);
    assert.equal(mock.calls.some((entry)=>entry.target.endsWith('/auth/v1/otp')),false);
  }finally{mock.restore();}
});
