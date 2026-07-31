import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PERMISSIONS, permissionsFor } from '../packages/domain/src/permissions.mjs';

const migrationPath=new URL('../supabase/migrations/202607270031_advanced_multi_outlet.sql',import.meta.url);

test('v1.27 migration provides staged transfer, outlet scope, manager and notifications',async()=>{
  const sql=await readFile(migrationPath,'utf8');
  assert.match(sql,/create table if not exists public\.transfer_requests/);
  assert.match(sql,/REQUESTED','APPROVED','IN_TRANSIT','RECEIVED/);
  assert.match(sql,/create or replace function public\.request_stock_transfer_v1/);
  assert.match(sql,/create or replace function public\.advance_stock_transfer_v1/);
  assert.match(sql,/TRANSFER_DISPATCH/);
  assert.match(sql,/TRANSFER_RECEIVE/);
  assert.match(sql,/create table if not exists public\.outlet_price_overrides/);
  assert.match(sql,/create table if not exists public\.promotion_outlets/);
  assert.match(sql,/create table if not exists public\.operational_notifications/);
  assert.match(sql,/MANAGER/);
});

test('manager receives scoped multi-outlet permissions without owner finance',()=>{
  const permissions=permissionsFor('MANAGER');
  assert.equal(permissions.includes(PERMISSIONS.VIEW_MULTI_OUTLET),true);
  assert.equal(permissions.includes(PERMISSIONS.MANAGE_MULTI_OUTLET),true);
  assert.equal(permissions.includes(PERMISSIONS.OWNER_FINANCE),false);
  assert.equal(permissionsFor('OWNER').includes(PERMISSIONS.MANAGE_MULTI_OUTLET),true);
});

test('v1.27 UI exposes each multi-outlet feature as a separate sidebar page',async()=>{
  const html=await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8');
  const app=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8');
  for(const page of ['outlet-transfer-request','outlet-transfer-approval','outlet-in-transit','outlet-pricing','outlet-promotions','outlet-consolidation','outlet-notifications']){
    assert.match(html,new RegExp(`data-page="${page}"`));
    assert.match(html,new RegExp(`id="page-${page}"`));
  }
  assert.match(app,/loadMultiOutletWorkspace/);
  assert.doesNotMatch(html,/id="transfer-button"/);
});

test('cloud API protects multi-outlet routes and applies outlet price and promo scope',async()=>{
  const api=await readFile(new URL('../api/index.mjs',import.meta.url),'utf8');
  assert.match(api,/route === 'multi-outlet\/transfers'/);
  assert.match(api,/requirePermission\(session, 'multioutlet\.view'\)/);
  assert.match(api,/save_outlet_price_override_v1/);
  assert.match(api,/assign_promotion_outlets_v1/);
  assert.match(api,/priority: 100000/);
  assert.match(api,/version: '2\.16\.43-cloud'/);
});
