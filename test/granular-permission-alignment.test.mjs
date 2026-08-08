import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/202608080001_align_granular_permissions.sql', import.meta.url), 'utf8');
const api = await readFile(new URL('../api/index.mjs', import.meta.url), 'utf8');

test('database has one effective-permission helper matching custom permission override semantics', () => {
  assert.match(migration,/function public\.profile_has_permission_v1/);
  assert.match(migration,/when custom_permissions is not null then/);
  assert.match(migration,/p_permission=any\(custom_permissions\)/);
  assert.match(migration,/when role='MANAGER'/);
  assert.match(migration,/when role='PURCHASING'/);
  assert.match(migration,/when role='WAREHOUSE'/);
  assert.match(migration,/profile_can_receive_purchase_v1[\s\S]*profile_has_permission_v1\(p_tenant_id,p_actor_id,'purchasing\.receive'\)/);
  assert.match(migration,/can_manage_product_catalog_v1[\s\S]*profile_has_permission_v1\(p_tenant_id,p_actor_id,'catalog\.manage'\)/);
});

test('all API-granted mutation families replace obsolete fixed-role database gates', () => {
  const expected = new Map([
    ['sale.adjust',['create_sale_adjustment_authorization']],
    ['sales.return',['process_customer_return_v2']],
    ['promotion.manage',['publish_promotion_v2','retire_promotion_version']],
    ['report.view',['report_operational_summary']],
    ['approval.manage',['decide_approval_request']],
    ['workforce.manage',['save_employee_shift_rule_v2']],
    ['multioutlet.manage',['request_stock_transfer_v1','advance_stock_transfer_v1','save_outlet_price_override_v1','assign_promotion_outlets_v1']],
    ['purchasing.receive',['save_restock_policy_v1','save_purchase_order','transition_purchase_order','record_supplier_payment','post_supplier_return']],
    ['pos.sell',['record_customer_payment','void_sale_v1']],
    ['sale.void',['void_sale_v1']]
  ]);
  for (const [permission,functions] of expected) {
    assert.match(api,new RegExp(`requirePermission\\(session, ?['"]${permission.replace('.','\\.')}['"]\\)`),`API must enforce ${permission}`);
    for (const name of functions) {
      assert.match(migration,new RegExp(`['"]${name}['"]`),`${name} must be covered by DB alignment`);
      assert.match(migration,new RegExp(`profile_has_permission_v1\\(p_tenant_id,p_(?:actor_id|approved_by),'${permission.replace('.','\\.')}'\\)`),`${name} must use ${permission}`);
    }
  }
});

test('sensitive owner-only operations are not broadened by the permission alignment', () => {
  for (const name of ['delete_products_v1','reset_tenant_data_v1','restore_tenant_backup_v2','report_owner_finance','post_manual_journal_v1']) {
    assert.doesNotMatch(migration,new RegExp(`['"]${name}['"]`));
  }
  assert.match(migration,/v_required:=v_order\.grand_total>v_threshold and v_role not in \('OWNER','ADMIN'\)/);
  assert.doesNotMatch(migration,/transition_purchase_order'[\s\S]*Hanya Owner\/Admin dapat menyetujui PO[\s\S]*profile_has_permission_v1/);
});
