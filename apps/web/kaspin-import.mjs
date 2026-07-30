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

export function parseKaspinProductWorkbook(XLSX,arrayBuffer,{useCodeAsBarcode=true}={}){
  const workbook=XLSX.read(arrayBuffer,{type:'array',cellDates:true});
  const source=findKaspinSheet(XLSX,workbook);
  if(!source)return null;
  const indexes=Object.fromEntries(source.headers.map((header,index)=>[header,index]));
  const get=(row,key)=>row[indexes[key]]??'';
  const rows=[],issues=[],deferred=[],types={},serviceRows=[];
  source.matrix.slice(2).forEach((cells,index)=>{
    if(!cells.some((value)=>text(value)!==''))return;
    const excelRow=index+3;
    const sku=identifier(get(cells,'kode_barang_edit'));
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
      sku,name,
      category:text(get(cells,'kategori'))||'Lainnya',
      brand:'',
      baseUnit:baseUnit(get(cells,'berat_dan_satuan')),
      baseBarcode:useCodeAsBarcode?sku:'',
      retailPrice,
      openingQty,
      openingCost:openingCost??0,
      batchNo:'SALDO-AWAL-KASPIN',
      expiresOn:'',
      minimumStock:Math.max(0,number(get(cells,'minimum_stok'))??0),
      trackExpiry:false
    });
  });
  const detailedTypeRows=Object.entries(types).filter(([type])=>type.toLowerCase()!=='default').reduce((sum,[,count])=>sum+count,0);
  return {
    rows,
    report:{
      source:'KASPIN',sheetName:source.sheetName,total:rows.length+issues.length+deferred.length,
      mapped:rows.length,skipped:issues.length,deferred:deferred.length,issues,deferredRows:deferred,types,
      detailedTypeRows,serviceRows:serviceRows.length,useCodeAsBarcode
    }
  };
}

export function parseKaspinProductExtensionWorkbook(XLSX,arrayBuffer,kind){
  const workbook=XLSX.read(arrayBuffer,{type:'array',cellDates:true});
  const source=findExtensionSheet(XLSX,workbook,kind);
  if(!source)return null;
  const indexes=Object.fromEntries(source.headers.map((header,index)=>[header,index]));
  const get=(row,key)=>row[indexes[key]]??'';
  const rows=[],issues=[],skippedRows=[];
  source.matrix.slice(1).forEach((cells,index)=>{
    if(!cells.some((value)=>text(value)!==''))return;
    const excelRow=index+2;
    const sku=identifier(get(cells,'kode_barang'));
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
    const childSku=identifier(get(cells,'kode'));
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
    rows.push({sku:childSku,variantGroup,variantName:parts.join(' · ')});
  });
  const labels={PRODUCT_UNITS:'Multi Satuan',PRODUCT_VARIANTS:'Varian',PRODUCT_PRICES:'Harga Grosir'};
  return {
    rows,
    report:{
      source:'KASPIN',sheetName:source.sheetName,fileType:labels[kind],total:rows.length+issues.length+skippedRows.length,
      mapped:rows.length,skipped:issues.length+skippedRows.length,issues:[...issues,...skippedRows],
      ignored:skippedRows.length
    }
  };
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
