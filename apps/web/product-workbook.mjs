export const workbookTemplates={
  PRODUCTS:{file:'template-barang-kasir-nusa.xlsx',sheet:'Barang',headers:['no_barang_sku','nama_barang','kategori','merek','satuan_terkecil','barcode_satuan_terkecil','harga_umum','satuan_besar','isi_dalam_pcs','barcode_satuan_besar','stok_awal','modal_per_pcs','nomor_batch','tanggal_exp','stok_minimum','pantau_exp'],example:['','Lip Tint Rose','Lip Tint','Nusa Beauty','pcs','899000000001',25000,'lusin',12,'899000000012',24,15000,'BATCH-A1','2027-12-31',5,'YA'],guide:[['Kolom','Cara mengisi'],['no_barang_sku','Boleh kosong untuk barang baru; Kasir Nusa membuat nomor otomatis. Jangan diubah saat mengedit barang hasil export.'],['nama_barang','Wajib diisi.'],['harga_umum','Harga jual umum per satuan terkecil; wajib lebih dari 0.'],['barcode','Boleh kosong. Format sebagai teks agar angka nol di depan tidak hilang.'],['stok_awal dan modal_per_pcs','Hanya untuk pembukaan barang. Barang yang sudah bertransaksi memakai stok opname atau restok.'],['harga Member/Grosir','Gunakan menu Aturan harga massal setelah barang berhasil diimpor.'],['ribuan barang','Unggah satu file; sistem memprosesnya dalam kelompok aman.']]},
  CUSTOMERS:{file:'template-pelanggan-kasir-nusa.xlsx',sheet:'Pelanggan',headers:['kode','nama','telepon','kelompok'],example:['PLG-0002','Toko Cantik','081234567890','eceran'],guide:[['Kolom','Cara mengisi'],['kode','Kode pelanggan wajib unik.'],['kelompok','Isi eceran atau grosir.']]},
  SUPPLIERS:{file:'template-supplier-kasir-nusa.xlsx',sheet:'Supplier',headers:['kode','nama','telepon','alamat'],example:['SUP-001','Distributor Kosmetik Nusantara','081234567890','Makassar'],guide:[['Kolom','Cara mengisi'],['kode','Kode supplier wajib unik.'],['nama','Nama supplier wajib diisi.']]}
};

function setColumns(sheet,headers){
  sheet['!cols']=headers.map((header)=>({wch:Math.max(13,Math.min(28,header.length+4))}));
  sheet['!autofilter']={ref:`A1:${String.fromCharCode(64+Math.min(headers.length,26))}1`};
}

export function createTemplateWorkbook(XLSX,kind){
  const template=workbookTemplates[kind];if(!template)throw new Error('Jenis template tidak dikenal');
  const workbook=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([template.headers,template.example]);
  setColumns(sheet,template.headers);XLSX.utils.book_append_sheet(workbook,sheet,template.sheet);
  const guide=XLSX.utils.aoa_to_sheet(template.guide);guide['!cols']=[{wch:26},{wch:90}];
  XLSX.utils.book_append_sheet(workbook,guide,'Panduan');return workbook;
}

export function workbookMatrix(XLSX,arrayBuffer,kind){
  const workbook=XLSX.read(arrayBuffer,{type:'array',cellDates:true}),expected=workbookTemplates[kind]?.sheet;
  const sheetName=workbook.SheetNames.find((name)=>name===expected)??workbook.SheetNames.find((name)=>name.toLowerCase()!=='panduan');
  if(!sheetName)throw new Error('File Excel tidak memiliki sheet data');
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName],{header:1,defval:'',raw:false,dateNF:'yyyy-mm-dd'});
}

function retailPrice(product){return Number(product.priceRules?.find((rule)=>rule.customerGroupId==='retail'&&Number(rule.minBaseQty)===1)?.unitPriceBase??0);}

export function productExportRows(products,filters={}){
  const compare=(a,b)=>String(a??'').localeCompare(String(b??''),'id',{numeric:true,sensitivity:'base'});
  const rows=products.filter((product)=>(!filters.category||product.category===filters.category)&&(!filters.brand||product.brand===filters.brand)&&(filters.status==='ALL'||!filters.status||(filters.status==='ACTIVE'?product.active:!product.active))).map((product)=>{
    const units=[...(product.units??[])].sort((a,b)=>Number(a.factor)-Number(b.factor));
    const base=units.find((unit)=>Number(unit.factor)===1)??units[0]??{},bulk=units.find((unit)=>Number(unit.factor)>1)??{};
    return {no_barang_sku:product.sku,nama_barang:product.name,kategori:product.category,merek:product.brand??'',satuan_terkecil:base.name??'pcs',barcode_satuan_terkecil:base.barcode??'',harga_umum:retailPrice(product),satuan_besar:bulk.name??'',isi_dalam_pcs:bulk.factor??'',barcode_satuan_besar:bulk.barcode??'',stok_awal:'',modal_per_pcs:'',nomor_batch:'',tanggal_exp:'',stok_minimum:Number(product.minimumStock??0),pantau_exp:product.trackExpiry?'YA':'TIDAK',stok_saat_ini:Number(product.stockBase??0),status_produk:product.active?'AKTIF':'NONAKTIF'};
  });
  const sorters={SKU_ASC:(a,b)=>compare(a.no_barang_sku,b.no_barang_sku),SKU_DESC:(a,b)=>compare(b.no_barang_sku,a.no_barang_sku),NAME_ASC:(a,b)=>compare(a.nama_barang,b.nama_barang),BARCODE_ASC:(a,b)=>compare(a.barcode_satuan_terkecil,b.barcode_satuan_terkecil),STOCK_ASC:(a,b)=>a.stok_saat_ini-b.stok_saat_ini,STOCK_DESC:(a,b)=>b.stok_saat_ini-a.stok_saat_ini};
  return rows.sort(sorters[filters.sort]??sorters.SKU_ASC);
}

export function createProductExportWorkbook(XLSX,products,filters={}){
  const workbook=XLSX.utils.book_new(),rows=productExportRows(products,filters),headers=[...workbookTemplates.PRODUCTS.headers,'stok_saat_ini','status_produk'];
  const sheet=XLSX.utils.json_to_sheet(rows,{header:headers});setColumns(sheet,headers);XLSX.utils.book_append_sheet(workbook,sheet,'Barang');
  const guide=XLSX.utils.aoa_to_sheet(workbookTemplates.PRODUCTS.guide);guide['!cols']=[{wch:26},{wch:90}];XLSX.utils.book_append_sheet(workbook,guide,'Panduan');
  return {workbook,count:rows.length};
}
