import { customerReceiptView } from './receipt.mjs';
import { barcodeRasterBits } from './product-labels.mjs';

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

function qrBytes(value) {
  const data=encoder.encode(String(value??''));
  const length=data.length+3;
  return [
    GS,0x28,0x6b,0x04,0x00,0x31,0x41,0x32,0x00,
    GS,0x28,0x6b,0x03,0x00,0x31,0x43,0x05,
    GS,0x28,0x6b,0x03,0x00,0x31,0x45,0x31,
    GS,0x28,0x6b,length&0xff,(length>>8)&0xff,0x31,0x50,0x30,...data,
    GS,0x28,0x6b,0x03,0x00,0x31,0x51,0x30
  ];
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
  const returnLabel=receipt.returnStatus==='FULLY_RETURNED'?'DIRETUR PENUH':receipt.returnStatus==='PARTIALLY_RETURNED'?'DIRETUR SEBAGIAN':'';
  if(returnLabel)bytes.push(ESC,0x45,0x01,...lineBytes(returnLabel),ESC,0x45,0x00);
  bytes.push(ESC, 0x61, 0x00, ...lineBytes(separator));
  if(layout.showCashier)bytes.push(...lineBytes(columns('Kasir', receipt.cashier || '-', width)));
  if (layout.showCustomer&&customer?.name) bytes.push(...lineBytes(columns('Pelanggan', customer.name, width)));
  bytes.push(...lineBytes(separator));
  for (const line of quote.lines) {
    for (const row of wrap(line.productName, width)) bytes.push(...lineBytes(row));
    if (layout.showPriceType&&priceLabel) bytes.push(...lineBytes(priceLabel));
    bytes.push(...lineBytes(columns(`${line.qty} ${line.unitName} x ${rupiah(line.customerUnitPrice)}`, rupiah(line.total), width)));
    if(Number(line.returnedQty)>0)bytes.push(...lineBytes(`  Diretur ${Number(line.returnedQty).toLocaleString('id-ID')} ${line.unitName}: -${rupiah(line.returnedTotal)}`));
  }
  bytes.push(...lineBytes(separator));
  bytes.push(...lineBytes(columns('Subtotal', rupiah(quote.subtotal), width)));
  if (Math.abs(Number(quote.discountTotal)) > 0.01) bytes.push(...lineBytes(columns('Promo & diskon', `-${rupiah(Math.abs(quote.discountTotal))}`, width)));
  const returnTotal=Number(receipt.returnTotal??0);
  if(returnTotal){
    bytes.push(...lineBytes(columns('TOTAL AWAL',rupiah(quote.grandTotal),width)));
    bytes.push(...lineBytes(columns('RETUR / REFUND',`-${rupiah(returnTotal)}`,width)));
    bytes.push(ESC,0x45,0x01,...lineBytes(columns('TOTAL SETELAH RETUR',rupiah(receipt.netTotal??Math.max(0,quote.grandTotal-returnTotal)),width)),ESC,0x45,0x00);
  }else bytes.push(ESC, 0x45, 0x01, ...lineBytes(columns('TOTAL', rupiah(quote.grandTotal), width)), ESC, 0x45, 0x00);
  if(layout.showPaymentDetail)for (const payment of payments) bytes.push(...lineBytes(columns(payment.method || 'Pembayaran', rupiah(payment.amount), width)));
  if (layout.showPaymentDetail&&change) bytes.push(...lineBytes(columns('Kembalian', rupiah(change), width)));
  if (layout.showTransactionNote&&receipt.notes) {
    bytes.push(...lineBytes(separator));
    for (const row of wrap(`Catatan: ${receipt.notes}`, width)) bytes.push(...lineBytes(row));
  }
  if (layout.showLoyaltyPoints&&Number(receipt.pointsEarned) > 0) bytes.push(...lineBytes(`Poin +${Number(receipt.pointsEarned)} | Saldo ${Number(receipt.pointsBalance || 0)}`));
  if(receipt.issuedVoucher){
    const voucher=receipt.issuedVoucher;
    bytes.push(...lineBytes(separator),ESC,0x61,0x01,ESC,0x45,0x01,...lineBytes('VOUCHER BELANJA BERIKUTNYA'),ESC,0x45,0x00);
    bytes.push(...lineBytes(voucher.discountType==='PERCENT'?`Diskon ${Number(voucher.discountValue)}%`:`Potongan ${rupiah(voucher.discountValue)}`));
    bytes.push(...qrBytes(voucher.code),LF,...lineBytes(voucher.code));
    for(const row of wrap(`Min. belanja ${rupiah(voucher.minPurchase)} | ${new Date(voucher.startsAt).toLocaleDateString('id-ID')} - ${new Date(voucher.endsAt).toLocaleDateString('id-ID')}`,width))bytes.push(...lineBytes(row));
    bytes.push(...lineBytes('Scan saat transaksi berikutnya'),...lineBytes('Hanya 1 kali pakai'),ESC,0x61,0x00);
  }
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

export const LABEL_DOTS_PER_MM=8;

export function productLabelPrinterWidthDots(paperWidth=58){
  return Number(paperWidth)===80?576:Number(paperWidth)===58?384:0;
}

export function productLabelRasterPlacement(labelWidthDots,paperWidth){
  const printerWidth=productLabelPrinterWidthDots(paperWidth);
  const labelWidth=Math.max(0,Number(labelWidthDots)||0);
  const rasterWidth=Math.max(labelWidth,printerWidth);
  return {rasterWidth,startX:Math.max(0,Math.floor((rasterWidth-labelWidth)/2))};
}

export function productLabelRasterLayout(label,config={}){
  const widthMm=Math.max(10,Math.min(200,Number(config.width)||33));
  const heightMm=Math.max(10,Math.min(200,Number(config.height)||15));
  const widthDots=Math.max(80,Math.round(widthMm*LABEL_DOTS_PER_MM));
  const heightDots=Math.max(80,Math.round(heightMm*LABEL_DOTS_PER_MM));
  const configuredMarginX=Number(config.marginX),configuredMarginY=Number(config.marginY);
  const marginX=Math.max(0,Math.min(widthMm/3,Number.isFinite(configuredMarginX)?configuredMarginX:.5));
  const marginY=Math.max(0,Math.min(heightMm/3,Number.isFinite(configuredMarginY)?configuredMarginY:.25));
  const contentLeft=Math.round(marginX*LABEL_DOTS_PER_MM);
  const contentTop=Math.round(marginY*LABEL_DOTS_PER_MM);
  const contentWidth=Math.max(8,widthDots-contentLeft*2);
  const contentHeight=Math.max(8,heightDots-contentTop*2);
  const bits=barcodeRasterBits(label.barcode,config.type||'AUTO');
  const requestedModuleDots=Math.max(1,Math.round((Number(config.moduleWidth)||.26)*LABEL_DOTS_PER_MM));
  const moduleDots=Math.min(requestedModuleDots,Math.floor(contentWidth/bits.length));
  if(moduleDots<2)throw new Error(`Barcode ${label.barcode} terlalu padat untuk label ${widthMm} mm. Perpendek kode atau lebarkan label.`);
  const barcodeWidth=bits.length*moduleDots;
  const barcodeHeight=Math.max(24,Math.min(contentHeight-8,Math.round((Number(config.barcodeHeight)||4.8)*LABEL_DOTS_PER_MM)));
  return {widthMm,heightMm,widthDots,heightDots,contentLeft,contentTop,contentWidth,contentHeight,bits,moduleDots,barcodeWidth,barcodeHeight};
}

function fittedFont(context,text,{family='sans-serif',weight='700',size,maxWidth}){
  let pixels=Math.max(7,Math.round(size));
  while(pixels>7){
    context.font=`${weight} ${pixels}px ${family}`;
    if(context.measureText(text).width<=maxWidth)break;
    pixels-=1;
  }
  return {font:`${weight} ${pixels}px ${family}`,height:Math.ceil(pixels*1.15)};
}

function rasterCommand(canvas,config={}){
  const context=canvas.getContext('2d',{willReadFrequently:true});
  const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
  const {rasterWidth,startX}=productLabelRasterPlacement(canvas.width,config.paperWidth);
  const bytesPerRow=Math.ceil(rasterWidth/8);
  const raster=new Uint8Array(bytesPerRow*canvas.height);
  for(let y=0;y<canvas.height;y+=1)for(let x=0;x<canvas.width;x+=1){
    const index=(y*canvas.width+x)*4;
    const luminance=.299*pixels[index]+.587*pixels[index+1]+.114*pixels[index+2];
    const targetX=startX+x;
    if(pixels[index+3]>40&&luminance<180)raster[y*bytesPerRow+(targetX>>3)]|=0x80>>(targetX&7);
  }
  const feedDots=Math.max(0,Math.min(255,Math.round((Number(config.gap)||0)*LABEL_DOTS_PER_MM)));
  return new Uint8Array([
    ESC,0x40,ESC,0x61,0x00,
    GS,0x76,0x30,0x00,bytesPerRow&0xff,(bytesPerRow>>8)&0xff,canvas.height&0xff,(canvas.height>>8)&0xff,
    ...raster,
    ...(feedDots?[ESC,0x4a,feedDots]:[]),
    ESC,0x61,0x00
  ]);
}

export function renderEscPosProductLabelCanvas(label,config={}){
  if(typeof document==='undefined')throw new Error('Renderer label hanya tersedia pada perangkat cetak.');
  const layout=productLabelRasterLayout(label,config);
  const canvas=document.createElement('canvas');
  canvas.width=layout.widthDots;canvas.height=layout.heightDots;
  const context=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
  context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
  context.fillStyle='#000';context.textBaseline='top';
  const maxWidth=layout.contentWidth;
  const offsetX=Math.round(Math.max(-10,Math.min(10,Number(config.offsetX)||0))*LABEL_DOTS_PER_MM);
  const offsetY=Math.round(Math.max(-10,Math.min(10,Number(config.offsetY)||0))*LABEL_DOTS_PER_MM);
  const align=config.align==='left'?'left':config.align==='right'?'right':'center';
  const textX=(align==='left'
    ?layout.contentLeft
    :align==='right'
      ?layout.contentLeft+layout.contentWidth
      :layout.contentLeft+layout.contentWidth/2)+offsetX;
  context.textAlign=align;
  const name=String(label.name??'').trim(),price=String(label.priceText??'').trim();
  const code=[config.showSku?label.sku:'',config.showCode?label.barcode:''].filter(Boolean).join(' · ');
  const nameFont=fittedFont(context,name,{size:(Number(config.nameSize)||2)*LABEL_DOTS_PER_MM,maxWidth});
  const priceFont=fittedFont(context,price,{size:(Number(config.priceSize)||2.7)*LABEL_DOTS_PER_MM,maxWidth});
  const codeFont=fittedFont(context,code,{family:'monospace',weight:'400',size:(Number(config.codeSize)||1.55)*LABEL_DOTS_PER_MM,maxWidth});
  const textLines=[
    ...(config.showName&&name?[{text:name,...nameFont}]:[]),
    ...(config.showPrice&&price?[{text:price,...priceFont}]:[])
  ];
  const graphicLines=[
    {barcode:true,height:layout.barcodeHeight},
    ...(code?[{text:code,...codeFont}]:[])
  ];
  const ordered=config.position==='BELOW'?[...graphicLines,...textLines]:[...textLines,...graphicLines];
  const gap=2,totalHeight=ordered.reduce((sum,item)=>sum+item.height,0)+Math.max(0,ordered.length-1)*gap;
  if(totalHeight>layout.contentHeight)throw new Error(`Isi label melebihi tinggi ${layout.heightMm} mm. Kecilkan tulisan, barcode, atau margin.`);
  const vertical=config.verticalAlign==='BOTTOM'?'BOTTOM':config.verticalAlign==='CENTER'?'CENTER':'TOP';
  let y=(vertical==='BOTTOM'
    ?layout.contentTop+layout.contentHeight-totalHeight
    :vertical==='CENTER'
      ?layout.contentTop+Math.floor((layout.contentHeight-totalHeight)/2)
      :layout.contentTop)+offsetY;
  for(const item of ordered){
    if(item.barcode){
      const startX=Math.floor(layout.contentLeft+(layout.contentWidth-layout.barcodeWidth)/2)+offsetX;
      for(let index=0;index<layout.bits.length;index+=1)if(layout.bits[index]==='1'){
        context.fillRect(startX+index*layout.moduleDots,y,layout.moduleDots,item.height);
      }
    }else{
      context.font=item.font;
      context.fillText(item.text,textX,y,maxWidth);
    }
    y+=item.height+gap;
  }
  return canvas;
}

export function buildEscPosProductLabel(label,config={}){
  return rasterCommand(renderEscPosProductLabelCanvas(label,config),config);
}

export async function printEscPosProductLabels(labels,config={}){
  if(!Array.isArray(labels)||!labels.length)throw new Error('Tidak ada label yang akan dicetak.');
  for(const label of labels)await write(buildEscPosProductLabel(label,config));
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
