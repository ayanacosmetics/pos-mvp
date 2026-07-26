import { customerReceiptView } from './receipt.mjs';

const encoder = new TextEncoder();
let activePort = null;
const nativeRequests = new Map();

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const nativeBridge = () => typeof window !== 'undefined' ? window.KasirNusaAndroid : null;

if (typeof window !== 'undefined') {
  window.__kasirNusaNativePrinterResponse = (requestId, success, message) => {
    const request = nativeRequests.get(requestId);
    if (!request) return;
    nativeRequests.delete(requestId);
    if (success) request.resolve(message);
    else request.reject(new Error(message || 'Operasi printer Android gagal.'));
  };
}

function nativeRequest(method, payload) {
  return new Promise((resolve, reject) => {
    const bridge = nativeBridge();
    if (!bridge?.[method]) return reject(new Error('Bridge printer Android tidak tersedia.'));
    const requestId = crypto.randomUUID();
    nativeRequests.set(requestId, { resolve, reject });
    const timeout = setTimeout(() => {
      if (!nativeRequests.has(requestId)) return;
      nativeRequests.delete(requestId);
      reject(new Error('Printer tidak merespons. Periksa daya dan koneksi Bluetooth.'));
    }, 30000);
    nativeRequests.set(requestId, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); }
    });
    if (payload === undefined) bridge[method](requestId);
    else bridge[method](requestId, payload);
  });
}

export const supportsBluetoothClassicPrinting = () => Boolean(nativeBridge() || (typeof navigator !== 'undefined' && navigator.serial));
export const printerConnected = () => nativeBridge()
  ? Boolean(nativeBridge().isPrinterConnected())
  : Boolean(activePort?.writable);
export const printerSelected = () => nativeBridge()
  ? Boolean(nativeBridge().isPrinterSelected())
  : Boolean(activePort);

function ascii(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '?');
}

function rupiah(value) {
  return `Rp ${Math.round(Number(value) || 0).toLocaleString('id-ID')}`;
}

function rule(columns) {
  return '-'.repeat(columns);
}

function wrap(value, width) {
  const words = ascii(value).trim().split(/\s+/).filter(Boolean);
  const rows = [];
  let row = '';
  for (const word of words) {
    if (!row) row = word.slice(0, width);
    else if (`${row} ${word}`.length <= width) row += ` ${word}`;
    else {
      rows.push(row);
      row = word.slice(0, width);
    }
  }
  if (row) rows.push(row);
  return rows.length ? rows : [''];
}

function columns(left, right, width) {
  const safeRight = ascii(right).slice(0, width);
  const leftWidth = Math.max(1, width - safeRight.length - 1);
  const leftRows = wrap(left, leftWidth);
  return leftRows.map((row, index) => index === leftRows.length - 1
    ? `${row}${' '.repeat(Math.max(1, width - row.length - safeRight.length))}${safeRight}`
    : row).join('\n');
}

function lineBytes(value = '') {
  return [...encoder.encode(`${ascii(value)}\n`)];
}

export function buildEscPosReceipt(receipt, payments = [], settings = {}, context = {}) {
  const width = Number(settings.paperWidth) === 58 ? 32 : 48;
  const quote = customerReceiptView(receipt.quote);
  const business = receipt.business ?? context.business ?? {};
  const outlet = receipt.outlet ?? context.outlet ?? {};
  const customer = receipt.customer ?? context.customer;
  const footer = outlet.receipt_footer || business.receiptFooter || 'Terima kasih telah berbelanja.';
  const address = outlet.address || business.address;
  const phone = outlet.phone || business.phone;
  const occurredAt = new Date(receipt.occurredAt ?? Date.now()).toLocaleString('id-ID');
  const change = Number(receipt.change ?? 0);
  const bytes = [ESC, 0x40, ESC, 0x61, 0x01, ESC, 0x45, 0x01];
  bytes.push(...lineBytes(business.name || 'Kasir Nusa'));
  bytes.push(ESC, 0x45, 0x00, ...lineBytes(receipt.outletName || outlet.name || 'Outlet'));
  if (address) for (const row of wrap(address, width)) bytes.push(...lineBytes(row));
  if (phone) bytes.push(...lineBytes(`Tel. ${phone}`));
  bytes.push(...lineBytes(occurredAt), ESC, 0x45, 0x01, ...lineBytes(receipt.receiptNo || 'STRUK TES'), ESC, 0x45, 0x00);
  if (receipt.status === 'VOIDED') bytes.push(...lineBytes('VOID / DIBATALKAN'));
  bytes.push(ESC, 0x61, 0x00, ...lineBytes(rule(width)));
  bytes.push(...lineBytes(columns('Kasir', receipt.cashier || '-', width)));
  bytes.push(...lineBytes(columns('Pelanggan', customer?.name || 'Pelanggan umum', width)));
  bytes.push(...lineBytes(rule(width)));
  for (const line of quote.lines) {
    for (const row of wrap(line.productName, width)) bytes.push(...lineBytes(row));
    bytes.push(...lineBytes(columns(`${line.qty} ${line.unitName} x ${rupiah(line.customerUnitPrice)}`, rupiah(line.total), width)));
  }
  bytes.push(...lineBytes(rule(width)));
  bytes.push(...lineBytes(columns('Subtotal', rupiah(quote.subtotal), width)));
  if (Math.abs(Number(quote.discountTotal)) > 0.01) bytes.push(...lineBytes(columns('Promo & diskon', `-${rupiah(Math.abs(quote.discountTotal))}`, width)));
  bytes.push(ESC, 0x45, 0x01, ...lineBytes(columns('TOTAL', rupiah(quote.grandTotal), width)), ESC, 0x45, 0x00);
  for (const payment of payments) bytes.push(...lineBytes(columns(payment.method || 'Pembayaran', rupiah(payment.amount), width)));
  if (change) bytes.push(...lineBytes(columns('Kembalian', rupiah(change), width)));
  if (receipt.notes) {
    bytes.push(...lineBytes(rule(width)));
    for (const row of wrap(`Catatan: ${receipt.notes}`, width)) bytes.push(...lineBytes(row));
  }
  if (Number(receipt.pointsEarned) > 0) bytes.push(...lineBytes(`Poin +${Number(receipt.pointsEarned)} | Saldo ${Number(receipt.pointsBalance || 0)}`));
  bytes.push(...lineBytes(rule(width)), ESC, 0x61, 0x01);
  for (const row of wrap(footer, width)) bytes.push(...lineBytes(row));
  bytes.push(LF, LF, LF, ESC, 0x61, 0x00);
  return new Uint8Array(bytes);
}

async function ensureOpen() {
  if (!activePort) throw new Error('Printer Bluetooth belum dipilih.');
  if (!activePort.writable) await activePort.open({ baudRate: 9600 });
  return activePort;
}

async function write(bytes) {
  if (nativeBridge()) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.slice(offset, offset + 8192));
    }
    await nativeRequest('printBase64', btoa(binary));
    return;
  }
  const port = await ensureOpen();
  const writer = port.writable.getWriter();
  try {
    for (let offset = 0; offset < bytes.length; offset += 512) {
      await writer.write(bytes.slice(offset, offset + 512));
    }
  } finally {
    writer.releaseLock();
  }
}

export async function restoreGrantedPrinter() {
  if (!supportsBluetoothClassicPrinting()) return false;
  if (nativeBridge()) return printerSelected();
  const ports = await navigator.serial.getPorts();
  activePort = ports[0] ?? null;
  return Boolean(activePort);
}

export async function selectBluetoothPrinter() {
  if (!supportsBluetoothClassicPrinting()) throw new Error('Chrome Android minimal versi 138 diperlukan.');
  if (nativeBridge()) {
    await nativeRequest('connectPrinter');
    return true;
  }
  if (!activePort) activePort = await navigator.serial.requestPort();
  await ensureOpen();
  return true;
}

export async function disconnectBluetoothPrinter() {
  if (nativeBridge()) {
    await nativeRequest('disconnectPrinter');
    return;
  }
  if (activePort?.writable) await activePort.close();
}

export async function printEscPosReceipt(receipt, payments, settings, context) {
  const copies = Math.max(1, Math.min(3, Number(settings.receiptCopies ?? 1)));
  const commands = buildEscPosReceipt(receipt, payments, settings, context);
  for (let copy = 0; copy < copies; copy += 1) await write(commands);
}

export async function printEscPosTest(settings, context = {}) {
  const now = new Date().toISOString();
  await printEscPosReceipt({
    receiptNo: 'TES-PRINTER',
    occurredAt: now,
    cashier: context.cashier || 'Kasir Nusa',
    business: context.business,
    outlet: context.outlet,
    outletName: context.outlet?.name,
    customer: { name: 'Pelanggan umum' },
    quote: {
      lines: [{ productName: 'Tes cetak Bluetooth', qty: 1, unitName: 'pcs', customerUnitPrice: 1000, total: 1000 }],
      subtotal: 1000,
      discountTotal: 0,
      grandTotal: 1000
    },
    change: 0,
    notes: 'Jika tulisan ini terbaca, printer siap digunakan.'
  }, [{ method: 'TUNAI', amount: 1000 }], { ...settings, receiptCopies: 1 }, context);
}
