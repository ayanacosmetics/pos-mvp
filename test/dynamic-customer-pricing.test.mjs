import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { quoteBasket } from '../packages/domain/src/pricing.mjs';
import { buildEscPosReceipt } from '../apps/web/escpos-printer.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const product = {
  id:'p1',name:'Sabun',category:'Perawatan',brand:'Nusa',
  units:[{id:'u1',name:'pcs',factor:1}],
  priceRules:[{id:'retail',customerGroupId:'retail',minBaseQty:1,unitPriceBase:10000,priority:10}]
};

test('tipe pelanggan tanpa harga khusus memakai harga umum dengan aman', () => {
  const quote=quoteBasket({
    lines:[{productId:'p1',unitId:'u1',qty:2}],
    customerGroupId:'reseller',products:[product],promotions:[],at:new Date()
  });
  assert.equal(quote.grandTotal,20000);
  assert.equal(quote.lines[0].priceRuleId,'retail');
});

test('setiap tipe pelanggan dapat memiliki tingkat harga minimal sendiri', () => {
  const tieredProduct={...product,priceRules:[
    {id:'retail-1',customerGroupId:'retail',minBaseQty:1,unitPriceBase:10000,priority:10},
    {id:'retail-3',customerGroupId:'retail',minBaseQty:3,unitPriceBase:9000,priority:10},
    {id:'member-1',customerGroupId:'member',minBaseQty:1,unitPriceBase:9500,priority:20},
    {id:'member-3',customerGroupId:'member',minBaseQty:3,unitPriceBase:8000,priority:20}
  ]};
  const retail=quoteBasket({lines:[{productId:'p1',unitId:'u1',qty:3}],customerGroupId:'retail',products:[tieredProduct],promotions:[],at:new Date()});
  const member=quoteBasket({lines:[{productId:'p1',unitId:'u1',qty:3}],customerGroupId:'member',products:[tieredProduct],promotions:[],at:new Date()});
  assert.equal(retail.grandTotal,27000);
  assert.equal(member.grandTotal,24000);
  assert.equal(member.lines[0].priceRuleId,'member-3');
});

test('struk menampilkan nama pelanggan dan label harga tipe tanpa mencetak nama tipe sebagai profil', () => {
  const receipt=buildEscPosReceipt({
    receiptNo:'UTM-0001',occurredAt:'2026-07-27T12:00:00Z',cashier:'Ayu',
    customer:{name:'Budi',group_id:'member'},customerGroupId:'member',
    quote:{lines:[{productName:'Sabun',qty:1,unitName:'pcs',customerUnitPrice:9000,total:9000}],subtotal:9000,discountTotal:0,grandTotal:9000}
  },[{method:'CASH',amount:9000}],{paperWidth:58},{customerGroups:[{id:'retail',name:'Umum'},{id:'member',name:'Member'}]});
  const text=new TextDecoder().decode(receipt);
  assert.match(text,/Pelanggan\s+Budi/);
  assert.match(text,/Harga Member/);
  assert.doesNotMatch(text,/Pelanggan\s+Member/);
});

test('struk pelanggan umum tidak mencetak baris pelanggan atau label harga', () => {
  const receipt=buildEscPosReceipt({
    receiptNo:'UTM-0002',occurredAt:'2026-07-27T12:00:00Z',cashier:'Ayu',
    customer:null,customerGroupId:'retail',
    quote:{lines:[{productName:'Sabun',qty:1,unitName:'pcs',customerUnitPrice:10000,total:10000}],subtotal:10000,discountTotal:0,grandTotal:10000}
  },[{method:'CASH',amount:10000}],{paperWidth:58},{customerGroups:[{id:'retail',name:'Umum'}]});
  const text=new TextDecoder().decode(receipt);
  assert.doesNotMatch(text,/Pelanggan/);
  assert.doesNotMatch(text,/Harga Umum/);
});

test('migrasi dan aplikasi mengintegrasikan tipe pelanggan dengan harga produk dinamis', async () => {
  const [sql,tiersSql,api,html,app]=await Promise.all([
    read('../supabase/migrations/202607270038_dynamic_customer_price_groups.sql'),
    read('../supabase/migrations/202607280039_customer_group_price_tiers.sql'),
    read('../api/index.mjs'),read('../apps/web/index.html'),read('../apps/web/app.js')
  ]);
  assert.match(sql,/create table if not exists public\.customer_price_groups/);
  assert.match(sql,/foreign key\(tenant_id,group_id\)/);
  assert.match(sql,/function public\.save_product_v4/);
  assert.match(sql,/p_product->'prices'/);
  assert.match(tiersSql,/function public\.save_product_v5/);
  assert.match(tiersSql,/v_min_qty/);
  assert.match(api,/loadCustomerPriceGroups/);
  assert.match(api,/route === 'customer-groups'/);
  assert.match(api,/resolveSaleCustomerGroup/);
  assert.match(html,/id="customer-group-dialog"/);
  assert.match(html,/id="product-price-tiers"/);
  assert.match(app,/class="price-tier-min"/);
  assert.match(app,/class="price-tier-amount"/);
  assert.match(app,/add-product-price-tier/);
  assert.match(app,/Harga \$\{customerGroupName\(groupId\)\}/);
});
