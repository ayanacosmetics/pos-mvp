import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/index.mjs';

const ids={
  original:'11111111-1111-4111-8111-111111111111',
  target:'22222222-2222-4222-8222-222222222222',
  tenant:'33333333-3333-4333-8333-333333333333',
  outlet:'44444444-4444-4444-8444-444444444444',
  location:'55555555-5555-4555-8555-555555555555'
};
const responseOf=(body,status=200)=>new Response(JSON.stringify(body),{
  status,headers:{'content-type':'application/json'}
});

async function callApi(method,route,body={},headers={}){
  let payload='';const response={statusCode:0,setHeader(){},end(value){payload=value;}};
  await handler({
    method,url:`/api/index?route=${encodeURIComponent(route)}`,query:{route},
    headers:{authorization:'Bearer token',...headers},body
  },response);
  return{status:response.statusCode,body:JSON.parse(payload)};
}

function installOwnerContextMock(auditBodies){
  return async(url,options={})=>{
    const target=String(url);
    if(target.endsWith('/auth/v1/user'))return responseOf({id:ids.original});
    if(target.includes('/rest/v1/profiles?user_id=eq.'+ids.original))return responseOf([{
      user_id:ids.original,tenant_id:ids.tenant,display_name:'Owner Utama',role:'OWNER',active:true
    }]);
    if(target.includes('/rest/v1/profiles?user_id=eq.'+ids.target))return responseOf([{
      user_id:ids.target,tenant_id:ids.tenant,display_name:'Owner Kedua',role:'OWNER',active:true
    }]);
    if(target.includes('/rest/v1/profiles?tenant_id=eq.')&&target.includes('role=eq.OWNER'))return responseOf([
      {user_id:ids.target,display_name:'Owner Kedua',created_at:'2026-01-02'},
      {user_id:ids.original,display_name:'Owner Utama',created_at:'2026-01-01'}
    ]);
    if(target.includes('/rest/v1/outlets?'))return responseOf([{
      id:ids.outlet,tenant_id:ids.tenant,name:'Toko Utama',active:true
    }]);
    if(target.includes('/rest/v1/stock_locations?'))return responseOf([{
      id:ids.location,tenant_id:ids.tenant,outlet_id:ids.outlet,name:'Toko',kind:'STORE',active:true
    }]);
    if(target.endsWith('/rest/v1/audit_logs')){
      auditBodies.push(JSON.parse(options.body));return responseOf([]);
    }
    return responseOf({message:`Mock belum menangani ${target}`},500);
  };
}

function setEnvironment(){
  const previous={url:process.env.SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY,service:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL='https://project.supabase.test';
  process.env.SUPABASE_ANON_KEY='anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY='service';
  return()=>{
    const names={url:'SUPABASE_URL',anon:'SUPABASE_ANON_KEY',service:'SUPABASE_SERVICE_ROLE_KEY'};
    for(const[key,value]of Object.entries(previous)){
      if(value===undefined)delete process.env[names[key]];else process.env[names[key]]=value;
    }
  };
}

test('Owner dapat berpindah konteks ke Owner lain tanpa token login baru',async()=>{
  const originalFetch=globalThis.fetch;const restore=setEnvironment();const audits=[];
  globalThis.fetch=installOwnerContextMock(audits);
  try{
    const switched=await callApi('POST','owner-contexts/switch',{ownerId:ids.target});
    assert.equal(switched.status,200);
    assert.equal(switched.body.contextId,ids.target);
    assert.equal(switched.body.owner.displayName,'Owner Kedua');
    assert.equal(audits.length,1);
    assert.equal(audits[0].actor_id,ids.original);
    assert.equal(audits[0].action,'OWNER_CONTEXT_SWITCHED');

    const contexts=await callApi('GET','owner-contexts',{}, {'x-owner-context-id':ids.target});
    assert.equal(contexts.status,200);
    assert.equal(contexts.body.authenticatedOwnerId,ids.original);
    assert.equal(contexts.body.activeOwnerId,ids.target);
    assert.equal(contexts.body.owners.find((owner)=>owner.id===ids.target).active,true);
  }finally{globalThis.fetch=originalFetch;restore();}
});

test('berpindah kembali ke Owner autentikasi menghapus konteks tambahan',async()=>{
  const originalFetch=globalThis.fetch;const restore=setEnvironment();const audits=[];
  globalThis.fetch=installOwnerContextMock(audits);
  try{
    const switched=await callApi('POST','owner-contexts/switch',{ownerId:ids.original},{'x-owner-context-id':ids.target});
    assert.equal(switched.status,200);
    assert.equal(switched.body.contextId,null);
    assert.equal(audits[0].details_json.fromOwnerId,ids.target);
    assert.equal(audits[0].details_json.toOwnerId,ids.original);
  }finally{globalThis.fetch=originalFetch;restore();}
});
