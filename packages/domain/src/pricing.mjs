const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const normalized = (value) => String(value ?? '').trim().toLowerCase();

function zonedClock(at, timeZone = 'Asia/Makassar') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(values.weekday);
  return { day, time: `${values.hour}:${values.minute}` };
}

function isActive(promo, at) {
  const time = at.getTime();
  if (promo.status !== 'PUBLISHED' || time < new Date(promo.startsAt).getTime() || time > new Date(promo.endsAt).getTime()) return false;
  const schedule = promo.condition?.schedule;
  if (!schedule) return true;
  const clock = zonedClock(at, schedule.timeZone);
  if (Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length && !schedule.daysOfWeek.map(Number).includes(clock.day)) return false;
  if (schedule.timeStart && schedule.timeEnd) {
    if (schedule.timeStart <= schedule.timeEnd && (clock.time < schedule.timeStart || clock.time > schedule.timeEnd)) return false;
    if (schedule.timeStart > schedule.timeEnd && clock.time < schedule.timeStart && clock.time > schedule.timeEnd) return false;
  } else {
    if (schedule.timeStart && clock.time < schedule.timeStart) return false;
    if (schedule.timeEnd && clock.time > schedule.timeEnd) return false;
  }
  return true;
}

export function selectPriceRule(product, customerGroupId, baseQty) {
  let eligible = product.priceRules.filter((rule) =>
    baseQty >= rule.minBaseQty && (rule.customerGroupId === null || rule.customerGroupId === customerGroupId)
  );
  if (!eligible.length && customerGroupId !== 'retail') {
    eligible = product.priceRules.filter((rule) =>
      baseQty >= rule.minBaseQty && (rule.customerGroupId === null || rule.customerGroupId === 'retail')
    );
  }
  if (!eligible.length) throw new Error(`Harga tidak ditemukan untuk ${product.name}`);
  return eligible.sort((a, b) => {
    const specificity = Number(Boolean(b.customerGroupId)) - Number(Boolean(a.customerGroupId));
    return b.minBaseQty - a.minBaseQty || specificity;
  })[0];
}

function matchesTarget(line, condition = {}) {
  const productIds = condition.productIds ?? [];
  const categories = condition.categories ?? (condition.category ? [condition.category] : []);
  const brands = condition.brands ?? [];
  if (productIds.length && !productIds.includes(line.productId)) return false;
  if (categories.length && !categories.some((value) => normalized(value) === normalized(line.category))) return false;
  if (brands.length && !brands.some((value) => normalized(value) === normalized(line.brand))) return false;
  return true;
}

function eligibleForPromo(line, promo, customerGroupId, subtotal) {
  const condition = promo.condition ?? {};
  if (Array.isArray(condition.customerGroupIds) && condition.customerGroupIds.length && !condition.customerGroupIds.includes(customerGroupId)) return false;
  if (Number(condition.minBasketSubtotal ?? 0) > subtotal) return false;
  if (line.baseQty < Number(condition.minBaseQty ?? 0)) return false;
  return matchesTarget(line, condition);
}

function promotionSnapshot(promo, discount, reason) {
  return { id: promo.id, code: promo.code, version: promo.version, discount: roundMoney(discount), reason };
}

function applyDiscount(line, promo, amount, reason) {
  if (!(amount > 0) || line._locked) return 0;
  if (line.promotions.length && !promo.stackable) return 0;
  const applied = roundMoney(Math.min(amount, line.gross - line.discount));
  if (!(applied > 0)) return 0;
  line.discount = roundMoney(line.discount + applied);
  line.promotions.push(promotionSnapshot(promo, applied, reason));
  if (!promo.stackable) line._locked = true;
  return applied;
}

function distributeDiscount(lines, promo, amount, reason) {
  const eligible = lines.filter((line) => !line._locked && (!line.promotions.length || promo.stackable) && line.gross > line.discount);
  const available = eligible.reduce((sum, line) => sum + line.gross - line.discount, 0);
  if (!(available > 0) || !(amount > 0)) return;
  let remaining = roundMoney(Math.min(amount, available));
  eligible.forEach((line, index) => {
    const share = index === eligible.length - 1 ? remaining : roundMoney(Math.min(remaining, amount * ((line.gross - line.discount) / available)));
    const applied = applyDiscount(line, promo, share, reason);
    remaining = roundMoney(remaining - applied);
  });
}

function applyItemPromotion(promo, lines, customerGroupId, subtotal) {
  const reward = promo.reward ?? {};
  for (const line of lines.filter((item) => eligibleForPromo(item, promo, customerGroupId, subtotal))) {
    let discount = 0;
    let reason = '';
    if (reward.type === 'PERCENT_ITEM') {
      discount = Math.min(line.gross * (Number(reward.value) / 100), Number(reward.maxDiscount ?? Number.MAX_SAFE_INTEGER));
      reason = `${reward.value}% untuk minimal ${promo.condition?.minBaseQty ?? 0} satuan dasar`;
    } else if (reward.type === 'FIXED_ITEM') {
      discount = Number(reward.value) * line.baseQty;
      reason = `Potongan ${reward.value} per satuan dasar`;
    } else if (reward.type === 'SPECIAL_PRICE') {
      discount = line.gross - Number(reward.value) * line.baseQty;
      reason = `Harga khusus ${reward.value} per satuan dasar`;
    }
    applyDiscount(line, promo, discount, reason);
  }
}

function applyOrderPromotion(promo, lines, customerGroupId, subtotal) {
  const eligible = lines.filter((line) => eligibleForPromo(line, promo, customerGroupId, subtotal));
  const base = eligible.reduce((sum, line) => sum + line.gross - line.discount, 0);
  const discount = Math.min(base * (Number(promo.reward?.value) / 100), Number(promo.reward?.maxDiscount ?? Number.MAX_SAFE_INTEGER));
  distributeDiscount(eligible, promo, discount, `${promo.reward?.value}% dari belanja yang memenuhi syarat`);
}

function applyFixedOrderPromotion(promo, lines, customerGroupId, subtotal) {
  const condition = promo.condition ?? {};
  if (Array.isArray(condition.customerGroupIds) && condition.customerGroupIds.length && !condition.customerGroupIds.includes(customerGroupId)) return;
  const eligible = lines.filter((line) => matchesTarget(line, condition));
  if (!eligible.length) return;
  const targetQty = eligible.reduce((sum, line) => sum + line.baseQty, 0);
  const minQty = Number(condition.minBaseQty ?? 0);
  const minBasket = Number(condition.minBasketSubtotal ?? 0);
  if (targetQty < minQty || subtotal < minBasket) return;
  const reward = promo.reward ?? {};
  let repeatCount = 1;
  if (reward.repeatMode === 'MULTIPLE') {
    const limits = [];
    if (minQty > 0) limits.push(Math.floor(targetQty / minQty));
    if (minBasket > 0) limits.push(Math.floor(subtotal / minBasket));
    repeatCount = limits.length ? Math.min(...limits) : 1;
    const cap = Number(reward.repeatCap ?? 0);
    if (cap > 0) repeatCount = Math.min(repeatCount, cap);
  }
  if (!(repeatCount > 0)) return;
  const discount = Number(reward.value ?? 0) * repeatCount;
  const repetition = reward.repeatMode === 'MULTIPLE' ? `${repeatCount} kelipatan` : 'berlaku sekali';
  distributeDiscount(eligible, promo, discount, `Potongan tetap ${reward.value} (${repetition})`);
}

function applyBuyGetPromotion(promo, lines, customerGroupId, subtotal) {
  const buyLines = lines.filter((line) => eligibleForPromo(line, promo, customerGroupId, subtotal));
  const reward = promo.reward ?? {};
  const buyQty = Number(reward.buyQty ?? promo.condition?.minBaseQty ?? 1);
  const freeQty = Number(reward.freeQty ?? 1);
  const rewardIds = reward.productIds ?? [];
  const rewardLines = rewardIds.length ? lines.filter((line) => rewardIds.includes(line.productId)) : buyLines;
  const sameTarget = !rewardIds.length || rewardLines.every((line) => buyLines.some((buy) => buy.productId === line.productId));
  const purchased = buyLines.reduce((sum, line) => sum + line.baseQty, 0);
  const freeEligible = sameTarget ? Math.floor(purchased / (buyQty + freeQty)) * freeQty : Math.floor(purchased / buyQty) * freeQty;
  let remaining = freeEligible;
  for (const line of [...rewardLines].sort((a,b)=>a.baseUnitPrice-b.baseUnitPrice || a.productName.localeCompare(b.productName))) {
    if (remaining <= 0) break;
    const qty = Math.min(remaining, line.baseQty);
    const appliedQty = applyDiscount(line, promo, qty * line.baseUnitPrice, `Beli ${buyQty} gratis ${freeQty}`) > 0 ? qty : 0;
    remaining -= appliedQty;
  }
}

function applyBundlePromotion(promo, lines) {
  const bundle = promo.condition?.bundle ?? [];
  if (!bundle.length) return;
  const members = bundle.map((item) => ({ ...item, line: lines.find((line) => line.productId === item.productId) }));
  if (members.some((item) => !item.line || item.line._locked || (!promo.stackable && item.line.promotions.length))) return;
  const bundleCount = Math.min(...members.map((item) => Math.floor(item.line.baseQty / Number(item.qty))));
  if (!(bundleCount > 0)) return;
  const regular = members.reduce((sum, item) => sum + item.line.baseUnitPrice * Number(item.qty), 0) * bundleCount;
  const discount = regular - Number(promo.reward?.value) * bundleCount;
  distributeDiscount(members.map((item) => item.line), promo, discount, `Paket ${bundleCount} × ${promo.reward?.value}`);
}

export function quoteBasket({ lines, customerGroupId = 'retail', products, promotions, at = new Date() }) {
  const quotedLines = lines.map((line) => {
    const product = products.find((item) => item.id === line.productId);
    if (!product) throw new Error(`Produk ${line.productId} tidak ditemukan`);
    const unit = product.units.find((item) => item.id === line.unitId);
    if (!unit) throw new Error(`Satuan ${line.unitId} tidak ditemukan`);
    if (!Number.isFinite(line.qty) || line.qty <= 0) throw new Error('Jumlah harus lebih dari nol');
    const baseQty = line.qty * unit.factor;
    const priceRule = selectPriceRule(product, customerGroupId, baseQty);
    const gross = roundMoney(priceRule.unitPriceBase * baseQty);
    return { ...line, productName: product.name, category: product.category, brand: product.brand, unitName: unit.name, baseQty, baseUnitPrice: Number(priceRule.unitPriceBase), priceRuleId: priceRule.id, gross, discount: 0, promotions: [], _locked: false };
  });
  const subtotal = roundMoney(quotedLines.reduce((sum, line) => sum + line.gross, 0));
  const activePromotions = promotions.filter((promo) => isActive(promo, at)).sort((a, b) => b.priority - a.priority || String(a.code).localeCompare(String(b.code)));
  for (const promo of activePromotions) {
    const type = promo.reward?.type ?? 'PERCENT_ITEM';
    if (['PERCENT_ITEM','FIXED_ITEM','SPECIAL_PRICE'].includes(type)) applyItemPromotion(promo, quotedLines, customerGroupId, subtotal);
    if (type === 'PERCENT_ORDER') applyOrderPromotion(promo, quotedLines, customerGroupId, subtotal);
    if (type === 'FIXED_ORDER') applyFixedOrderPromotion(promo, quotedLines, customerGroupId, subtotal);
    if (type === 'BUY_X_GET_Y') applyBuyGetPromotion(promo, quotedLines, customerGroupId, subtotal);
    if (type === 'BUNDLE_FIXED') applyBundlePromotion(promo, quotedLines);
  }
  for (const line of quotedLines) {
    line.total = roundMoney(line.gross - line.discount);
    delete line._locked;
  }
  const discountTotal = roundMoney(quotedLines.reduce((sum, line) => sum + line.discount, 0));
  return { lines: quotedLines, subtotal, discountTotal, grandTotal: roundMoney(subtotal - discountTotal), promotionEngineVersion: '2.1.0' };
}

export function compareCost(newCost, history = []) {
  const last = [...history].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
  if (!last) return { lastCost: null, difference: null, percentage: null, level: 'NEW' };
  const difference = roundMoney(newCost - last.costPerBase);
  const percentage = roundMoney((difference / last.costPerBase) * 100);
  const level = percentage <= 0 ? 'OK' : percentage <= 5 ? 'WARNING' : 'DANGER';
  return { lastCost: last.costPerBase, difference, percentage, level, lastSupplier: last.supplier, lastBatch: last.batch, lastDate: last.occurredAt };
}
