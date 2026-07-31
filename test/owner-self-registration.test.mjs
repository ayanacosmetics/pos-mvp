import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from '../api/index.mjs';

const ids = {
  user: '11111111-1111-4111-8111-111111111111',
  tenant: '22222222-2222-4222-8222-222222222222'
};
const responseOf = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
});

async function callRegistration(body) {
  let payload = '';
  const headers = {};
  const response = {
    statusCode: 0,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    end(value) { payload = value; }
  };
  await handler({
    method: 'POST',
    url: '/api/index?route=register-owner',
    query: { route: 'register-owner' },
    headers: {},
    body
  }, response);
  return { status: response.statusCode, body: JSON.parse(payload), headers };
}

async function callPublicAuthRoute(route,body) {
  let payload='';
  const response={
    statusCode:0,
    setHeader(){},
    end(value){payload=value;}
  };
  await handler({method:'POST',url:`/api/index?route=${route}`,query:{route},headers:{},body},response);
  return {status:response.statusCode,body:JSON.parse(payload)};
}

async function withRegistrationEnvironment(fetchMock, operation) {
  const originalFetch = globalThis.fetch;
  const previous = {
    url: process.env.SUPABASE_URL,
    anon: process.env.SUPABASE_ANON_KEY,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  process.env.SUPABASE_URL = 'https://project.supabase.test';
  process.env.SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  globalThis.fetch = fetchMock;
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      const name = { url: 'SUPABASE_URL', anon: 'SUPABASE_ANON_KEY', service: 'SUPABASE_SERVICE_ROLE_KEY' }[key];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('pendaftaran Owner membuat Auth, workspace, lalu sesi aktif', async () => {
  const calls = [];
  let workspaceCreated=false;
  let passwordAttempts=0;
  await withRegistrationEnvironment(async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.includes('/auth/v1/token?grant_type=password')) {
      passwordAttempts+=1;
      if(passwordAttempts===1)return responseOf({ message:'Invalid login credentials' },400);
      return responseOf({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
      expires_at: 9999999999,
      user: { id: ids.user, identities: [{ id: 'identity' }] }
      });
    }
    if (target.includes('/auth/v1/admin/users?page=')) return responseOf({users:[]});
    if (target.endsWith('/auth/v1/admin/users')) return responseOf({id:ids.user,email:'ayu@example.com'});
    if (target.endsWith('/rest/v1/rpc/register_owner_workspace_v1')) {
      workspaceCreated=true;
      return responseOf({ tenantId: ids.tenant });
    }
    if (target.includes('/rest/v1/profiles?')) return responseOf(workspaceCreated?[{
      user_id: ids.user,
      tenant_id: ids.tenant,
      display_name: 'Ayu Pemilik',
      role: 'OWNER',
      active: true
    }]:[]);
    return responseOf({ message: `Mock belum menangani ${target}` }, 500);
  }, async () => {
    const result = await callRegistration({
      ownerName: 'Ayu Pemilik',
      businessName: 'Toko Ayu',
      email: 'AYU@example.com',
      password: 'rahasia-kuat'
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.user.role, 'OWNER');
    assert.equal(result.body.registered, true);
    assert.match(result.headers['set-cookie'], /__Host-kasir_nusa_refresh=/);
  });
  const signup = calls.find((call) => call.target.endsWith('/auth/v1/admin/users'));
  assert.deepEqual(JSON.parse(signup.options.body), {
    email: 'ayu@example.com',
    password: 'rahasia-kuat',
    email_confirm: true,
    user_metadata: { display_name: 'Ayu Pemilik', business_name: 'Toko Ayu', registration_source:'NUSA_OWNER_SELF_REGISTRATION' }
  });
  const workspace = calls.find((call) => call.target.endsWith('/rest/v1/rpc/register_owner_workspace_v1'));
  assert.equal(workspace.options.headers.authorization, 'Bearer service');
});

test('pendaftaran memulihkan identitas lama yang belum terkonfirmasi', async () => {
  let passwordAttempts=0,workspaceCreated=false,confirmed=false;
  await withRegistrationEnvironment(async (url) => {
    const target = String(url);
    if (target.includes('/auth/v1/token?grant_type=password')) {
      passwordAttempts+=1;
      if(passwordAttempts===1)return responseOf({ message:'Email not confirmed' },400);
      return responseOf({access_token:'access',refresh_token:'refresh',expires_in:3600,user:{id:ids.user}});
    }
    if(target.includes('/auth/v1/admin/users?page='))return responseOf({users:[{id:ids.user,email:'ayu@example.com',email_confirmed_at:null}]});
    if(target.endsWith(`/auth/v1/admin/users/${ids.user}`)){confirmed=true;return responseOf({id:ids.user,email_confirmed_at:new Date().toISOString()});}
    if (target.endsWith('/rest/v1/rpc/register_owner_workspace_v1')) {workspaceCreated=true;return responseOf({});}
    if (target.includes('/rest/v1/profiles?')) return responseOf(workspaceCreated?[{
      user_id: ids.user,
      tenant_id: ids.tenant,
      display_name: 'Ayu',
      role: 'OWNER',
      active: true
    }]:[]);
    return responseOf({}, 500);
  }, async () => {
    const result = await callRegistration({
      ownerName: 'Ayu',
      businessName: 'Toko Ayu',
      email: 'ayu@example.com',
      password: 'rahasia-kuat'
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.recovered, true);
    assert.equal(result.body.user.role, 'OWNER');
  });
  assert.equal(confirmed,true);
});

test('pendaftaran menyelesaikan akun Auth lama yang belum mempunyai workspace',async()=>{
  let workspaceCreated=false;
  const calls=[];
  await withRegistrationEnvironment(async(url,options={})=>{
    const target=String(url);calls.push(target);
    if(target.includes('/auth/v1/token?grant_type=password'))return responseOf({
      access_token:'recovered-access',refresh_token:'recovered-refresh',expires_in:3600,expires_at:9999999999,
      user:{id:ids.user,email:'ayu@example.com',user_metadata:{display_name:'Ayu',business_name:'Toko Ayu'}}
    });
    if(target.includes('/rest/v1/profiles?'))return responseOf(workspaceCreated?[{
      user_id:ids.user,tenant_id:ids.tenant,display_name:'Ayu',role:'OWNER',active:true
    }]:[]);
    if(target.endsWith('/rest/v1/rpc/register_owner_workspace_v1')){workspaceCreated=true;return responseOf({tenantId:ids.tenant});}
    return responseOf({message:`Mock belum menangani ${target}`},500);
  },async()=>{
    const result=await callRegistration({ownerName:'Ayu',businessName:'Toko Ayu',email:'ayu@example.com',password:'rahasia-kuat'});
    assert.equal(result.status,201);
    assert.equal(result.body.recovered,true);
    assert.equal(result.body.user.role,'OWNER');
  });
  assert.equal(calls.some((target)=>target.endsWith('/auth/v1/signup')),false);
  assert.equal(workspaceCreated,true);
});

test('lupa kata sandi mengirim recovery dan penggantian memvalidasi token',async()=>{
  const calls=[];
  await withRegistrationEnvironment(async(url,options={})=>{
    const target=String(url);calls.push({target,options});
    if(target.includes('/auth/v1/recover?redirect_to='))return responseOf({});
    if(target.endsWith('/auth/v1/user')&&(!options.method||options.method==='GET'))return responseOf({id:ids.user});
    if(target.endsWith('/auth/v1/user')&&options.method==='PUT')return responseOf({id:ids.user});
    return responseOf({message:`Mock belum menangani ${target}`},500);
  },async()=>{
    const recovery=await callPublicAuthRoute('forgot-password',{email:'AYU@example.com'});
    assert.equal(recovery.status,200);
    assert.match(recovery.body.message,/tautan pemulihan/i);
    const reset=await callPublicAuthRoute('reset-password',{accessToken:'recovery-token',password:'kata-sandi-baru'});
    assert.equal(reset.status,200);
    assert.equal(reset.body.updated,true);
  });
  const recoveryCall=calls.find(({target})=>target.includes('/auth/v1/recover?redirect_to='));
  assert.match(recoveryCall.target,/kasir-nusa-pos\.vercel\.app/);
  const updateCall=calls.find(({target,options})=>target.endsWith('/auth/v1/user')&&options.method==='PUT');
  assert.equal(updateCall.options.headers.authorization,'Bearer recovery-token');
  assert.deepEqual(JSON.parse(updateCall.options.body),{password:'kata-sandi-baru'});
});

test('UI dan SQL membatasi daftar mandiri hanya untuk Owner', async () => {
  const [html, script, sql] = await Promise.all([
    readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/202607270035_owner_self_registration.sql', import.meta.url), 'utf8')
  ]);
  for (const id of [
    'open-owner-registration',
    'register-owner-form',
    'register-owner-name',
    'register-business-name',
    'register-owner-email',
    'register-owner-password',
    'register-owner-password-confirmation',
    'open-forgot-password',
    'forgot-password-form',
    'reset-password-form'
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /Akun Staff ditambahkan kemudian oleh Owner/);
  assert.match(script, /\/api\/register-owner/);
  assert.match(script, /\/api\/forgot-password/);
  assert.match(script, /\/api\/reset-password/);
  assert.match(script, /ruang usaha akan diselesaikan otomatis/);
  assert.match(await readFile(new URL('../api/index.mjs',import.meta.url),'utf8'),/function provisionOwnerWorkspace/);
  assert.match(script, /open-owner-registration'\)\.classList\.toggle\('hidden', !owner\)/);
  assert.match(sql, /function public\.register_owner_workspace_v1/);
  assert.match(sql, /insert into public\.profiles[\s\S]*'OWNER'/);
  assert.match(sql, /insert into public\.outlets/);
  assert.match(sql, /insert into public\.chart_of_accounts/);
  assert.match(sql, /revoke all on function public\.register_owner_workspace_v1[\s\S]*from public,anon,authenticated/);
  assert.match(sql, /grant execute on function public\.register_owner_workspace_v1[\s\S]*to service_role/);
});
