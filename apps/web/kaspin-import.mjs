const REQUIRED_HEADERS=[
  'kode_barang_edit','nama_barang_edit','barang_jasa_edit','show_toko_edit',
  'harga_jual_edit','harga_beli_edit','minimum_stok','stok_edit',
  'berat_dan_satuan','kategori','tipe_barang'
];
const EXTENSION_HEADERS={
  PRODUCT_UNITS:['kode_barang','nama_barang','tipe_satuan','harga','jumlah_per_satuan','satuan_terkecil'],
  PRODUCT_VARIANTS:['kode_barang','nama_barang','label','variasi','harga_beli','harga_jual','kode','stok'],
  PRODUCT_PRICES:['nama_barang','kode_barang','nama','jumlah_minimal','harga_satuan','terintegrasi_tipe_pelanggan']
};

function text(value){
  if(value===null||value===undefined)return '';
  if(typeof value==='number'&&Number.isInteger(value))return value.toFixed(0);
  return String(value).trim();
}

function identifier(value){
  const source=text(value);
  if(!source)return '';
  if(typeof value==='number'&&Number.isSafeInteger(value))return value.toFixed(0);
  if(/^\d+(?:\.\d+)?e\+\d+$/i.test(source)){
    const parsed=Number(source);
    if(Number.isSafeInteger(parsed))return parsed.toFixed(0);
  }
  return source;
}

export function kaspinInternalSku(value){
  const legacy=identifier(value);
  if(!legacy)return '';
  const safe=legacy.toUpperCase().normalize('NFKD').replace(/[^A-Z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  return safe?`KP-${safe}`:'';
}

function mappedKaspinSku(value,useInternalSku){
  const legacy=identifier(value);
  return useInternalSku?kaspinInternalSku(legacy):legacy;
}

function shortStableHash(value){
  let hash=2166136261;
  for(const character of text(value).toLocaleLowerCase('id')){hash^=character.codePointAt(0);hash=Math.imul(hash,16777619);}
  return (hash>>>0).toString(16).toUpperCase().padStart(8,'0');
}

function kaspinFamilyCode(value){
  const name=text(value),slug=name.toUpperCase().normalize('NFKD').replace(/[^A-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,30)||'ETALASE';
  return `KP-${slug}-${shortStableHash(name)}`;
}

function number(value){
  if(value===''||value===null||value===undefined)return null;
  const parsed=Number(value);
  return Number.isFinite(parsed)?parsed:NaN;
}

function isoDateTime(value){
  if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toISOString();
  const source=text(value);
  if(!source)return '';
  const match=source.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if(match){
    const [,day,month,year,hour='0',minute='0',second='0']=match;
    const parsed=new Date(Number(year),Number(month)-1,Number(day),Number(hour),Number(minute),Number(second));
    if(!Number.isNaN(parsed.getTime()))return parsed.toISOString();
  }
  const parsed=new Date(source);
  return Number.isNaN(parsed.getTime())?'':parsed.toISOString();
}

function normalizedHeader(value){
  return text(value).toLowerCase().replace(/\s+/g,'_');
}

function findKaspinSheet(XLSX,workbook){
  for(const sheetName of workbook.SheetNames){
    const sheet=workbook.Sheets[sheetName];
    const matrix=XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:''});
    const headers=(matrix[0]??[]).map(normalizedHeader);
    if(REQUIRED_HEADERS.every((header)=>headers.includes(header)))return {sheetName,matrix,headers};
  }
  return null;
}

function findExtensionSheet(XLSX,workbook,kind){
  const required=EXTENSION_HEADERS[kind];
  if(!required)return null;
  for(const sheetName of workbook.SheetNames){
    const sheet=workbook.Sheets[sheetName];
    const matrix=XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:''});
    const headers=(matrix[0]??[]).map(normalizedHeader);
    if(required.every((header)=>headers.includes(header)))return {sheetName,matrix,headers};
  }
  return null;
}

function baseUnit(value){
  const source=text(value);
  return /^[a-zA-Z]{1,12}$/.test(source)?source:'pcs';
}

export function parseKaspinProductWorkbook(XLSX,arrayBuffer,{useCodeAsBarcode=true,useInternalSku=true}={}){
  const workbook=XLSX.read(arrayBuffer,{type:'array',cellDates:true});
  const source=findKaspinSheet(XLSX,workbook);
  if(!source)return null;
  const indexes=Object.fromEntries(source.headers.map((header,index)=>[header,index]));
  const get=(row,key)=>row[indexes[key]]??'';
  const rows=[],issues=[],deferred=[],types={},serviceRows=[];
  source.matrix.slice(2).forEach((cells,index)=>{
    if(!cells.some((value)=>text(value)!==''))return;
    const excelRow=index+3;
    const legacyCode=identifier(get(cells,'kode_barang_edit'));
    const sku=mappedKaspinSku(legacyCode,useInternalSku);
    const name=text(get(cells,'nama_barang_edit'));
    const retailPrice=number(get(cells,'harga_jual_edit'));
    const openingQty=number(get(cells,'stok_edit'));
    const openingCost=number(get(cells,'harga_beli_edit'));
    const productType=text(get(cells,'tipe_barang'))||'Default';
    types[productType]=(types[productType]??0)+1;
    if(text(get(cells,'barang_jasa_edit'))==='1')serviceRows.push(excelRow);
    if(!(retailPrice>0)&&productType.toLowerCase()!=='default'){
      deferred.push({row:excelRow,sku,name,productType,message:`induk ${productType}; gunakan file detail tipe produk`});
      return;
    }
    const reasons=[];
    if(!sku)reasons.push('kode barang kosong');
    if(!name)reasons.push('nama barang kosong');
    if(!(retailPrice>0))reasons.push('harga jual harus lebih dari nol');
    if(!(openingQty>=0))reasons.push('stok tidak valid');
    if(openingQty>0&&!(openingCost>=0))reasons.push('modal tidak valid');
    if(reasons.length){
      issues.push({row:excelRow,sku,name,message:reasons.join(', ')});
      return;
    }
    rows.push({
      sku,name,legacyCode,
      category:text(get(cells,'kategori'))||'Lainnya',
      brand:'',
      baseUnit:baseUnit(get(cells,'berat_dan_satuan')),
      baseBarcode:useCodeAsBarcode?legacyCode:'',
      retailPrice,
      openingQty,
      openingCost:openingCost??0,
      batchNo:'SALDO-AWAL-KASPIN',
      expiresOn:'',
      minimumStock:Math.max(0,number(get(cells,'minimum_stok'))??0),
      trackExpiry:false
    });
  });
  const sharedBarcodeCandidates=[];
  if(useCodeAsBarcode&&useInternalSku){
    const byBarcode=new Map();
    rows.forEach((row)=>{if(row.baseBarcode){if(!byBarcode.has(row.baseBarcode))byBarcode.set(row.baseBarcode,[]);byBarcode.get(row.baseBarcode).push(row);}});
    byBarcode.forEach((members,barcode)=>{
      if(members.length<2)return;
      members.forEach((row)=>{row.sku=`${kaspinInternalSku(barcode)}-${shortStableHash(row.name)}`;row.baseBarcode='';});
      sharedBarcodeCandidates.push({barcode,count:members.length,products:members.map((row)=>({sku:row.sku,name:row.name}))});
    });
  }
  const detailedTypeRows=Object.entries(types).filter(([type])=>type.toLowerCase()!=='default').reduce((sum,[,count])=>sum+count,0);
  return {
    rows,
    report:{
      source:'KASPIN',sheetName:source.sheetName,total:rows.length+issues.length+deferred.length,
      mapped:rows.length,skipped:issues.length,deferred:deferred.length,issues,deferredRows:deferred,types,
      detailedTypeRows,serviceRows:serviceRows.length,useCodeAsBarcode,useInternalSku,sharedBarcodeCandidates
    }
  };
}

export function parseKaspinProductExtensionWorkbook(XLSX,arrayBuffer,kind,{useInternalSku=true}={}){
  const workbook=XLSX.read(arrayBuffer,{type:'array',cellDates:true});
  const source=findExtensionSheet(XLSX,workbook,kind);
  if(!source)return null;
  const indexes=Object.fromEntries(source.headers.map((header,index)=>[header,index]));
  const get=(row,key)=>row[indexes[key]]??'';
  const rows=[],issues=[],skippedRows=[];
  source.matrix.slice(1).forEach((cells,index)=>{
    if(!cells.some((value)=>text(value)!==''))return;
    const excelRow=index+2;
    const sku=mappedKaspinSku(get(cells,'kode_barang'),useInternalSku);
    if(kind==='PRODUCT_UNITS'){
      const unitName=text(get(cells,'tipe_satuan'));
      const factor=number(get(cells,'jumlah_per_satuan'));
      const unitPriceTotal=number(get(cells,'harga'));
      const reasons=[];
      if(!sku)reasons.push('kode barang kosong');
      if(!unitName)reasons.push('nama satuan kosong');
      if(!(factor>0))reasons.push('jumlah per satuan tidak valid');
      if(!(unitPriceTotal>0))reasons.push('harga satuan tidak valid');
      if(reasons.length){issues.push({row:excelRow,sku,message:reasons.join(', ')});return;}
      rows.push({sku,unitName,factor,barcode:'',unitPriceTotal});
      return;
    }
    if(kind==='PRODUCT_PRICES'){
      const integrated=text(get(cells,'terintegrasi_tipe_pelanggan')).toLowerCase();
      if(!['ya','yes','1'].includes(integrated)){
        skippedRows.push({row:excelRow,sku,message:'tingkat harga tidak terintegrasi tipe pelanggan'});
        return;
      }
      const customerGroup=text(get(cells,'nama'));
      const minQty=number(get(cells,'jumlah_minimal'));
      const unitPrice=number(get(cells,'harga_satuan'));
      const reasons=[];
      if(!sku)reasons.push('kode barang kosong');
      if(!customerGroup)reasons.push('tipe pelanggan kosong');
      if(!(minQty>0))reasons.push('minimal pembelian tidak valid');
      if(!(unitPrice>0))reasons.push('harga satuan tidak valid');
      if(reasons.length){issues.push({row:excelRow,sku,message:reasons.join(', ')});return;}
      rows.push({sku,customerGroup,minQty,unitPrice});
      return;
    }
    const childSku=mappedKaspinSku(get(cells,'kode'),useInternalSku);
    const variantGroup=text(get(cells,'nama_barang'));
    const parts=[
      [text(get(cells,'label')),text(get(cells,'variasi'))],
      [text(get(cells,'label_2')),text(get(cells,'variasi_2'))]
    ].filter(([,value])=>value).map(([label,value])=>label?`${label}: ${value}`:value);
    if(!childSku&&!variantGroup&&!parts.length)return;
    const reasons=[];
    if(!childSku)reasons.push('kode varian kosong');
    if(!variantGroup)reasons.push('nama induk varian kosong');
    if(!parts.length)reasons.push('nama variasi kosong');
    if(reasons.length){issues.push({row:excelRow,sku:childSku,message:reasons.join(', ')});return;}
    rows.push({sku:childSku,familyCode:kaspinFamilyCode(variantGroup),variantGroup,variantName:parts.join(' · ')});
  });
  const labels={PRODUCT_UNITS:'Multi Satuan',PRODUCT_VARIANTS:'Varian',PRODUCT_PRICES:'Harga Grosir'};
  return {
    rows,
    report:{
      source:'KASPIN',sheetName:source.sheetName,fileType:labels[kind],total:rows.length+issues.length+skippedRows.length,
      mapped:rows.length,skipped:issues.length+skippedRows.length,issues:[...issues,...skippedRows],
      ignored:skippedRows.length,useInternalSku
    }
  };
}

export function parseKaspinCustomerWorkbook(XLSX,arrayBuffer){
  const workbook=XLSX.read(arrayBuffer,{type:'array',cellDates:true});
  const source=sheetWithHeaders(XLSX,workbook,[
    'email_customer_edit','nama_lengkap_customer_edit','no_hp','kode','tipe_pelanggan','point'
  ]);
  if(!source)return null;
  const indexes=Object.fromEntries(source.headers.map((header,index)=>[header,index]));
  const get=(row,key)=>row[indexes[key]]??'';
  const rows=[],issues=[],types={};
  source.matrix.slice(2).forEach((cells,index)=>{
    if(!cells.some((value)=>text(value)!==''))return;
    const rowNo=index+3,name=text(get(cells,'nama_lengkap_customer_edit'));
    const email=text(get(cells,'email_customer_edit')).toLowerCase();
    const phone=identifier(get(cells,'no_hp')).replace(/\D/g,'');
    const explicitCode=identifier(get(cells,'kode')).replace(/\s+/g,'');
    const code=explicitCode||(`KSP-${phone||email.replace(/[^a-z0-9]/gi,'').slice(0,40)}`);
    const groupId=text(get(cells,'tipe_pelanggan'))||'Umum';
    const loyaltyPoints=Math.max(0,Math.floor(number(get(cells,'point'))??0));
    const reasons=[];
    if(!name)reasons.push('nama pelanggan kosong');
    if(!phone&&!email)reasons.push('nomor telepon dan email kosong');
    if(!code||code==='KSP-')reasons.push('kode pelanggan tidak dapat dibuat');
    if(reasons.length){issues.push({row:rowNo,message:reasons.join(', ')});return;}
    types[groupId]=(types[groupId]??0)+1;
    rows.push({
      code:code.toUpperCase(),name,phone,email,
      address:text(get(cells,'alamat')),groupId,loyaltyPoints
    });
  });
  return {
    rows,
    report:{
      source:'KASPIN',fileType:'Pelanggan',sheetName:source.sheetName,
      total:rows.length+issues.length,mapped:rows.length,skipped:issues.length,issues,types
    }
  };
}

export function parseKaspinSupplierWorkbook(XLSX,arrayBuffer){
  const workbook=XLSX.read(arrayBuffer,{type:'array',cellDates:true});
  let source=null;
  for(const sheetName of workbook.SheetNames){
    const matrix=XLSX.utils.sheet_to_json(workbook.Sheets[sheetName],{header:1,raw:true,defval:''});
    const headerIndex=matrix.findIndex((row)=>{
      const headers=row.map(normalizedHeader);
      return headers.some((item)=>['nama_supplier_edit','nama_supplier','nama_suplier_edit','nama_suplier','nama'].includes(item))&&headers.some((item)=>['kode_supplier_edit','kode_supplier','kode_suplier_edit','kode_suplier','kode','no_hp','telepon'].includes(item));
    });
    if(headerIndex>=0){source={sheetName,matrix,headerIndex,headers:matrix[headerIndex].map(normalizedHeader)};break;}
  }
  if(!source)return null;
  const indexOf=(...names)=>names.map((name)=>source.headers.indexOf(name)).find((index)=>index>=0)??-1;
  const indexes={
    code:indexOf('kode_supplier_edit','kode_supplier','kode_suplier_edit','kode_suplier','kode'),name:indexOf('nama_supplier_edit','nama_supplier','nama_suplier_edit','nama_suplier','nama'),
    phone:indexOf('no_hp','nomor_telepon','telepon'),address:indexOf('alamat_supplier_edit','alamat_supplier','alamat_suplier_edit','alamat_suplier','alamat')
  };
  const rows=[],issues=[];
  source.matrix.slice(source.headerIndex+1).forEach((cells,index)=>{
    if(!cells.some((value)=>text(value)!==''))return;
    if(cells.some((value)=>/petunjuk|jangan diubah/i.test(text(value))))return;
    const rowNo=source.headerIndex+index+2,name=text(cells[indexes.name]);
    const phone=indexes.phone>=0?identifier(cells[indexes.phone]).replace(/\D/g,''):'';
    const explicitCode=indexes.code>=0?identifier(cells[indexes.code]).replace(/\s+/g,''):'';
    const code=(explicitCode||`KSP-SUP-${phone||shortStableHash(name)}`).toUpperCase();
    if(!name){issues.push({row:rowNo,message:'nama supplier kosong'});return;}
    rows.push({code,name,phone,address:indexes.address>=0?text(cells[indexes.address]):''});
  });
  return {rows,report:{source:'KASPIN',fileType:'Supplier',sheetName:source.sheetName,total:rows.length+issues.length,mapped:rows.length,skipped:issues.length,issues}};
}

function sheetWithHeaders(XLSX,workbook,required){
  for(const sheetName of workbook.SheetNames){
    const matrix=XLSX.utils.sheet_to_json(workbook.Sheets[sheetName],{header:1,raw:true,defval:''});
    const headers=(matrix[0]??[]).map(normalizedHeader);
    if(required.every((header)=>headers.includes(header)))return {sheetName,matrix,headers};
  }
  return null;
}

export function parseKaspinFifoWorkbooks(XLSX,purchaseBuffer,capitalBuffer){
  const purchaseBook=XLSX.read(purchaseBuffer,{type:'array',cellDates:true});
  const capitalBook=XLSX.read(capitalBuffer,{type:'array',cellDates:true});
  const itemSheet=sheetWithHeaders(XLSX,purchaseBook,['kode_transaksi','timestamp','kode_barang','nama_barang','jumlah','harga_beli']);
  const receiptSheet=sheetWithHeaders(XLSX,purchaseBook,['kode_transaksi','waktu','nama_suplier']);
  const capitalSheet=sheetWithHeaders(XLSX,capitalBook,['kode','nama','stok','sisa_modal']);
  if(!itemSheet||!capitalSheet)return null;

  const indexes=(sheet)=>Object.fromEntries(sheet.headers.map((header,index)=>[header,index]));
  const itemIndexes=indexes(itemSheet),receiptIndexes=receiptSheet?indexes(receiptSheet):{};
  const capitalIndexes=indexes(capitalSheet);
  const get=(row,map,key)=>row[map[key]]??'';
  const receipts=new Map();
  if(receiptSheet)receiptSheet.matrix.slice(1).forEach((cells)=>{
    const transactionCode=identifier(get(cells,receiptIndexes,'kode_transaksi'));
    if(transactionCode)receipts.set(transactionCode,{
      supplierName:text(get(cells,receiptIndexes,'nama_suplier'))||'Supplier Kaspin',
      occurredAt:isoDateTime(get(cells,receiptIndexes,'waktu'))
    });
  });

  const rows=[],capitalRows=[],issues=[];
  itemSheet.matrix.slice(1).forEach((cells,index)=>{
    if(!cells.some((value)=>text(value)!==''))return;
    const rowNo=index+2,transactionCode=identifier(get(cells,itemIndexes,'kode_transaksi'));
    const productCode=identifier(get(cells,itemIndexes,'kode_barang'));
    const quantity=number(get(cells,itemIndexes,'jumlah'));
    const listedUnitCost=number(get(cells,itemIndexes,'harga_beli'));
    const lineTotal=number(get(cells,itemIndexes,'total'));
    const unitCost=quantity>0&&lineTotal>=0?lineTotal/quantity:listedUnitCost;
    const receipt=receipts.get(transactionCode);
    const occurredAt=isoDateTime(get(cells,itemIndexes,'timestamp'))||receipt?.occurredAt;
    const reasons=[];
    if(!transactionCode)reasons.push('kode transaksi kosong');
    if(!productCode)reasons.push('kode barang kosong');
    if(!(quantity>0))reasons.push('jumlah harus lebih dari nol');
    if(!(unitCost>=0))reasons.push('harga beli tidak valid');
    if(!occurredAt)reasons.push('tanggal transaksi tidak terbaca');
    if(reasons.length){issues.push({row:rowNo,message:reasons.join(', ')});return;}
    rows.push({
      transactionCode,occurredAt,productCode,
      productName:text(get(cells,itemIndexes,'nama_barang')),
      quantity,unitCost,
      supplierName:receipt?.supplierName??'Supplier Kaspin',
      cashier:text(get(cells,itemIndexes,'kasir')),
      paymentType:text(get(cells,itemIndexes,'tipe_pembayaran')),
      paymentMethod:text(get(cells,itemIndexes,'metode_pembayaran'))
    });
  });
  capitalSheet.matrix.slice(1).forEach((cells,index)=>{
    if(!cells.some((value)=>text(value)!==''))return;
    const rowNo=index+2,productCode=identifier(get(cells,capitalIndexes,'kode'));
    const stock=number(get(cells,capitalIndexes,'stok')),remainingCapital=number(get(cells,capitalIndexes,'sisa_modal'));
    if(!productCode||!(stock>=0)||!(remainingCapital>=0)){
      issues.push({row:rowNo,message:'kode, stok, atau sisa modal tidak valid',source:'modal'});return;
    }
    capitalRows.push({
      productCode,productName:text(get(cells,capitalIndexes,'nama')),
      stock,remainingCapital
    });
  });
  return {
    rows,capitalRows,
    report:{
      source:'KASPIN',fileType:'Pembelian & Modal FIFO',
      sheetName:`${itemSheet.sheetName} + ${capitalSheet.sheetName}`,
      total:rows.length+capitalRows.length+issues.length,mapped:rows.length+capitalRows.length,
      purchaseLines:rows.length,capitalLines:capitalRows.length,
      receipts:new Set(rows.map((row)=>row.transactionCode)).size,
      skipped:issues.length,issues
    }
  };
}

export function parseKaspinSalesWorkbooks(XLSX,detailBuffer,transactionBuffer){
  const detailBook=XLSX.read(detailBuffer,{type:'array',cellDates:true});
  const transactionBook=XLSX.read(transactionBuffer,{type:'array',cellDates:true});
  const detailSheet=sheetWithHeaders(XLSX,detailBook,[
    'kode_transaksi','timestamp','kode_barang','nama_barang','jumlah','harga_beli','harga_jual','total'
  ]);
  const transactionSheet=sheetWithHeaders(XLSX,transactionBook,[
    'kode_transaksi','waktu','total_pendapatan','keuntungan','bayar','uang_kembalian'
  ]);
  if(!detailSheet||!transactionSheet)return null;

  const indexes=(sheet)=>Object.fromEntries(sheet.headers.map((header,index)=>[header,index]));
  const detailIndexes=indexes(detailSheet),transactionIndexes=indexes(transactionSheet);
  const get=(row,map,key)=>row[map[key]]??'';
  const transactions=new Map();
  transactionSheet.matrix.slice(1).forEach((cells)=>{
    const transactionCode=identifier(get(cells,transactionIndexes,'kode_transaksi'));
    if(!transactionCode||transactionCode.toLowerCase()==='total semua')return;
    transactions.set(transactionCode,{
      occurredAt:isoDateTime(get(cells,transactionIndexes,'waktu')),
      grandTotal:number(get(cells,transactionIndexes,'total_pendapatan')),
      profit:number(get(cells,transactionIndexes,'keuntungan')),
      tendered:number(get(cells,transactionIndexes,'bayar')),
      change:number(get(cells,transactionIndexes,'uang_kembalian')),
      transactionDiscount:number(get(cells,transactionIndexes,'diskon'))??0,
      cashier:text(get(cells,transactionIndexes,'kasir')),
      paymentType:text(get(cells,transactionIndexes,'tipe_pembayaran')),
      paymentMethod:text(get(cells,transactionIndexes,'metode_pembayaran')),
      customerEmail:text(get(cells,transactionIndexes,'email_pelanggan')),
      customerName:text(get(cells,transactionIndexes,'nama_pelanggan')),
      note:text(get(cells,transactionIndexes,'keterangan'))
    });
  });

  const rows=[],issues=[],missingTransactions=new Set();
  detailSheet.matrix.slice(1).forEach((cells,index)=>{
    if(!cells.some((value)=>text(value)!==''))return;
    const rowNo=index+2,transactionCode=identifier(get(cells,detailIndexes,'kode_transaksi'));
    if(!transactionCode||transactionCode.toLowerCase()==='total semua')return;
    const summary=transactions.get(transactionCode);
    const productCode=identifier(get(cells,detailIndexes,'kode_barang'));
    const quantity=number(get(cells,detailIndexes,'jumlah'));
    const unitCost=number(get(cells,detailIndexes,'harga_beli'));
    const unitPrice=number(get(cells,detailIndexes,'harga_jual'));
    const lineGross=number(get(cells,detailIndexes,'total'));
    const occurredAt=isoDateTime(get(cells,detailIndexes,'timestamp'))||summary?.occurredAt;
    const reasons=[];
    if(!summary){reasons.push('kode transaksi tidak ditemukan pada Laporan Data Penjualan');missingTransactions.add(transactionCode);}
    if(!productCode)reasons.push('kode barang kosong');
    if(!(quantity>0))reasons.push('jumlah harus lebih dari nol');
    if(!(unitCost>=0))reasons.push('harga beli tidak valid');
    if(!(unitPrice>=0))reasons.push('harga jual tidak valid');
    if(!(lineGross>=0))reasons.push('total baris tidak valid');
    if(!occurredAt)reasons.push('tanggal transaksi tidak terbaca');
    if(reasons.length){issues.push({row:rowNo,message:reasons.join(', ')});return;}
    rows.push({
      transactionCode,occurredAt,productCode,
      productName:text(get(cells,detailIndexes,'nama_barang')),
      quantity,unitCost,unitPrice,lineGross,
      lineDiscount:number(get(cells,detailIndexes,'diskon'))??0,
      grandTotal:summary.grandTotal,profit:summary.profit,
      tendered:summary.tendered,change:summary.change,
      transactionDiscount:summary.transactionDiscount,
      cashier:summary.cashier||text(get(cells,detailIndexes,'kasir')),
      paymentType:summary.paymentType||text(get(cells,detailIndexes,'tipe_pembayaran')),
      paymentMethod:summary.paymentMethod||text(get(cells,detailIndexes,'metode_pembayaran')),
      customerEmail:summary.customerEmail,customerName:summary.customerName,note:summary.note
    });
  });
  return {
    rows,
    report:{
      source:'KASPIN',fileType:'Penjualan & detail struk',sheetName:`${detailSheet.sheetName} + ${transactionSheet.sheetName}`,
      total:rows.length+issues.length,mapped:rows.length,skipped:issues.length,issues,
      salesLines:rows.length,receipts:new Set(rows.map((row)=>row.transactionCode)).size,
      missingTransactions:missingTransactions.size
    }
  };
}
