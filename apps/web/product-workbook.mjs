export const workbookTemplates={
  PRODUCTS:{
    file:'template-barang-kasir-nusa.xlsx',sheet:'Barang',
    headers:['no_barang_sku','nama_barang','kategori','merek','satuan_dasar','barcode_satuan_dasar','harga_umum','aturan_stok','stok_awal','modal_per_satuan_dasar','nomor_batch','tanggal_exp','stok_minimum','pantau_exp'],
    examples:[['','Lip Tint Rose','Lip Tint','Nusa Beauty','pcs','899000000001',25000,1,24,15000,'BATCH-A1','2027-12-31',5,'YA']],
    notes:[
      ['no_barang_sku','Opsional untuk baru / wajib saat edit','Nomor unik barang. Boleh kosong untuk produk baru agar dibuat otomatis; jangan diubah saat mengedit produk hasil export.','Teks; pertahankan nol di depan','KOS-001'],
      ['nama_barang','Wajib','Nama barang yang tampil di kasir dan struk.','Teks, maksimal 120 karakter','Lip Tint Rose'],
      ['kategori','Wajib','Kelompok barang untuk pencarian dan laporan.','Teks','Lip Tint'],
      ['merek','Opsional','Merek atau produsen barang.','Teks; boleh kosong','Nusa Beauty'],
      ['satuan_dasar','Wajib','Satuan acuan stok terkecil. Mengisi satuan dasar tidak menjadikan barang Multisatuan.','Teks, misalnya pcs/botol/sachet','pcs'],
      ['barcode_satuan_dasar','Opsional','Barcode satuan dasar. Simpan sebagai teks agar angka nol di depan tidak hilang.','Teks; harus unik bila diisi','899000000001'],
      ['harga_umum','Wajib','Harga jual umum untuk satu satuan dasar.','Angka lebih dari 0, tanpa Rp/titik ribuan','25000'],
      ['aturan_stok','Wajib','Gunakan 0 untuk barang/jasa tanpa stok dan 1 untuk barang yang memakai stok.','Hanya angka 0 atau 1','1'],
      ['stok_awal','Opsional; produk baru saja','Saldo pembukaan. Untuk produk lama gunakan Manajemen stok, stok opname, atau penerimaan restok.','Angka 0 atau lebih','24'],
      ['modal_per_satuan_dasar','Wajib jika stok_awal > 0','Modal per satuan dasar untuk batch pembukaan. Tidak dipakai untuk menimpa modal produk lama.','Angka 0 atau lebih, tanpa Rp','15000'],
      ['nomor_batch','Opsional','Nomor batch untuk stok pembukaan. Jika kosong, sistem dapat membuat nomor otomatis.','Teks','BATCH-A1'],
      ['tanggal_exp','Opsional','Tanggal kedaluwarsa batch pembukaan. Kosongkan jika barang tidak memiliki EXP.','Tanggal YYYY-MM-DD','2027-12-31'],
      ['stok_minimum','Opsional','Batas stok untuk peringatan stok menipis.','Angka 0 atau lebih','5'],
      ['pantau_exp','Wajib','Menentukan apakah barang dipantau tanggal kedaluwarsanya.','Pilih YA atau TIDAK','YA'],
      ['stok_saat_ini','Informasi; jangan diubah','Saldo stok saat file export dibuat. Perubahannya harus melalui Manajemen stok.','Angka','24'],
      ['tipe_barang','Informasi; jangan diubah','Default berarti tanpa varian dan tanpa satuan tambahan. Nilai lain: Varian, Multisatuan, atau Varian + Multisatuan.','Teks otomatis','Default'],
      ['status_produk','Informasi; jangan diubah','Status penjualan produk saat file export dibuat. Aktifkan atau nonaktifkan melalui halaman Produk.','Nilai AKTIF atau NONAKTIF','AKTIF']
    ]},
  PRODUCT_UNITS:{
    file:'template-satuan-barang-kasir-nusa.xlsx',sheet:'Satuan Barang',
    headers:['no_barang_sku','nama_satuan','isi_dalam_satuan_dasar','barcode'],
    examples:[['KOS-001','pcs',1,'899000000001'],['KOS-001','pak',6,'899000000006'],['KOS-001','lusin',12,'899000000012'],['KOS-001','dus',144,'899000000144']],
    notes:[['no_barang_sku','Wajib','SKU produk yang sudah tersimpan.','Teks','KOS-001'],['nama_satuan','Wajib','Nama satuan jual. Satu SKU boleh memiliki banyak baris satuan.','Teks','pak'],['isi_dalam_satuan_dasar','Wajib','Jumlah satuan dasar di dalam satu satuan ini. Satuan dasar selalu bernilai 1.','Angka lebih dari 0','6'],['barcode','Opsional','Barcode khusus satuan ini.','Teks; unik bila diisi','899000000006']]},
  PRODUCT_VARIANTS:{
    file:'template-varian-barang-kasir-nusa.xlsx',sheet:'Varian Barang',
    headers:['no_barang_sku','kelompok_varian','nama_varian'],
    examples:[['LIP-RED','Lip Tint Velvet','Merah'],['LIP-PINK','Lip Tint Velvet','Pink'],['LIP-NUDE','Lip Tint Velvet','Nude']],
    notes:[['no_barang_sku','Wajib','Setiap varian harus merupakan SKU yang sudah tersimpan.','Teks','LIP-RED'],['kelompok_varian','Wajib','Nama induk yang menyatukan beberapa SKU varian.','Teks','Lip Tint Velvet'],['nama_varian','Wajib','Pembeda yang dilihat kasir, misalnya warna, ukuran, atau aroma.','Teks','Merah']]},
  PRODUCT_PRICES:{
    file:'template-harga-pelanggan-kasir-nusa.xlsx',sheet:'Harga Pelanggan',
    headers:['no_barang_sku','tipe_pelanggan','minimal_pembelian','harga_per_satuan_dasar'],
    examples:[['KOS-001','Member',1,24500],['KOS-001','Grosir',1,24500],['KOS-001','Grosir',3,24000]],
    notes:[['no_barang_sku','Wajib','SKU produk yang sudah tersimpan.','Teks','KOS-001'],['tipe_pelanggan','Wajib','Nama atau kode tipe pelanggan aktif selain Umum.','Teks','Grosir'],['minimal_pembelian','Wajib','Batas jumlah dalam satuan dasar untuk harga ini.','Angka lebih dari 0','3'],['harga_per_satuan_dasar','Wajib','Harga jual per satuan dasar, bukan total baris.','Angka lebih dari 0, tanpa Rp','24000']]},
  CUSTOMERS:{file:'template-pelanggan-kasir-nusa.xlsx',sheet:'Pelanggan',headers:['kode','nama','telepon','kelompok'],examples:[['PLG-0002','Toko Cantik','081234567890','eceran']],notes:[['kode','Wajib','Kode pelanggan yang unik.','Teks','PLG-0002'],['nama','Wajib','Nama pelanggan atau usaha.','Teks','Toko Cantik'],['telepon','Opsional','Nomor telepon/WhatsApp pelanggan.','Teks','081234567890'],['kelompok','Wajib','Tipe pelanggan yang sudah aktif.','Teks','eceran']]},
  SUPPLIERS:{file:'template-supplier-kasir-nusa.xlsx',sheet:'Supplier',headers:['kode','nama','telepon','alamat'],examples:[['SUP-001','Distributor Kosmetik Nusantara','081234567890','Makassar']],notes:[['kode','Wajib','Kode supplier yang unik.','Teks','SUP-001'],['nama','Wajib','Nama supplier.','Teks','Distributor Kosmetik Nusantara'],['telepon','Opsional','Nomor telepon supplier.','Teks','081234567890'],['alamat','Opsional','Alamat supplier.','Teks','Makassar']]}
};

function columnName(index){
  let value=index+1,name='';
  while(value){value-=1;name=String.fromCharCode(65+(value%26))+name;value=Math.floor(value/26);}
  return name;
}

function setColumns(sheet,headers){
  const widths={nama_barang:28,kategori:20,merek:20,barcode_satuan_dasar:24,modal_per_satuan_dasar:27,tanggal_exp:18,stok_saat_ini:18,tipe_barang:24,status_produk:18};
  sheet['!cols']=headers.map((header)=>({wch:widths[header]??Math.max(15,Math.min(30,header.length+4))}));
  sheet['!autofilter']={ref:`A1:${columnName(headers.length-1)}1`};
  sheet['!rows']=[{hpt:32}];
}

function guideRows(template,headers){
  const noteMap=new Map(template.notes.map((note)=>[note[0],note]));
  return [
    ['PANDUAN PENGISIAN','Status','Keterangan','Format / nilai yang diterima','Contoh'],
    ...headers.map((header)=>noteMap.get(header)??[header,'Periksa kebutuhan','Isi sesuai data yang berlaku.','Teks',''])
  ];
}

function decorateWorkbookSheet(sheet,template,headers){
  setColumns(sheet,headers);
  const noteMap=new Map(template.notes.map((note)=>[note[0],note]));
  headers.forEach((header,index)=>{
    const cell=sheet[`${columnName(index)}1`];if(!cell)return;
    const note=noteMap.get(header);
    if(note)cell.c=[{a:'Kasir Nusa POS',t:`${note[1]}\n${note[2]}\nFormat: ${note[3]}\nContoh: ${note[4]}`}];
    cell.s={fill:{fgColor:{rgb:'0F766E'}},font:{bold:true,color:{rgb:'FFFFFF'}},alignment:{wrapText:true,vertical:'center'}};
  });
}

function createGuideSheet(XLSX,template,headers){
  const guide=XLSX.utils.aoa_to_sheet(guideRows(template,headers));
  guide['!cols']=[{wch:28},{wch:28},{wch:70},{wch:38},{wch:24}];
  guide['!rows']=[{hpt:34},...headers.map(()=>({hpt:42}))];
  for(let index=0;index<5;index++){
    const cell=guide[`${columnName(index)}1`];
    if(cell)cell.s={fill:{fgColor:{rgb:'0F766E'}},font:{bold:true,color:{rgb:'FFFFFF'}},alignment:{wrapText:true,vertical:'center'}};
  }
  return guide;
}

export function createTemplateWorkbook(XLSX,kind){
  const template=workbookTemplates[kind];if(!template)throw new Error('Jenis template tidak dikenal');
  const workbook=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([template.headers,...template.examples]);
  decorateWorkbookSheet(sheet,template,template.headers);XLSX.utils.book_append_sheet(workbook,sheet,template.sheet);
  XLSX.utils.book_append_sheet(workbook,createGuideSheet(XLSX,template,template.headers),'Panduan');return workbook;
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
    const hasVariant=Boolean(product.variantGroup||product.variantName),hasMultipleUnits=units.length>1;
    const productType=hasVariant&&hasMultipleUnits?'Varian + Multisatuan':hasVariant?'Varian':hasMultipleUnits?'Multisatuan':'Default';
    return {no_barang_sku:product.sku,nama_barang:product.name,kategori:product.category,merek:product.brand??'',satuan_dasar:base.name??'pcs',barcode_satuan_dasar:base.barcode??'',harga_umum:retailPrice(product),aturan_stok:product.trackStock===false?0:1,stok_awal:'',modal_per_satuan_dasar:'',nomor_batch:'',tanggal_exp:'',stok_minimum:Number(product.minimumStock??0),pantau_exp:product.trackExpiry?'YA':'TIDAK',stok_saat_ini:product.trackStock===false?'TANPA STOK':Number(product.stockBase??0),tipe_barang:productType,status_produk:product.active?'AKTIF':'NONAKTIF'};
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
  const headers=kind==='PRODUCTS'?[...template.headers,'stok_saat_ini','tipe_barang','status_produk']:template.headers;
  const workbook=XLSX.utils.book_new(),sheet=XLSX.utils.json_to_sheet(rows,{header:headers});
  decorateWorkbookSheet(sheet,template,headers);XLSX.utils.book_append_sheet(workbook,sheet,template.sheet);
  XLSX.utils.book_append_sheet(workbook,createGuideSheet(XLSX,template,headers),'Panduan');
  return {workbook,count:rows.length};
}
