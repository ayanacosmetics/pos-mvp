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

async function logoRasterBytes(url,logoSize=64,paperWidth=80) {
  if(!url||typeof document==='undefined')return null;
  try{
    const response=await fetch(url);if(!response.ok)throw new Error('Logo tidak dapat diambil');
    const blob=await response.blob();
    const bitmap=typeof createImageBitmap==='function'?await createImageBitmap(blob):await new Promise((resolve,reject)=>{
      const image=new Image();image.onload=()=>resolve(image);image.onerror=reject;image.src=URL.createObjectURL(blob);
    });
    const targetWidth=Math.min(Number(paperWidth)===58?240:360,Math.round(80+(Math.max(32,Math.min(96,Number(logoSize)||64))-32)*2.5));
    const scale=Math.min(targetWidth/bitmap.width,140/bitmap.height,1);
    const width=Math.max(1,Math.round(bitmap.width*scale)),height=Math.max(1,Math.round(bitmap.height*scale));
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d',{willReadFrequently:true});context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(bitmap,0,0,width,height);
    const pixels=context.getImageData(0,0,width,height).data,bytesPerRow=Math.ceil(width/8),data=new Uint8Array(bytesPerRow*height);
    for(let y=0;y<height;y+=1)for(let x=0;x<width;x+=1){
      const index=(y*width+x)*4,luminance=.299*pixels[index]+.587*pixels[index+1]+.114*pixels[index+2];
      if(pixels[index+3]>40&&luminance<180)data[y*bytesPerRow+(x>>3)]|=0x80>>(x&7);
    }
    return new Uint8Array([GS,0x76,0x30,0x00,bytesPerRow&0xff,(bytesPerRow>>8)&0xff,height&0xff,(height>>8)&0xff,...data,LF]);
  }catch{return null;}
}

export function buildEscPosReceipt(receipt, payments = [], settings = {}, context = {}) {
  const width = Number(settings.paperWidth) === 58 ? 32 : 48;
  const quote = customerReceiptView(receipt.quote);
  const business = receipt.business ?? context.business ?? {};
  const layout = {
    headerAlignment:'center',footerAlignment:'center',titleSize:'large',density:'normal',
    separator:'dashed',showLogo:true,showBusinessName:true,showOutletName:true,
    showAddress:true,showPhone:true,showDate:true,showReceiptNumber:true,
    showCashier:true,showCustomer:true,showPriceType:true,showPaymentDetail:true,
    showTransactionNote:true,showLoyaltyPoints:true,customHeader:'',customFooter:'',contactLabel:'Tel.',
    ...(business.receiptLayout??{})
  };
  const outlet = receipt.outlet ?? context.outlet ?? {};
  const customer = receipt.customer ?? context.customer;
  const groupId = receipt.customerGroupId ?? customer?.group_id ?? 'retail';
  const groupName = context.customerGroups?.find((group) => group.id === groupId)?.name ?? groupId;
  const priceLabel = groupId === 'retail' ? '' : `Harga ${groupName}`;
  const footer = outlet.receipt_footer || business.receiptFooter || 'Terima kasih telah berbelanja.';
  const address = outlet.address || business.address;
  const phone = outlet.phone || business.phone;
  const occurredAt = new Date(receipt.occurredAt ?? Date.now()).toLocaleString('id-ID');
  const change = Number(receipt.change ?? 0);
  const separator=layout.separator==='double'?'='.repeat(width):rule(width);
  const bytes = [ESC, 0x40, ESC, 0x61, layout.headerAlignment==='left'?0x00:0x01];
  if(layout.showLogo&&context.logoRaster)bytes.push(...context.logoRaster);
  if(layout.showBusinessName){
    if(layout.titleSize==='large')bytes.push(ESC,0x21,0x20);
    bytes.push(ESC,0x45,0x01,...lineBytes(business.name || 'Kasir Nusa'),ESC,0x45,0x00);
    if(layout.titleSize==='large')bytes.push(ESC,0x21,0x00);
  }
  if(layout.showOutletName)bytes.push(...lineBytes(receipt.outletName || outlet.name || 'Outlet'));
  if(layout.customHeader)for(const textLine of String(layout.customHeader).split('\n'))for(const row of wrap(textLine,width))bytes.push(...lineBytes(row));
  if (layout.showAddress&&address) for (const row of wrap(address, width)) bytes.push(...lineBytes(row));
  if (layout.showPhone&&phone) bytes.push(...lineBytes(`${layout.contactLabel||'Tel.'} ${phone}`));
  if(layout.showDate)bytes.push(...lineBytes(occurredAt));
  if(layout.showReceiptNumber)bytes.push(ESC, 0x45, 0x01, ...lineBytes(receipt.receiptNo || 'STRUK TES'), ESC, 0x45, 0x00);
  if (receipt.status === 'VOIDED') bytes.push(...lineBytes('VOID / DIBATALKAN'));
  bytes.push(ESC, 0x61, 0x00, ...lineBytes(separator));
  if(layout.showCashier)bytes.push(...lineBytes(columns('Kasir', receipt.cashier || '-', width)));
  if (layout.showCustomer&&customer?.name) bytes.push(...lineBytes(columns('Pelanggan', customer.name, width)));
  bytes.push(...lineBytes(separator));
  for (const line of quote.lines) {
    for (const row of wrap(line.productName, width)) bytes.push(...lineBytes(row));
    if (layout.showPriceType&&priceLabel) bytes.push(...lineBytes(priceLabel));
    bytes.push(...lineBytes(columns(`${line.qty} ${line.unitName} x ${rupiah(line.customerUnitPrice)}`, rupiah(line.total), width)));
  }
  bytes.push(...lineBytes(separator));
  bytes.push(...lineBytes(columns('Subtotal', rupiah(quote.subtotal), width)));
  if (Math.abs(Number(quote.discountTotal)) > 0.01) bytes.push(...lineBytes(columns('Promo & diskon', `-${rupiah(Math.abs(quote.discountTotal))}`, width)));
  bytes.push(ESC, 0x45, 0x01, ...lineBytes(columns('TOTAL', rupiah(quote.grandTotal), width)), ESC, 0x45, 0x00);
  if(layout.showPaymentDetail)for (const payment of payments) bytes.push(...lineBytes(columns(payment.method || 'Pembayaran', rupiah(payment.amount), width)));
  if (layout.showPaymentDetail&&change) bytes.push(...lineBytes(columns('Kembalian', rupiah(change), width)));
  if (layout.showTransactionNote&&receipt.notes) {
    bytes.push(...lineBytes(separator));
    for (const row of wrap(`Catatan: ${receipt.notes}`, width)) bytes.push(...lineBytes(row));
  }
  if (layout.showLoyaltyPoints&&Number(receipt.pointsEarned) > 0) bytes.push(...lineBytes(`Poin +${Number(receipt.pointsEarned)} | Saldo ${Number(receipt.pointsBalance || 0)}`));
  bytes.push(...lineBytes(separator), ESC, 0x61, layout.footerAlignment==='left'?0x00:0x01);
  if(layout.customFooter)for(const textLine of String(layout.customFooter).split('\n'))for(const row of wrap(textLine,width))bytes.push(...lineBytes(row));
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
  const business = receipt.business ?? context.business ?? {};
  const layout = { showLogo:true, logoSize:64, ...(business.receiptLayout ?? {}) };
  const logoRaster = layout.showLogo
    ? await logoRasterBytes(business.logoUrl, layout.logoSize, settings.paperWidth)
    : null;
  const commands = buildEscPosReceipt(receipt, payments, settings, { ...context, logoRaster });
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
    customer: null,
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
