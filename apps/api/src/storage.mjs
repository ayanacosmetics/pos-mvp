import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const now = () => new Date().toISOString();

export class PosStore {
  constructor(path, seedProducts = [], seedPromotions = []) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.migrate();
    this.seed(seedProducts, seedPromotions);
  }

  migrate() {
    this.db.exec(`
      create table if not exists stock_balances (
        location_id text not null, product_id text not null, quantity real not null default 0,
        avg_cost real not null default 0, updated_at text not null,
        primary key(location_id, product_id)
      );
      create table if not exists stock_ledger (
        id text primary key, location_id text not null, product_id text not null,
        delta real not null, balance_after real not null, unit_cost real not null,
        event_type text not null, reference_id text not null, note text, actor_id text,
        occurred_at text not null, idempotency_key text unique not null
      );
      create table if not exists sales (
        id text primary key, idempotency_key text unique not null, receipt_no text unique not null,
        cashier_id text not null, cashier_name text not null, customer_group_id text,
        subtotal real not null, discount_total real not null, grand_total real not null,
        cost_total real not null, payment_method text, occurred_at text not null, status text not null
      );
      create table if not exists sale_lines (
        id text primary key, sale_id text not null references sales(id), product_id text not null,
        product_name text not null, base_qty real not null, gross real not null,
        discount real not null, total real not null, cost_total real not null,
        pricing_snapshot text not null, promotion_snapshot text not null
      );
      create table if not exists purchase_receipts (
        id text primary key, idempotency_key text unique not null, document_no text not null,
        supplier_name text not null, location_id text not null, actor_id text not null,
        occurred_at text not null, status text not null
      );
      create table if not exists purchase_receipt_lines (
        id text primary key, receipt_id text not null references purchase_receipts(id),
        product_id text not null, base_qty real not null, unit_cost real not null, batch_no text
      );
      create table if not exists transfers (
        id text primary key, idempotency_key text unique not null, transfer_no text unique not null,
        from_location_id text not null, to_location_id text not null, actor_id text not null,
        occurred_at text not null, status text not null
      );
      create table if not exists transfer_lines (
        id text primary key, transfer_id text not null references transfers(id),
        product_id text not null, base_qty real not null, unit_cost real not null
      );
      create table if not exists stock_counts (
        id text primary key, count_no text unique not null, location_id text not null,
        actor_id text not null, occurred_at text not null, status text not null
      );
      create table if not exists returns (
        id text primary key, return_no text unique not null, sale_id text,
        location_id text not null, actor_id text not null, reason text not null,
        total real not null, occurred_at text not null, status text not null
      );
      create table if not exists return_lines (
        id text primary key, return_id text not null references returns(id), product_id text not null,
        product_name text not null, base_qty real not null, unit_refund real not null,
        line_total real not null, unit_cost real not null
      );
      create table if not exists audit_logs (
        id text primary key, actor_id text not null, action text not null,
        entity_type text not null, entity_id text not null, details_json text not null,
        occurred_at text not null
      );
      create table if not exists catalog_products (
        id text primary key, sku text unique not null, name text not null,
        category text not null, brand text, units_json text not null,
        price_rules_json text not null, active integer not null default 1,
        created_at text not null, updated_at text not null
      );
      create table if not exists promotion_rules (
        id text primary key, promotion_id text not null, code text not null,
        name text not null, version integer not null, status text not null,
        starts_at text not null, ends_at text not null, priority integer not null,
        stackable integer not null default 0, rule_json text not null,
        created_at text not null, unique(promotion_id, version)
      );
      create table if not exists customers (
        id text primary key, code text unique not null, name text not null,
        phone text, group_id text not null, active integer not null default 1,
        created_at text not null
      );
      create table if not exists suppliers (
        id text primary key, code text unique not null, name text not null,
        phone text, address text, active integer not null default 1,
        created_at text not null
      );
      create table if not exists shifts (
        id text primary key, outlet_id text not null, cashier_id text not null,
        cashier_name text not null, opened_at text not null, closed_at text,
        opening_cash real not null, expected_cash real, closing_cash real,
        difference real, status text not null
      );
      create table if not exists cash_movements (
        id text primary key, shift_id text not null references shifts(id),
        movement_type text not null, amount real not null, note text not null,
        actor_id text not null, occurred_at text not null
      );
    `);
    const saleColumns = this.db.prepare('pragma table_info(sales)').all().map((item) => item.name);
    if (!saleColumns.includes('shift_id')) this.db.exec('alter table sales add column shift_id text');
    if (!saleColumns.includes('customer_id')) this.db.exec('alter table sales add column customer_id text');
    if (!saleColumns.includes('notes')) this.db.exec('alter table sales add column notes text');
    if (!saleColumns.includes('void_reason')) this.db.exec('alter table sales add column void_reason text');
    if (!saleColumns.includes('voided_at')) this.db.exec('alter table sales add column voided_at text');
    if (!saleColumns.includes('voided_by')) this.db.exec('alter table sales add column voided_by text');
    if (!saleColumns.includes('void_approved_by')) this.db.exec('alter table sales add column void_approved_by text');
    const customerColumns = this.db.prepare('pragma table_info(customers)').all().map((item) => item.name);
    if (!customerColumns.includes('notes')) this.db.exec('alter table customers add column notes text');
    const returnColumns = this.db.prepare('pragma table_info(returns)').all().map((item) => item.name);
    if (!returnColumns.includes('idempotency_key')) this.db.exec('alter table returns add column idempotency_key text');
    if (!returnColumns.includes('refund_method')) this.db.exec('alter table returns add column refund_method text');
    if (!returnColumns.includes('refund_reference')) this.db.exec('alter table returns add column refund_reference text');
    const returnLineColumns = this.db.prepare('pragma table_info(return_lines)').all().map((item) => item.name);
    if (!returnLineColumns.includes('sale_line_id')) this.db.exec('alter table return_lines add column sale_line_id text');
    if (!returnLineColumns.includes('item_condition')) this.db.exec("alter table return_lines add column item_condition text not null default 'SALEABLE'");
    if (!returnLineColumns.includes('restockable')) this.db.exec('alter table return_lines add column restockable integer not null default 1');
    if (!returnLineColumns.includes('original_unit_cost')) this.db.exec('alter table return_lines add column original_unit_cost real');
    this.db.exec(`
      update return_lines set original_unit_cost=unit_cost where original_unit_cost is null;
      create unique index if not exists returns_idempotency on returns(idempotency_key) where idempotency_key is not null;
      create table if not exists customer_refunds (
        id text primary key, return_id text unique not null references returns(id), amount real not null,
        method text not null, reference text, shift_id text, actor_id text not null,
        status text not null, occurred_at text not null
      );
    `);
    this.db.exec(`
      insert into return_lines(id,return_id,product_id,product_name,base_qty,unit_refund,line_total,unit_cost)
      select lower(hex(randomblob(16))),returned.id,ledger.product_id,
        coalesce(product.name,ledger.product_id),ledger.delta,
        case when coalesce(sold.base_qty,0)=0 then 0 else sold.total/sold.base_qty end,
        case when coalesce(sold.base_qty,0)=0 then 0 else (sold.total/sold.base_qty)*ledger.delta end,
        case when coalesce(sold.base_qty,0)=0 then ledger.unit_cost else sold.cost_total/sold.base_qty end
      from returns returned
      join stock_ledger ledger on ledger.reference_id=returned.id and ledger.event_type='CUSTOMER_RETURN' and ledger.delta>0
      left join catalog_products product on product.id=ledger.product_id
      left join (
        select sale_id,product_id,sum(base_qty) base_qty,sum(total) total,sum(cost_total) cost_total
        from sale_lines group by sale_id,product_id
      ) sold on sold.sale_id=returned.sale_id and sold.product_id=ledger.product_id
      where not exists(select 1 from return_lines line where line.return_id=returned.id and line.product_id=ledger.product_id);
    `);
  }

  seed(products, promotions = []) {
    const count = this.db.prepare('select count(*) as total from stock_balances').get().total;
    if (!count) {
      const insert = this.db.prepare('insert into stock_balances(location_id, product_id, quantity, avg_cost, updated_at) values (?, ?, ?, ?, ?)');
      for (const product of products) {
        const seedCost = product.id === 'lip-tint-a' ? 30000 : product.id === 'bedak-b' ? 17000 : product.id === 'sabun-cair' ? 9000 : 21000;
        insert.run('outlet-utama', product.id, product.stockBase, seedCost, now());
        insert.run('gudang-utama', product.id, Math.round(product.stockBase * 1.5), seedCost, now());
      }
    }
    if (!this.db.prepare('select count(*) as total from catalog_products').get().total) {
      const insertProduct = this.db.prepare('insert into catalog_products values (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)');
      for (const product of products) insertProduct.run(product.id, product.sku, product.name, product.category, product.brand ?? null, JSON.stringify(product.units), JSON.stringify(product.priceRules), now(), now());
    }
    if (!this.db.prepare('select count(*) as total from promotion_rules').get().total) {
      const insertPromotion = this.db.prepare('insert into promotion_rules values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const promo of promotions) insertPromotion.run(promo.id, promo.promotionId, promo.code, promo.name, promo.version, promo.status, promo.startsAt, promo.endsAt, promo.priority, promo.stackable ? 1 : 0, JSON.stringify({ condition: promo.condition, reward: promo.reward }), now());
    }
    if (!this.db.prepare('select count(*) as total from customers').get().total) {
      this.db.prepare('insert into customers(id,code,name,phone,group_id,active,created_at,notes) values (?, ?, ?, ?, ?, 1, ?, ?)').run('customer-general', 'PLG-0001', 'Pelanggan Umum', null, 'retail', now(), null);
      this.db.prepare('insert into customers(id,code,name,phone,group_id,active,created_at,notes) values (?, ?, ?, ?, ?, 1, ?, ?)').run('customer-salon', 'PLG-0002', 'Salon Cantik Ayu', '081234567890', 'wholesale', now(), 'Pelanggan grosir rutin');
    }
    if (!this.db.prepare('select count(*) as total from suppliers').get().total) {
      this.db.prepare('insert into suppliers values (?, ?, ?, ?, ?, 1, ?)').run('sup-cantika', 'SUP-0001', 'PT Cantik Abadi', '081122334455', 'Makassar', now());
    }
  }

  catalog() {
    return this.db.prepare('select * from catalog_products where active = 1 order by name').all().map((row) => ({
      id: row.id, sku: row.sku, name: row.name, category: row.category, brand: row.brand,
      units: JSON.parse(row.units_json), priceRules: JSON.parse(row.price_rules_json), active: Boolean(row.active)
    }));
  }

  createProduct(input, actorId) {
    if (!input.sku?.trim() || !input.name?.trim() || !(input.retailPrice > 0)) throw new Error('SKU, nama, dan harga ecer wajib diisi');
    if (this.db.prepare('select id from catalog_products where lower(sku)=lower(?)').get(input.sku.trim())) throw new Error('SKU sudah digunakan');
    const allBarcodes = this.catalog().flatMap((product) => product.units.map((unit) => unit.barcode).filter(Boolean));
    if (input.barcode && allBarcodes.includes(input.barcode.trim())) throw new Error('Barcode sudah digunakan produk lain');
    const id = crypto.randomUUID();
    const unitId = `${id}-pcs`;
    const units = [{ id: unitId, name: input.unitName?.trim() || 'pcs', factor: 1, barcode: input.barcode?.trim() || null }];
    const customerPrices=Array.isArray(input.prices)&&input.prices.length?input.prices:[
      {customerGroupId:'retail',unitPriceBase:input.retailPrice},
      ...(input.wholesalePrice>0?[{customerGroupId:'wholesale',unitPriceBase:input.wholesalePrice}]:[])
    ];
    const priceRules = [
      ...customerPrices.filter((price)=>price.customerGroupId&&Number(price.unitPriceBase)>0).map((price)=>({
        id:`${id}-${price.customerGroupId}`,customerGroupId:price.customerGroupId,minBaseQty:1,unitPriceBase:Number(price.unitPriceBase)
      })),
      ...(input.tierQty > 1 && input.tierPrice > 0 ? [{ id: `${id}-tier`, customerGroupId: null, minBaseQty: Number(input.tierQty), unitPriceBase: Number(input.tierPrice) }] : [])
    ];
    this.transaction(() => {
      this.db.prepare('insert into catalog_products values (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)').run(id, input.sku.trim(), input.name.trim(), input.category?.trim() || 'Lainnya', input.brand?.trim() || null, JSON.stringify(units), JSON.stringify(priceRules), now(), now());
      for (const locationId of ['outlet-utama', 'gudang-utama']) this.db.prepare('insert into stock_balances values (?, ?, 0, 0, ?)').run(locationId, id, now());
      this.audit(actorId, 'PRODUCT_CREATED', 'product', id, { sku: input.sku.trim(), name: input.name.trim() });
    });
    return this.catalog().find((product) => product.id === id);
  }

  promotions() {
    return this.db.prepare(`select p.* from promotion_rules p join (
      select promotion_id, max(version) version from promotion_rules group by promotion_id
    ) latest on latest.promotion_id=p.promotion_id and latest.version=p.version order by p.priority desc`).all().map((row) => {
      const rule = JSON.parse(row.rule_json);
      return { id: row.id, promotionId: row.promotion_id, code: row.code, name: row.name, version: row.version, status: row.status, startsAt: row.starts_at, endsAt: row.ends_at, priority: row.priority, stackable: Boolean(row.stackable), ...rule };
    });
  }

  publishPromotion(input, actorId) {
    if (!input.code?.trim() || !input.name?.trim()) throw new Error('Kode dan nama promo wajib diisi');
    if (!(input.minBaseQty > 0) || !(input.discountPercent > 0 && input.discountPercent <= 100)) throw new Error('Syarat jumlah dan diskon promo tidak valid');
    const existing = this.db.prepare('select promotion_id, max(version) version from promotion_rules where code = ?').get(input.code.trim().toUpperCase());
    const promotionId = existing?.promotion_id ?? crypto.randomUUID();
    const version = Number(existing?.version ?? 0) + 1;
    const id = crypto.randomUUID();
    const startsAt = input.startsAt ?? new Date(Date.now() - 60_000).toISOString();
    const endsAt = input.endsAt ?? new Date(Date.now() + 30 * 86400_000).toISOString();
    const rule = { condition: { category: input.category, minBaseQty: Number(input.minBaseQty) }, reward: { type: 'PERCENT_ITEM', value: Number(input.discountPercent), maxDiscount: Number(input.maxDiscount ?? 100000) } };
    this.transaction(() => {
      this.db.prepare("update promotion_rules set status='RETIRED' where promotion_id=? and status='PUBLISHED'").run(promotionId);
      this.db.prepare('insert into promotion_rules values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, promotionId, input.code.trim().toUpperCase(), input.name.trim(), version, 'PUBLISHED', startsAt, endsAt, Number(input.priority ?? 50), input.stackable ? 1 : 0, JSON.stringify(rule), now());
      this.audit(actorId, 'PROMOTION_PUBLISHED', 'promotion', promotionId, { version, code: input.code.trim().toUpperCase() });
    });
    return this.promotions().find((promo) => promo.promotionId === promotionId);
  }

  customers() {
    return this.db.prepare('select * from customers where active=1 order by name').all();
  }

  createCustomer(input, actorId) {
    if (!input.name?.trim()) throw new Error('Nama pelanggan wajib diisi');
    const id = crypto.randomUUID();
    const code = `PLG-${String(this.db.prepare('select count(*) total from customers').get().total + 1).padStart(4, '0')}`;
    this.db.prepare('insert into customers(id,code,name,phone,group_id,active,created_at,notes) values (?, ?, ?, ?, ?, 1, ?, ?)').run(id, code, input.name.trim(), input.phone?.trim() || null, input.groupId === 'wholesale' ? 'wholesale' : 'retail', now(), input.notes?.trim() || null);
    this.audit(actorId, 'CUSTOMER_CREATED', 'customer', id, { code, name: input.name.trim() });
    return this.db.prepare('select * from customers where id=?').get(id);
  }

  suppliers() {
    return this.db.prepare('select * from suppliers where active=1 order by name').all();
  }

  createSupplier(input, actorId) {
    if (!input.name?.trim()) throw new Error('Nama supplier wajib diisi');
    const id = crypto.randomUUID();
    const code = `SUP-${String(this.db.prepare('select count(*) total from suppliers').get().total + 1).padStart(4, '0')}`;
    this.db.prepare('insert into suppliers values (?, ?, ?, ?, ?, 1, ?)').run(id, code, input.name.trim(), input.phone?.trim() || null, input.address?.trim() || null, now());
    this.audit(actorId, 'SUPPLIER_CREATED', 'supplier', id, { code, name: input.name.trim() });
    return this.db.prepare('select * from suppliers where id=?').get(id);
  }

  currentShift(cashierId, outletId = 'outlet-utama') {
    return this.db.prepare("select * from shifts where cashier_id=? and outlet_id=? and status='OPEN' order by opened_at desc limit 1").get(cashierId, outletId) ?? null;
  }

  openShift({ outletId = 'outlet-utama', cashier, openingCash }) {
    const existing = this.currentShift(cashier.id, outletId);
    if (existing) return existing;
    if (!(openingCash >= 0)) throw new Error('Modal awal kas tidak valid');
    const id = crypto.randomUUID();
    this.db.prepare('insert into shifts values (?, ?, ?, ?, ?, null, ?, null, null, null, ?)').run(id, outletId, cashier.id, cashier.displayName, now(), openingCash, 'OPEN');
    this.audit(cashier.id, 'SHIFT_OPENED', 'shift', id, { openingCash, outletId });
    return this.currentShift(cashier.id, outletId);
  }

  shiftExpected(shiftId) {
    const shift = this.db.prepare('select * from shifts where id=?').get(shiftId);
    if (!shift) throw new Error('Shift tidak ditemukan');
    const cashSales = this.db.prepare("select coalesce(sum(grand_total),0) total from sales where shift_id=? and payment_method='Tunai' and status='COMPLETED'").get(shiftId).total;
    const movements = this.db.prepare("select coalesce(sum(case when movement_type='CASH_IN' then amount else -amount end),0) total from cash_movements where shift_id=?").get(shiftId).total;
    return Number(shift.opening_cash) + Number(cashSales) + Number(movements);
  }

  addCashMovement({ shiftId, movementType, amount, note, actorId }) {
    if (!['CASH_IN', 'CASH_OUT'].includes(movementType) || !(amount > 0) || !note?.trim()) throw new Error('Jenis, jumlah, dan catatan kas wajib diisi');
    const shift = this.db.prepare("select * from shifts where id=? and status='OPEN'").get(shiftId);
    if (!shift) throw new Error('Shift sudah ditutup atau tidak ditemukan');
    const id = crypto.randomUUID();
    this.db.prepare('insert into cash_movements values (?, ?, ?, ?, ?, ?, ?)').run(id, shiftId, movementType, amount, note.trim(), actorId, now());
    this.audit(actorId, 'CASH_MOVEMENT_RECORDED', 'shift', shiftId, { movementType, amount, note: note.trim() });
    return { id, expectedCash: this.shiftExpected(shiftId) };
  }

  closeShift({ shiftId, closingCash, actorId }) {
    const shift = this.db.prepare("select * from shifts where id=? and status='OPEN'").get(shiftId);
    if (!shift) throw new Error('Shift sudah ditutup atau tidak ditemukan');
    if (!(closingCash >= 0)) throw new Error('Kas fisik tidak valid');
    const expectedCash = this.shiftExpected(shiftId);
    const difference = Number(closingCash) - expectedCash;
    this.db.prepare("update shifts set closed_at=?, expected_cash=?, closing_cash=?, difference=?, status='CLOSED' where id=?").run(now(), expectedCash, closingCash, difference, shiftId);
    this.audit(actorId, 'SHIFT_CLOSED', 'shift', shiftId, { expectedCash, closingCash, difference });
    return this.db.prepare('select * from shifts where id=?').get(shiftId);
  }

  shiftDetail(shiftId) {
    const shift = this.db.prepare('select * from shifts where id=?').get(shiftId);
    return shift ? { ...shift, expectedNow: shift.status === 'OPEN' ? this.shiftExpected(shiftId) : shift.expected_cash, movements: this.db.prepare('select * from cash_movements where shift_id=? order by occurred_at desc').all(shiftId) } : null;
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  balance(locationId, productId) {
    return this.db.prepare('select * from stock_balances where location_id = ? and product_id = ?').get(locationId, productId);
  }

  inventory() {
    return this.db.prepare('select * from stock_balances order by location_id, product_id').all();
  }

  ledger(limit = 100) {
    return this.db.prepare('select * from stock_ledger order by occurred_at desc, rowid desc limit ?').all(limit);
  }

  auditLogs(limit = 50) {
    return this.db.prepare('select * from audit_logs order by occurred_at desc, rowid desc limit ?').all(limit).map((item) => ({ ...item, details: JSON.parse(item.details_json) }));
  }

  audit(actorId, action, entityType, entityId, details) {
    this.db.prepare('insert into audit_logs values (?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), actorId, action, entityType, entityId, JSON.stringify(details), now());
  }

  moveStock({ locationId, productId, delta, unitCost, eventType, referenceId, note, actorId, idempotencyKey, allowNegative = false }) {
    const current = this.balance(locationId, productId) ?? { quantity: 0, avg_cost: 0 };
    const nextQty = current.quantity + delta;
    if (!allowNegative && nextQty < 0) throw new Error(`Stok ${productId} tidak cukup di ${locationId}`);
    let nextCost = current.avg_cost;
    if (delta > 0 && unitCost >= 0) {
      nextCost = nextQty === 0 ? 0 : ((current.quantity * current.avg_cost) + (delta * unitCost)) / nextQty;
    }
    this.db.prepare(`insert into stock_balances(location_id, product_id, quantity, avg_cost, updated_at)
      values (?, ?, ?, ?, ?) on conflict(location_id, product_id) do update set quantity=excluded.quantity, avg_cost=excluded.avg_cost, updated_at=excluded.updated_at`)
      .run(locationId, productId, nextQty, nextCost, now());
    this.db.prepare('insert into stock_ledger values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), locationId, productId, delta, nextQty, unitCost ?? current.avg_cost, eventType, referenceId, note ?? null, actorId ?? null, now(), idempotencyKey);
    return { quantity: nextQty, avgCost: nextCost };
  }

  recordSale({ key, quote, lines, cashier, customerId = null, customerGroupId, paymentMethod, shiftId, notes = '', locationId = 'outlet-utama' }) {
    const existing = this.db.prepare('select * from sales where idempotency_key = ?').get(key);
    if (existing) return this.sale(existing.id);
    return this.transaction(() => {
      const id = crypto.randomUUID();
      const sequence = this.db.prepare('select count(*) as total from sales').get().total + 1;
      const receiptNo = `UTM-${String(sequence).padStart(6, '0')}`;
      const occurredAt = now();
      let costTotal = 0;
      this.db.prepare(`insert into sales(id,idempotency_key,receipt_no,cashier_id,cashier_name,customer_group_id,subtotal,discount_total,grand_total,cost_total,payment_method,occurred_at,status,shift_id,customer_id,notes)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, key, receiptNo, cashier.id, cashier.displayName, customerGroupId, quote.subtotal, quote.discountTotal,
        quote.grandTotal, 0, paymentMethod ?? 'Tunai', occurredAt, 'COMPLETED', shiftId ?? null, customerId, String(notes ?? '').trim().slice(0,500) || null
      );
      for (let index = 0; index < quote.lines.length; index += 1) {
        const line = quote.lines[index];
        const balance = this.balance(locationId, line.productId);
        if (!balance || balance.quantity < line.baseQty) throw new Error(`Stok ${line.productName} tidak cukup`);
        const lineCost = balance.avg_cost * line.baseQty;
        costTotal += lineCost;
        this.db.prepare('insert into sale_lines values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          crypto.randomUUID(), id, line.productId, line.productName, line.baseQty, line.gross, line.discount, line.total,
          lineCost, JSON.stringify({ priceRuleId: line.priceRuleId, unitName: line.unitName, qty: line.qty }), JSON.stringify(line.promotions)
        );
        this.moveStock({ locationId, productId: line.productId, delta: -line.baseQty, unitCost: balance.avg_cost, eventType: 'SALE', referenceId: id, actorId: cashier.id, idempotencyKey: `${key}:stock:${index}` });
      }
      this.db.prepare('update sales set cost_total = ? where id = ?').run(costTotal, id);
      this.audit(cashier.id, 'SALE_COMPLETED', 'sale', id, { receiptNo, grandTotal: quote.grandTotal });
      return this.sale(id);
    });
  }

  sale(id) {
    const sale = this.db.prepare('select * from sales where id = ?').get(id);
    return sale ? { ...sale, lines: this.db.prepare('select * from sale_lines where sale_id = ?').all(id) } : null;
  }

  saleByReceipt(receiptNo) {
    const sale = this.db.prepare('select id from sales where upper(receipt_no)=upper(?)').get(String(receiptNo ?? '').trim());
    return sale ? this.returnableSale(sale.id) : null;
  }

  recentPosSales(limit = 50) {
    return this.db.prepare("select * from sales where status in ('COMPLETED','VOIDED') order by occurred_at desc limit ?").all(limit).map((sale) => {
      const customer = sale.customer_id ? this.db.prepare('select id,name,phone,notes from customers where id=?').get(sale.customer_id) ?? null : null;
      const lines = this.db.prepare('select * from sale_lines where sale_id=? order by rowid').all(sale.id).map((line) => {
        const pricing = JSON.parse(line.pricing_snapshot || '{}');
        return { productId:line.product_id,productName:line.product_name,qty:Number(pricing.qty ?? line.base_qty),unitName:pricing.unitName ?? 'pcs',baseQty:Number(line.base_qty),gross:Number(line.gross),discount:Number(line.discount),total:Number(line.total),promotions:JSON.parse(line.promotion_snapshot || '[]') };
      });
      return {
        id:sale.id,receiptNo:sale.receipt_no,status:sale.status,occurredAt:sale.occurred_at,cashier:sale.cashier_name,
        outletName:'Toko Utama',customer,notes:sale.notes ?? '',voidReason:sale.void_reason ?? '',voidedAt:sale.voided_at ?? null,
        quote:{lines,subtotal:Number(sale.subtotal),discountTotal:Number(sale.discount_total),grandTotal:Number(sale.grand_total)},
        payments:[{method:sale.payment_method ?? 'Tunai',amount:Number(sale.grand_total),tendered:null,reference:''}]
      };
    });
  }

  voidSale({ saleId, reason, actorId, approvedBy }) {
    const cleanReason=String(reason??'').trim().slice(0,240);
    if(cleanReason.length<5)throw new Error('Alasan void minimal 5 karakter');
    const sale=this.sale(saleId);
    if(!sale)throw new Error('Transaksi tidak ditemukan');
    if(sale.status==='VOIDED')return{ id:sale.id,receiptNo:sale.receipt_no,status:'VOIDED',duplicate:true };
    if(sale.status!=='COMPLETED')throw new Error('Hanya transaksi selesai yang dapat dibatalkan');
    if(!sale.shift_id||!this.db.prepare("select 1 from shifts where id=? and status='OPEN'").get(sale.shift_id))throw new Error('Void hanya dapat dilakukan sebelum shift transaksi ditutup');
    if(String(sale.payment_method??'').toLowerCase().includes('piutang'))throw new Error('Transaksi piutang tidak dapat di-void; gunakan retur');
    if(this.db.prepare("select 1 from returns where sale_id=? and status='COMPLETED' limit 1").get(saleId))throw new Error('Transaksi yang sudah diretur tidak dapat di-void');
    return this.transaction(()=>{
      sale.lines.forEach((line,index)=>this.moveStock({locationId:'outlet-utama',productId:line.product_id,delta:Number(line.base_qty),unitCost:Number(line.base_qty)>0?Number(line.cost_total)/Number(line.base_qty):0,eventType:'SALE_VOID',referenceId:sale.id,note:cleanReason,actorId,idempotencyKey:`VOID:${sale.id}:${index+1}`}));
      this.db.prepare("update sales set status='VOIDED',void_reason=?,voided_at=?,voided_by=?,void_approved_by=? where id=?").run(cleanReason,now(),actorId,approvedBy,sale.id);
      this.audit(actorId,'SALE_VOIDED','sale',sale.id,{receiptNo:sale.receipt_no,reason:cleanReason,approvedBy,grandTotal:Number(sale.grand_total)});
      return{id:sale.id,receiptNo:sale.receipt_no,status:'VOIDED',reason:cleanReason,approvedBy,duplicate:false};
    });
  }

  returnableSale(id) {
    const sale = this.sale(id);
    if (!sale) return null;
    const returned = this.db.prepare("select * from returns where sale_id=? and status='COMPLETED' order by occurred_at desc").all(id);
    const returnLines = returned.length ? this.db.prepare(`select * from return_lines where return_id in (${returned.map(()=>'?').join(',')})`).all(...returned.map((item)=>item.id)) : [];
    const directByLine = new Map(); const legacyByProduct = new Map();
    for (const line of returnLines) {
      if (line.sale_line_id) directByLine.set(line.sale_line_id,(directByLine.get(line.sale_line_id)??0)+Number(line.base_qty));
      else legacyByProduct.set(line.product_id,(legacyByProduct.get(line.product_id)??0)+Number(line.base_qty));
    }
    const lines = sale.lines.map((line) => {
      const soldQty=Number(line.base_qty); const directQty=directByLine.get(line.id)??0; const legacy=legacyByProduct.get(line.product_id)??0;
      const legacyUsed=Math.min(Math.max(0,soldQty-directQty),legacy); legacyByProduct.set(line.product_id,Math.max(0,legacy-legacyUsed));
      const returnedQty=directQty+legacyUsed; const remainingQty=Math.max(0,soldQty-returnedQty);
      return { saleItemId:line.id,productId:line.product_id,productName:line.product_name,soldQty,returnedQty,remainingQty,gross:Number(line.gross),discount:Number(line.discount),total:Number(line.total),unitRefund:soldQty?Number(line.total)/soldQty:0 };
    });
    return {
      id:sale.id,receiptNo:sale.receipt_no,outletId:sale.outlet_id,outletName:'Toko Utama',customer:null,
      cashierName:sale.cashier_name,paymentMethod:sale.payment_method,grandTotal:Number(sale.grand_total),occurredAt:sale.occurred_at,
      status:lines.some((line)=>line.remainingQty>0)?(returnLines.length?'PARTIALLY_RETURNED':'RETURNABLE'):'FULLY_RETURNED',
      refundableTotal:lines.reduce((sum,line)=>sum+line.remainingQty*line.unitRefund,0),lines,
      returns:returned.map((item)=>({ id:item.id,returnNo:item.return_no,reason:item.reason,total:Number(item.total),refundMethod:item.refund_method,refundReference:item.refund_reference,occurredAt:item.occurred_at,items:returnLines.filter((line)=>line.return_id===item.id) }))
    };
  }

  recentReturns(limit=50) {
    return this.db.prepare("select r.*,s.receipt_no from returns r left join sales s on s.id=r.sale_id where r.status='COMPLETED' order by r.occurred_at desc limit ?").all(limit).map((item)=>{
      const lines=this.db.prepare('select * from return_lines where return_id=?').all(item.id);
      return { id:item.id,returnNo:item.return_no,receiptNo:item.receipt_no,reason:item.reason,total:Number(item.total),refundMethod:item.refund_method,refundReference:item.refund_reference,actorName:item.actor_id,occurredAt:item.occurred_at,itemCount:lines.length,restockedQty:lines.filter((line)=>line.restockable!==0).reduce((sum,line)=>sum+Number(line.base_qty),0),damagedQty:lines.filter((line)=>line.restockable===0).reduce((sum,line)=>sum+Number(line.base_qty),0) };
    });
  }

  receivePurchase({ key, documentNo, supplierName, locationId, items, actorId }) {
    const existing = this.db.prepare('select * from purchase_receipts where idempotency_key = ?').get(key);
    if (existing) return existing;
    if (!items?.length || items.some((item) => !(item.baseQty > 0) || !(item.unitCost >= 0))) throw new Error('Item penerimaan harus memiliki jumlah positif dan modal valid');
    return this.transaction(() => {
      const id = crypto.randomUUID();
      this.db.prepare('insert into purchase_receipts values (?, ?, ?, ?, ?, ?, ?, ?)').run(id, key, documentNo, supplierName, locationId, actorId, now(), 'RECEIVED');
      items.forEach((item, index) => {
        this.db.prepare('insert into purchase_receipt_lines values (?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), id, item.productId, item.baseQty, item.unitCost, item.batchNo ?? null);
        this.moveStock({ locationId, productId: item.productId, delta: item.baseQty, unitCost: item.unitCost, eventType: 'PURCHASE_RECEIPT', referenceId: id, actorId, note: item.batchNo, idempotencyKey: `${key}:stock:${index}` });
      });
      this.audit(actorId, 'PURCHASE_RECEIVED', 'purchase_receipt', id, { documentNo, itemCount: items.length });
      return this.db.prepare('select * from purchase_receipts where id = ?').get(id);
    });
  }

  transfer({ key, fromLocationId, toLocationId, items, actorId }) {
    const existing = this.db.prepare('select * from transfers where idempotency_key = ?').get(key);
    if (existing) return existing;
    if (fromLocationId === toLocationId) throw new Error('Lokasi asal dan tujuan harus berbeda');
    if (!items?.length || items.some((item) => !(item.baseQty > 0))) throw new Error('Jumlah transfer harus lebih dari nol');
    return this.transaction(() => {
      const id = crypto.randomUUID();
      const sequence = this.db.prepare('select count(*) as total from transfers').get().total + 1;
      const transferNo = `TRF-${String(sequence).padStart(5, '0')}`;
      this.db.prepare('insert into transfers values (?, ?, ?, ?, ?, ?, ?, ?)').run(id, key, transferNo, fromLocationId, toLocationId, actorId, now(), 'RECEIVED');
      items.forEach((item, index) => {
        const source = this.balance(fromLocationId, item.productId);
        if (!source) throw new Error(`Stok ${item.productId} tidak ditemukan`);
        this.db.prepare('insert into transfer_lines values (?, ?, ?, ?, ?)').run(crypto.randomUUID(), id, item.productId, item.baseQty, source.avg_cost);
        this.moveStock({ locationId: fromLocationId, productId: item.productId, delta: -item.baseQty, unitCost: source.avg_cost, eventType: 'TRANSFER_OUT', referenceId: id, actorId, idempotencyKey: `${key}:out:${index}` });
        this.moveStock({ locationId: toLocationId, productId: item.productId, delta: item.baseQty, unitCost: source.avg_cost, eventType: 'TRANSFER_IN', referenceId: id, actorId, idempotencyKey: `${key}:in:${index}` });
      });
      this.audit(actorId, 'STOCK_TRANSFERRED', 'transfer', id, { transferNo, fromLocationId, toLocationId });
      return this.db.prepare('select * from transfers where id = ?').get(id);
    });
  }

  stockCount({ locationId, items, actorId }) {
    if (!items?.length || items.some((item) => !(item.countedQty >= 0))) throw new Error('Jumlah fisik opname tidak valid');
    return this.transaction(() => {
      const id = crypto.randomUUID();
      const sequence = this.db.prepare('select count(*) as total from stock_counts').get().total + 1;
      const countNo = `OPN-${String(sequence).padStart(5, '0')}`;
      this.db.prepare('insert into stock_counts values (?, ?, ?, ?, ?, ?)').run(id, countNo, locationId, actorId, now(), 'POSTED');
      items.forEach((item, index) => {
        const current = this.balance(locationId, item.productId) ?? { quantity: 0, avg_cost: 0 };
        const delta = item.countedQty - current.quantity;
        if (delta !== 0) this.moveStock({ locationId, productId: item.productId, delta, unitCost: current.avg_cost, eventType: 'STOCK_COUNT', referenceId: id, actorId, note: `Fisik ${item.countedQty}`, idempotencyKey: `${id}:count:${index}`, allowNegative: false });
      });
      this.audit(actorId, 'STOCK_COUNT_POSTED', 'stock_count', id, { countNo, locationId });
      return { id, countNo, status: 'POSTED' };
    });
  }

  processReturn({ key, saleId, items, reason, refundMethod='ORIGINAL', refundReference=null, refundShiftId=null, actorId }) {
    const existing = key ? this.db.prepare('select * from returns where idempotency_key=?').get(key) : null;
    if (existing) return { id:existing.id,returnNo:existing.return_no,total:existing.total,status:existing.status,refundMethod:existing.refund_method,duplicate:true };
    if (!items?.length || items.some((item) => !(item.baseQty > 0))) throw new Error('Jumlah retur harus lebih dari nol');
    if (!reason?.trim()) throw new Error('Alasan retur wajib diisi');
    const sale=this.sale(saleId); if(!sale) throw new Error('Transaksi penjualan tidak ditemukan');
    let method=String(refundMethod).toUpperCase();
    if(method==='ORIGINAL') method=/^tunai/i.test(sale.payment_method)?'CASH':/^qris/i.test(sale.payment_method)?'QRIS':/^edc/i.test(sale.payment_method)?'EDC':'TRANSFER';
    if(!['CASH','TRANSFER','QRIS','EDC'].includes(method)) throw new Error('Metode refund tidak valid');
    if(method!=='CASH'&&!String(refundReference??'').trim()) throw new Error('Referensi refund non-tunai wajib diisi');
    if(method==='CASH'){
      const shift=refundShiftId?this.shiftDetail(refundShiftId):null;
      if(!shift||shift.cashier_id!==actorId||shift.status!=='OPEN'||shift.outlet_id!==sale.outlet_id) throw new Error('Refund tunai harus memakai shift aktif milik pengguna pada outlet transaksi');
    }
    return this.transaction(() => {
      const id = crypto.randomUUID();
      const sequence = this.db.prepare('select count(*) as total from returns').get().total + 1;
      const returnNo = `RTR-${String(sequence).padStart(5, '0')}`;
      let total = 0;
      const locationId='outlet-utama';
      this.db.prepare('insert into returns(id,return_no,sale_id,location_id,actor_id,reason,total,occurred_at,status,idempotency_key,refund_method,refund_reference) values (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,returnNo,saleId,locationId,actorId,reason,0,now(),'COMPLETED',key??id,method,refundReference);
      items.forEach((item, index) => {
        const saleLine=this.db.prepare('select * from sale_lines where id=? and sale_id=?').get(item.saleItemId,saleId);
        if(!saleLine) throw new Error('Baris barang tidak ditemukan pada transaksi');
        const prior=this.db.prepare("select coalesce(sum(rl.base_qty),0) total from return_lines rl join returns r on r.id=rl.return_id where r.sale_id=? and r.status='COMPLETED' and rl.sale_line_id=?").get(saleId,saleLine.id).total;
        if(Number(prior)+Number(item.baseQty)>Number(saleLine.base_qty)) throw new Error('Jumlah retur melebihi sisa pada baris penjualan');
        const unitRefund=Number(saleLine.total)/Number(saleLine.base_qty);
        const unitCost=Number(saleLine.cost_total)/Number(saleLine.base_qty);
        const condition=String(item.condition??'SALEABLE').toUpperCase();
        if(!['SALEABLE','OPENED','DAMAGED','EXPIRED'].includes(condition)) throw new Error('Kondisi barang retur tidak valid');
        const restockable=condition==='SALEABLE';
        total += unitRefund * item.baseQty;
        if(restockable) this.moveStock({ locationId,productId:saleLine.product_id,delta:item.baseQty,unitCost,eventType:'CUSTOMER_RETURN',referenceId:id,actorId,note:reason,idempotencyKey:`${id}:return:${index}` });
        this.db.prepare('insert into return_lines(id,return_id,product_id,product_name,base_qty,unit_refund,line_total,unit_cost,sale_line_id,item_condition,restockable,original_unit_cost) values (?,?,?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),id,saleLine.product_id,saleLine.product_name,item.baseQty,unitRefund,unitRefund*item.baseQty,restockable?unitCost:0,saleLine.id,condition,restockable?1:0,unitCost);
      });
      this.db.prepare('update returns set total = ? where id = ?').run(total, id);
      this.db.prepare('insert into customer_refunds values (?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),id,total,method,refundReference,method==='CASH'?refundShiftId:null,actorId,'COMPLETED',now());
      if(method==='CASH'&&total>0) this.addCashMovement({ shiftId:refundShiftId,movementType:'CASH_OUT',amount:total,note:`Refund ${returnNo}`,actorId });
      this.audit(actorId,'RETURN_COMPLETED','return',id,{returnNo,total,reason,refundMethod:method});
      return { id,returnNo,total,status:'COMPLETED',refundMethod:method,duplicate:false };
    });
  }

  reportSummary({ from, to } = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(to ?? '') ? to : today;
    const defaultFrom = new Date(`${toDate}T12:00:00Z`); defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 29);
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(from ?? '') ? from : defaultFrom.toISOString().slice(0, 10);
    const inPeriod = (value) => value?.slice(0, 10) >= fromDate && value?.slice(0, 10) <= toDate;
    const sales = this.db.prepare("select * from sales where status='COMPLETED' order by occurred_at desc").all().filter((sale) => inPeriod(sale.occurred_at));
    const saleIds = new Set(sales.map((sale) => sale.id));
    const saleLines = this.db.prepare('select * from sale_lines').all().filter((line) => saleIds.has(line.sale_id));
    const returns = this.db.prepare("select * from returns where status='COMPLETED'").all().filter((item) => inPeriod(item.occurred_at));
    const returnIds = new Set(returns.map((item) => item.id));
    const returnLines = this.db.prepare('select * from return_lines').all().filter((line) => returnIds.has(line.return_id));
    const receipts = this.db.prepare("select * from purchase_receipts where status='RECEIVED'").all().filter((item) => inPeriod(item.occurred_at));
    const receiptIds = new Set(receipts.map((item) => item.id));
    const receiptLines = this.db.prepare('select * from purchase_receipt_lines').all().filter((line) => receiptIds.has(line.receipt_id));
    const inventory = this.db.prepare('select coalesce(sum(quantity*avg_cost),0) inventory_value, coalesce(sum(quantity),0) total_units from stock_balances').get();
    const sum = (rows, value) => rows.reduce((total, row) => total + Number(value(row) ?? 0), 0);
    const grossSales = sum(sales, (sale) => sale.grand_total);
    const returnTotal = sum(returnLines, (line) => line.line_total);
    const saleCost = sum(sales, (sale) => sale.cost_total);
    const returnCost = sum(returnLines, (line) => line.base_qty * line.unit_cost);
    const purchaseValue = sum(receiptLines, (line) => line.base_qty * line.unit_cost);
    const dates = [];
    for (let cursor = new Date(`${fromDate}T12:00:00Z`), end = new Date(`${toDate}T12:00:00Z`); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) dates.push(cursor.toISOString().slice(0, 10));
    const daily = dates.map((date) => {
      const daySales = sales.filter((sale) => sale.occurred_at.slice(0, 10) === date);
      const dayReturns = returns.filter((item) => item.occurred_at.slice(0, 10) === date);
      const dayReturnIds = new Set(dayReturns.map((item) => item.id));
      const dayReturnLines = returnLines.filter((line) => dayReturnIds.has(line.return_id));
      const dayGross = sum(daySales, (sale) => sale.grand_total); const dayReturn = sum(dayReturnLines, (line) => line.line_total);
      const daySaleCost = sum(daySales, (sale) => sale.cost_total); const dayReturnCost = sum(dayReturnLines, (line) => line.base_qty * line.unit_cost);
      return { date, grossSales: dayGross, returns: dayReturn, netSales: dayGross - dayReturn, grossProfit: (dayGross - dayReturn) - (daySaleCost - dayReturnCost), transactionCount: daySales.length, returnCount: dayReturns.length };
    });
    const products = new Map();
    for (const line of saleLines) products.set(line.product_id, { productId: line.product_id, productName: line.product_name, netQty: (products.get(line.product_id)?.netQty ?? 0) + line.base_qty, netRevenue: (products.get(line.product_id)?.netRevenue ?? 0) + line.total, grossProfit: (products.get(line.product_id)?.grossProfit ?? 0) + line.total - line.cost_total });
    for (const line of returnLines) products.set(line.product_id, { productId: line.product_id, productName: line.product_name, netQty: (products.get(line.product_id)?.netQty ?? 0) - line.base_qty, netRevenue: (products.get(line.product_id)?.netRevenue ?? 0) - line.line_total, grossProfit: (products.get(line.product_id)?.grossProfit ?? 0) - (line.line_total - line.base_qty * line.unit_cost) });
    const returnedBySale = new Map();
    for (const returned of this.db.prepare("select * from returns where status='COMPLETED'").all()) returnedBySale.set(returned.sale_id, (returnedBySale.get(returned.sale_id) ?? 0) + returned.total);
    const suppliers = new Map();
    for (const receipt of receipts) {
      const lines = receiptLines.filter((line) => line.receipt_id === receipt.id);
      const current = suppliers.get(receipt.supplier_name) ?? { supplierId: receipt.supplier_name, supplierName: receipt.supplier_name, receiptCount: 0, units: 0, purchaseValue: 0 };
      current.receiptCount += 1; current.units += sum(lines, (line) => line.base_qty); current.purchaseValue += sum(lines, (line) => line.base_qty * line.unit_cost); suppliers.set(receipt.supplier_name, current);
    }
    const grossProfit = (grossSales - returnTotal) - (saleCost - returnCost);
    return {
      period: { from: fromDate, to: toDate, timezone: 'Asia/Makassar' },
      metrics: { grossSales, returnTotal, netSales: grossSales - returnTotal, discounts: sum(sales, (sale) => sale.discount_total), costOfGoods: saleCost - returnCost, grossProfit, grossMarginPercent: grossSales - returnTotal ? (grossProfit / (grossSales - returnTotal)) * 100 : 0, transactionCount: sales.length, returnCount: returns.length, netUnits: sum(saleLines, (line) => line.base_qty) - sum(returnLines, (line) => line.base_qty), purchaseValue, inventoryUnits: inventory.total_units, inventoryValue: inventory.inventory_value },
      daily,
      products: [...products.values()].filter((item) => item.netQty || item.netRevenue || item.grossProfit).sort((a, b) => b.netRevenue - a.netRevenue).slice(0, 20),
      outlets: [{ outletId: 'outlet-utama', outletName: 'Toko Utama', transactionCount: sales.length, returnCount: returns.length, grossSales, returnTotal, netSales: grossSales - returnTotal, grossProfit }],
      recentSales: sales.slice(0, 20).map((sale) => ({ id: sale.id, receiptNo: sale.receipt_no, cashierName: sale.cashier_name, paymentMethod: sale.payment_method, grossTotal: sale.grand_total, returnTotal: returnedBySale.get(sale.id) ?? 0, netTotal: sale.grand_total - (returnedBySale.get(sale.id) ?? 0), occurredAt: sale.occurred_at })),
      suppliers: [...suppliers.values()].sort((a, b) => b.purchaseValue - a.purchaseValue), generatedAt: now()
    };
  }
}
