export const workbookTemplates={
  PRODUCTS:{
    file:'template-barang-kasir-nusa.xlsx',sheet:'Barang',
    headers:['no_barang_sku','nama_barang','kategori','merek','satuan_dasar','barcode_satuan_dasar','harga_umum','stok_awal','modal_per_satuan_dasar','nomor_batch','tanggal_exp','stok_minimum','pantau_exp'],
    examples:[['','Lip Tint Rose','Lip Tint','Nusa Beauty','pcs','899000000001',25000,24,15000,'BATCH-A1','2027-12-31',5,'YA']],
    guide:[['Kolom','Cara mengisi'],['no_barang_sku','Boleh kosong untuk barang baru; Kasir Nusa membuat nomor otomatis. Pertahankan saat mengedit barang hasil export.'],['satuan_dasar','Satuan acuan stok, misalnya pcs, botol, atau sachet. Ini bukan berarti barang wajib multi satuan.'],['barcode_satuan_dasar','Boleh kosong. Format sebagai teks agar angka nol di depan tidak hilang.'],['harga_umum','Harga jual umum per satuan dasar; wajib lebih dari 0.'],['stok_awal dan modal_per_satuan_dasar','Hanya untuk pembukaan barang baru. Barang lama memakai stok opname atau restok.'],['multi satuan, varian, dan harga pelanggan','Gunakan template terpisah setelah produk utama tersimpan.'],['ribuan barang','Unggah satu file; sistem memprosesnya dalam kelompok aman.']]},
  PRODUCT_UNITS:{
    file:'template-satuan-barang-kasir-nusa.xlsx',sheet:'Satuan Barang',
    headers:['no_barang_sku','nama_satuan','isi_dalam_satuan_dasar','barcode'],
    examples:[['KOS-001','pcs',1,'899000000001'],['KOS-001','pak',6,'899000000006'],['KOS-001','lusin',12,'899000000012'],['KOS-001','dus',144,'899000000144']],
    guide:[['Kolom','Cara mengisi'],['no_barang_sku','Produk harus sudah dibuat melalui file Barang.'],['satu baris per satuan','Satu SKU boleh muncul sebanyak jumlah satuannya; tidak dibatasi dua satuan.'],['isi_dalam_satuan_dasar','Satuan dasar selalu 1. Contoh pak isi 6, lusin isi 12, dus isi 144.'],['barcode','Boleh kosong. Jika setiap satuan punya barcode, scan langsung memilih satuan tersebut.'],['aman saat edit','Satuan yang tidak ada dalam file tidak dihapus otomatis.']]},
  PRODUCT_VARIANTS:{
    file:'template-varian-barang-kasir-nusa.xlsx',sheet:'Varian Barang',
    headers:['no_barang_sku','kelompok_varian','nama_varian'],
    examples:[['LIP-RED','Lip Tint Velvet','Merah'],['LIP-PINK','Lip Tint Velvet','Pink'],['LIP-NUDE','Lip Tint Velvet','Nude']],
    guide:[['Kolom','Cara mengisi'],['no_barang_sku','Setiap varian adalah produk/SKU tersendiri agar barcode, stok, modal, dan harga dapat berbeda.'],['kelompok_varian','Nama produk induk yang menyatukan beberapa SKU.'],['nama_varian','Pembeda yang dilihat kasir, misalnya warna, ukuran, atau aroma.'],['urutan kerja','Buat seluruh SKU melalui file Barang, lalu impor file Varian Barang.']]},
  PRODUCT_PRICES:{
    file:'template-harga-pelanggan-kasir-nusa.xlsx',sheet:'Harga Pelanggan',
    headers:['no_barang_sku','tipe_pelanggan','minimal_pembelian','harga_per_satuan_dasar'],
    examples:[['KOS-001','Member',1,24500],['KOS-001','Grosir',1,24500],['KOS-001','Grosir',3,24000]],
    guide:[['Kolom','Cara mengisi'],['no_barang_sku','Produk harus sudah dibuat.'],['tipe_pelanggan','Gunakan nama atau kode tipe pelanggan yang sudah aktif, misalnya Member atau Grosir.'],['minimal_pembelian','Jumlah dalam satuan dasar. Satu tipe pelanggan boleh memiliki banyak tingkatan.'],['harga_per_satuan_dasar','Harga jual untuk satu satuan dasar, bukan total baris.'],['Harga Umum','Tetap dikelola pada file Barang. File ini khusus tipe pelanggan selain Umum.'],['harga otomatis','Harga manual dari file ini dipertahankan dan tidak ditimpa aturan harga aman otomatis pada tingkat yang sama.']]},
  CUSTOMERS:{file:'template-pelanggan-kasir-nusa.xlsx',sheet:'Pelanggan',headers:['kode','nama','telepon','kelompok'],examples:[['PLG-0002','Toko Cantik','081234567890','eceran']],guide:[['Kolom','Cara mengisi'],['kode','Kode pelanggan wajib unik.'],['kelompok','Isi tipe pelanggan yang sudah aktif.']]},
  SUPPLIERS:{file:'template-supplier-kasir-nusa.xlsx',sheet:'Supplier',headers:['kode','nama','telepon','alamat'],examples:[['SUP-001','Distributor Kosmetik Nusantara','081234567890','Makassar']],guide:[['Kolom','Cara mengisi'],['kode','Kode supplier wajib unik.'],['nama','Nama supplier wajib diisi.']]}
};

function columnName(index){
  let value=index+1,name='';
  while(value){value-=1;name=String.fromCharCode(65+(value%26))+name;value=Math.floor(value/26);}
  return name;
}

function setColumns(sheet,headers){
  sheet['!cols']=headers.map((header)=>({wch:Math.max(13,Math.min(30,header.length+4))}));
  sheet['!autofilter']={ref:`A1:${columnName(headers.length-1)}1`};
}

export function createTemplateWorkbook(XLSX,kind){
  const template=workbookTemplates[kind];if(!template)throw new Error('Jenis template tidak dikenal');
  const workbook=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([template.headers,...template.examples]);
  setColumns(sheet,template.headers);XLSX.utils.book_append_sheet(workbook,sheet,template.sheet);
  const guide=XLSX.utils.aoa_to_sheet(template.guide);guide['!cols']=[{wch:32},{wch:96}];
  XLSX.utils.book_append_sheet(workbook,guide,'Panduan');return workbook;
}

export function workbookMatrix(XLSX,arrayBuffer,kind){
  const workbook=XLSX.read(arrayBuffer,{type:'array',cellDates:true}),expected=workbookTemplates[kind]?.sheet;
  const sheetName=workbook.SheetNames.find((name)=>name===expected)??workbook.SheetNames.find((name)=>name.toLowerCase()!=='panduan');
  if(!sheetName)throw new Error('File Excel tidak memiliki sheet data');
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName],{header:1,defval:'',raw:false,dateNF:'yyyy-mm-dd'});
}

function retailPrice(product){return Number(product.priceRules?.find((rule)=>rule.customerGroupId==='retail'&&Number(rule.minBaseQty)===1)?.unitPriceBase??0);}
function filteredProducts(products,filters={}){return products.filter((product)=>(!filters.category||product.category===filters.category)&&(!filters.brand||product.brand===filters.brand)&&(filters.status==='ALL'||!filters.status||(filters.status==='ACTIVE'?product.active:!product.active)));}
const compare=(a,b)=>String(a??'').localeCompare(String(b??''),'id',{numeric:true,sensitivity:'base'});

export function productExportRows(products,filters={}){
  const rows=filteredProducts(products,filters).map((product)=>{
    const units=[...(product.units??[])].sort((a,b)=>Number(a.factor)-Number(b.factor));
    const base=units.find((unit)=>Number(unit.factor)===1)??units[0]??{};
    return {no_barang_sku:product.sku,nama_barang:product.name,kategori:product.category,merek:product.brand??'',satuan_dasar:base.name??'pcs',barcode_satuan_dasar:base.barcode??'',harga_umum:retailPrice(product),stok_awal:'',modal_per_satuan_dasar:'',nomor_batch:'',tanggal_exp:'',stok_minimum:Number(product.minimumStock??0),pantau_exp:product.trackExpiry?'YA':'TIDAK',stok_saat_ini:Number(product.stockBase??0),status_produk:product.active?'AKTIF':'NONAKTIF'};
  });
  const sorters={SKU_ASC:(a,b)=>compare(a.no_barang_sku,b.no_barang_sku),SKU_DESC:(a,b)=>compare(b.no_barang_sku,a.no_barang_sku),NAME_ASC:(a,b)=>compare(a.nama_barang,b.nama_barang),BARCODE_ASC:(a,b)=>compare(a.barcode_satuan_dasar,b.barcode_satuan_dasar),STOCK_ASC:(a,b)=>a.stok_saat_ini-b.stok_saat_ini,STOCK_DESC:(a,b)=>b.stok_saat_ini-a.stok_saat_ini};
  return rows.sort(sorters[filters.sort]??sorters.SKU_ASC);
}

export function productExtensionExportRows(products,kind,filters={}){
  const selected=filteredProducts(products,filters);
  if(kind==='PRODUCT_UNITS')return selected.flatMap((product)=>(product.units??[]).map((unit)=>({no_barang_sku:product.sku,nama_satuan:unit.name,isi_dalam_satuan_dasar:Number(unit.factor),barcode:unit.barcode??''}))).sort((a,b)=>compare(a.no_barang_sku,b.no_barang_sku)||a.isi_dalam_satuan_dasar-b.isi_dalam_satuan_dasar);
  if(kind==='PRODUCT_VARIANTS')return selected.filter((product)=>product.variantGroup||product.variantName).map((product)=>({no_barang_sku:product.sku,kelompok_varian:product.variantGroup??'',nama_varian:product.variantName??''})).sort((a,b)=>compare(a.kelompok_varian,b.kelompok_varian)||compare(a.nama_varian,b.nama_varian));
  if(kind==='PRODUCT_PRICES')return selected.flatMap((product)=>(product.priceRules??[]).filter((rule)=>rule.customerGroupId&&rule.customerGroupId!=='retail').map((rule)=>({no_barang_sku:product.sku,tipe_pelanggan:rule.customerGroupId,minimal_pembelian:Number(rule.minBaseQty),harga_per_satuan_dasar:Number(rule.unitPriceBase)}))).sort((a,b)=>compare(a.no_barang_sku,b.no_barang_sku)||compare(a.tipe_pelanggan,b.tipe_pelanggan)||a.minimal_pembelian-b.minimal_pembelian);
  throw new Error('Jenis export produk tidak dikenal');
}

export function createProductExportWorkbook(XLSX,products,filters={},kind='PRODUCTS'){
  const template=workbookTemplates[kind];if(!template)throw new Error('Jenis export produk tidak dikenal');
  const rows=kind==='PRODUCTS'?productExportRows(products,filters):productExtensionExportRows(products,kind,filters);
  const headers=kind==='PRODUCTS'?[...template.headers,'stok_saat_ini','status_produk']:template.headers;
  const workbook=XLSX.utils.book_new(),sheet=XLSX.utils.json_to_sheet(rows,{header:headers});
  setColumns(sheet,headers);XLSX.utils.book_append_sheet(workbook,sheet,template.sheet);
  const guide=XLSX.utils.aoa_to_sheet(template.guide);guide['!cols']=[{wch:32},{wch:96}];XLSX.utils.book_append_sheet(workbook,guide,'Panduan');
  return {workbook,count:rows.length};
}
