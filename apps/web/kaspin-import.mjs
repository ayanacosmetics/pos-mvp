const REQUIRED_HEADERS=[
  'kode_barang_edit','nama_barang_edit','barang_jasa_edit','show_toko_edit',
  'harga_jual_edit','harga_beli_edit','minimum_stok','stok_edit',
  'berat_dan_satuan','kategori','tipe_barang'
];

function text(value){
  if(value===null||value===undefined)return '';
  if(typeof value==='number'&&Number.isInteger(value))return value.toFixed(0);
  return String(value).trim();
}

function number(value){
  if(value===''||value===null||value===undefined)return null;
  const parsed=Number(value);
  return Number.isFinite(parsed)?parsed:NaN;
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
    const sku=text(get(cells,'kode_barang_edit'));
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
