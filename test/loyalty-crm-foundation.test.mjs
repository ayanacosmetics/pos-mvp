import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('migration v1.23 protects voucher limits and posts loyalty atomically', async () => {
  const sql = await read('../supabase/migrations/202607260028_loyalty_crm_vouchers.sql');
  assert.match(sql, /create table if not exists public\.customer_point_entries/i);
  assert.match(sql, /create table if not exists public\.voucher_redemptions/i);
  assert.match(sql, /function public\.quote_voucher_v1/i);
  assert.match(sql, /usage_limit_per_customer/i);
  assert.match(sql, /segment in \('ALL','ACTIVE','INACTIVE','HIGH_VALUE','BIRTHDAY'\)/i);
  assert.match(sql, /function public\.complete_sale_v7/i);
  assert.match(sql, /function public\.void_sale_v2/i);
});

test('API and UI expose CRM, vouchers, consent, and private WhatsApp sharing', async () => {
  const [api, html, script] = await Promise.all([
    read('../api/index.mjs'), read('../apps/web/index.html'), read('../apps/web/app.js')
  ]);
  assert.match(api, /route==='crm\/dashboard'/);
  assert.match(api, /rpc\('complete_sale_v7'/);
  assert.match(api, /rpc\('quote_voucher_v1'/);
  assert.match(html, /id="voucher-code"/);
  assert.match(html, /id="customer-whatsapp-consent"/);
  assert.match(html, /id="loyalty-settings-form"/);
  assert.match(script, /https:\/\/wa\.me\//);
  assert.match(script, /customer\.whatsapp_consent/);
});
