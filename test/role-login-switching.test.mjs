import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from '../api/index.mjs';

const userId='11111111-1111-4111-8111-111111111111';
const tenantId='22222222-2222-4222-8222-222222222222';
const responseOf=(body,status=200)=>new Response(JSON.stringify(body),{
  status,headers:{'content-type':'application/json'}
});

async function callLogin(portal){
  let payload='';const headers={};
  const response={statusCode:0,setHeader(name,value){headers[name]=value;},end(value){payload=value;}};
  await handler({
    method:'POST',url:'/api/index?route=login',query:{route:'login'},headers:{},
    body:{email:'user@example.com',password:'secret',portal}
  },response);
  return{status:response.statusCode,body:JSON.parse(payload),headers};
}

function installAuthMock(role,calls){
  return async(url)=>{
    const target=String(url);calls.push(target);
    if(target.includes('/auth/v1/token?grant_type=password'))return responseOf({
      access_token:'access',refresh_token:'refresh',expires_in:3600,expires_at:9999999999,
      user:{id:userId}
    });
    if(target.includes('/rest/v1/profiles?'))return responseOf([{
      user_id:userId,tenant_id:tenantId,display_name:'Pengguna',role,active:true
    }]);
    if(target.includes('/auth/v1/logout?scope=local'))return responseOf({});
    return responseOf({message:`Mock belum menangani ${target}`},500);
  };
}

async function withLoginEnvironment(role,operation){
  const originalFetch=globalThis.fetch;
  const previous={
    url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,
    service:process.env.SUPABASE_SERVICE_ROLE_KEY,bootstrap:process.env.ALLOW_OWNER_BOOTSTRAP
  };
  process.env.SUPABASE_URL='https://project.supabase.test';
  process.env.SUPABASE_ANON_KEY='anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  process.env.ALLOW_OWNER_BOOTSTRAP='false';
  const calls=[];globalThis.fetch=installAuthMock(role,calls);
  try{return await operation(calls);}
  finally{
    globalThis.fetch=originalFetch;
    const names={url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY',bootstrap:'ALLOW_OWNER_BOOTSTRAP'};
    for(const [key,value] of Object.entries(previous)){
      if(value===undefined)delete process.env[names[key]];else process.env[names[key]]=value;
    }
  }
}

test('jalur Owner hanya menerima akun Owner',async()=>{
  await withLoginEnvironment('OWNER',async()=>{
    const accepted=await callLogin('OWNER');
    assert.equal(accepted.status,200);
    assert.equal(accepted.body.user.role,'OWNER');
    assert.match(accepted.headers['set-cookie'],/__Host-kasir_nusa_refresh=/);
  });
  await withLoginEnvironment('CASHIER',async(calls)=>{
    const rejected=await callLogin('OWNER');
    assert.equal(rejected.status,403);
    assert.match(rejected.body.error,/bukan akun Owner/);
    assert.ok(calls.some((url)=>url.includes('/auth/v1/logout?scope=local')));
  });
});

test('jalur Staff menerima Staff dan menolak Owner',async()=>{
  await withLoginEnvironment('CASHIER',async()=>{
    const accepted=await callLogin('STAFF');
    assert.equal(accepted.status,200);
    assert.equal(accepted.body.user.role,'CASHIER');
  });
  await withLoginEnvironment('OWNER',async(calls)=>{
    const rejected=await callLogin('STAFF');
    assert.equal(rejected.status,403);
    assert.match(rejected.body.error,/login Owner/);
    assert.ok(calls.some((url)=>url.includes('/auth/v1/logout?scope=local')));
  });
});

test('UI membedakan login dan hanya menampilkan Ganti Owner saat server mengizinkan',async()=>{
  const [html,script]=await Promise.all([
    readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8')
  ]);
  assert.match(html,/data-login-portal="OWNER"/);
  assert.match(html,/data-login-portal="STAFF"/);
  assert.match(html,/id="switch-account"/);
  assert.match(html,/styles\.css\?v=183/);
  assert.match(html,/app\.js\?v=183/);
  assert.doesNotMatch(html,/owner@demo\.local|owner123|kasir123/);
  assert.match(script,/!state\.session\.canSwitchOwners/);
  assert.match(script,/\/api\/owner-contexts\/switch/);
  assert.match(script,/pos_owner_context_id/);
  assert.match(script,/body: JSON\.stringify\(\{ email, password, portal \}\)/);
});
