import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {parseKaspinProductWorkbook,parseKaspinProductExtensionWorkbook,parseKaspinFifoWorkbooks,parseKaspinSalesWorkbooks,parseKaspinCustomerWorkbook} from '../apps/web/kaspin-import.mjs';

async function sheetJs(){
  const source=await readFile(new URL('../apps/web/vendor/xlsx.full.min.js',import.meta.url),'utf8');
  const sandbox={console,Date,ArrayBuffer,Uint8Array,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array,Float32Array,Float64Array,TextEncoder,TextDecoder,setTimeout,clearTimeout};
  sandbox.globalThis=sandbox;sandbox.window=sandbox;vm.runInNewContext(source,sandbox);return sandbox.XLSX;
}

function kaspinWorkbook(XLSX){
  const headers=['alasan_gagal','kode_barang_edit','nama_barang_edit','barang_jasa_edit','show_toko_edit','harga_jual_edit','harga_beli_edit','minimum_stok','stok_edit','tipe_diskon','diskon','berat_dan_satuan','berat','letak_rak','keterangan','kategori','tipe_barang'];
  const guide=headers.map(()=> 'Petunjuk Kaspin');
  const rows=[
    headers,guide,
    ['',8993137697170,'Produk Angka',0,0,12000,7000,2,5,0,0,'',0,'','','Kosmetik','Default'],
    ['','0000000000001','Produk Nol',0,0,5000,3000,0,1,0,0,'pcs',0,'','','Snack','Multi Satuan'],
    ['',8990000000002,'Induk Varian',0,0,0,0,0,2,0,0,'',0,'','','Kosmetik','Varian'],
    ['',8990000000003,'Harga Kosong Default',0,0,0,0,0,2,0,0,'',0,'','','Kosmetik','Default']
  ];
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(rows),'barang');
  return XLSX.write(workbook,{bookType:'xlsx',type:'array'});
}

test('parser Kaspin mempertahankan seluruh digit kode dan melewati baris invalid secara transparan',async()=>{
  const XLSX=await sheetJs();
  const parsed=parseKaspinProductWorkbook(XLSX,kaspinWorkbook(XLSX));
  assert.equal(parsed.report.source,'KASPIN');
  assert.equal(parsed.report.total,4);
  assert.equal(parsed.report.mapped,2);
  assert.equal(parsed.report.skipped,1);
  assert.equal(parsed.report.deferred,1);
  assert.equal(parsed.report.deferredRows[0].row,5);
  assert.equal(parsed.report.issues[0].row,6);
  assert.equal(parsed.rows[0].sku,'KP-8993137697170');
  assert.equal(parsed.rows[0].baseBarcode,'8993137697170');
  assert.equal(parsed.rows[1].sku,'KP-0000000000001');
  assert.equal(parsed.rows[1].baseBarcode,'0000000000001');
  assert.equal(parsed.rows[0].batchNo,'SALDO-AWAL-KASPIN');
  assert.equal(parsed.rows[0].openingQty,5);
  assert.equal(parsed.rows[0].openingCost,7000);
  assert.equal(parsed.report.detailedTypeRows,2);
});

test('file biasa tidak salah dideteksi sebagai export Kaspin',async()=>{
  const XLSX=await sheetJs(),workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['no_barang_sku','nama_barang'],['A','Barang']]),'Barang');
  assert.equal(parseKaspinProductWorkbook(XLSX,XLSX.write(workbook,{bookType:'xlsx',type:'array'})),null);
});

test('kode Kaspin ganda menjadi kandidat barcode bersama dan SKU tetap unik',async()=>{
  const XLSX=await sheetJs(),workbook=XLSX.utils.book_new();
  const headers=['alasan_gagal','kode_barang_edit','nama_barang_edit','barang_jasa_edit','show_toko_edit','harga_jual_edit','harga_beli_edit','minimum_stok','stok_edit','tipe_diskon','diskon','berat_dan_satuan','berat','letak_rak','keterangan','kategori','tipe_barang'];
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([
    headers,headers.map(()=> 'Petunjuk'),
    ['','8990000000001','Lip Cream Merah',0,0,20000,10000,0,4,0,0,'pcs',0,'','','Lip Cream','Default'],
    ['','8990000000001','Lip Cream Nude',0,0,20000,10000,0,6,0,0,'pcs',0,'','','Lip Cream','Default']
  ]),'barang');
  const parsed=parseKaspinProductWorkbook(XLSX,XLSX.write(workbook,{bookType:'xlsx',type:'array'}));
  assert.equal(new Set(parsed.rows.map((row)=>row.sku)).size,2);
  assert.deepEqual(parsed.rows.map((row)=>row.baseBarcode),['','']);
  assert.deepEqual(parsed.rows.map((row)=>row.legacyCode),['8990000000001','8990000000001']);
  assert.equal(parsed.report.sharedBarcodeCandidates[0].barcode,'8990000000001');
  assert.equal(parsed.report.sharedBarcodeCandidates[0].count,2);
});

test('parser Kaspin membaca multi satuan beserta harga jual satuannya',async()=>{
  const XLSX=await sheetJs(),workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([
    ['kode_barang','nama_barang','tipe_satuan','harga','jumlah_per_satuan','satuan_terkecil'],
    ['0000000000001','Biskuit Durian','Pcs',5000,1,'Pcs'],
    ['0000000000001','Biskuit Durian','Bal',42000,12,'Pcs']
  ]),'multi_satuan');
  const parsed=parseKaspinProductExtensionWorkbook(XLSX,XLSX.write(workbook,{bookType:'xlsx',type:'array'}),'PRODUCT_UNITS');
  assert.equal(parsed.report.fileType,'Multi Satuan');
  assert.equal(parsed.report.mapped,2);
  assert.deepEqual(parsed.rows.map((row)=>({...row})),[
    {sku:'KP-0000000000001',unitName:'Pcs',factor:1,barcode:'',unitPriceTotal:5000},
    {sku:'KP-0000000000001',unitName:'Bal',factor:12,barcode:'',unitPriceTotal:42000}
  ]);
});

test('parser Kaspin hanya membawa harga grosir yang terintegrasi tipe pelanggan',async()=>{
  const XLSX=await sheetJs(),workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([
    ['nama_barang','kode_barang','nama','jumlah_minimal','harga_satuan','terintegrasi tipe pelanggan'],
    ['Biskuit Durian','0000000000001','grosir',12,3500,'Ya'],
    ['Gudang Garam',0,'tingkatan 1',1,348500,'Tidak']
  ]),'harga_grosir');
  const parsed=parseKaspinProductExtensionWorkbook(XLSX,XLSX.write(workbook,{bookType:'xlsx',type:'array'}),'PRODUCT_PRICES');
  assert.equal(parsed.report.mapped,1);
  assert.equal(parsed.report.ignored,1);
  assert.deepEqual({...parsed.rows[0]},{sku:'KP-0000000000001',customerGroup:'grosir',minQty:12,unitPrice:3500});
});

test('parser FIFO menggabungkan transaksi pembelian dan laporan modal tanpa mengubah jumlah stok',async()=>{
  const XLSX=await sheetJs(),purchase=XLSX.utils.book_new(),capital=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(purchase,XLSX.utils.aoa_to_sheet([
    ['Kode Transaksi','Timestamp','Kategori','Kode Barang','Nama Barang','Jumlah','Harga Beli','Harga Jual','Total','Diskon','Pajak','Kasir','Tipe Pembayaran','Metode Pembayaran'],
    ['PB-1','29/07/2026 10:30','Snack','0000000000001','Biskuit Durian',12,7350,9000,88200,0,0,'Budhi','Lunas','Tunai']
  ]),'Transaksi_Barang');
  XLSX.utils.book_append_sheet(purchase,XLSX.utils.aoa_to_sheet([
    ['Kode Transaksi','Waktu','Total Pendapatan','Total Uang Real','Bayar','Kasir','Tipe Pembayaran','Email Suplier','Nama Suplier'],
    ['PB-1','29/07/2026 10:30',88200,88200,88200,'Budhi','Lunas','','Supplier Uji']
  ]),'Transaksi');
  XLSX.utils.book_append_sheet(capital,XLSX.utils.aoa_to_sheet([
    ['Kode','Nama','Kategori','Stok','Sisa Modal'],
    ['0000000000001','Biskuit Durian','Snack',5,36750]
  ]),'Laporan_Modal');
  const parsed=parseKaspinFifoWorkbooks(
    XLSX,XLSX.write(purchase,{bookType:'xlsx',type:'array'}),XLSX.write(capital,{bookType:'xlsx',type:'array'})
  );
  assert.equal(parsed.report.receipts,1);
  assert.equal(parsed.report.purchaseLines,1);
  assert.equal(parsed.rows[0].productCode,'0000000000001');
  assert.equal(parsed.rows[0].unitCost,7350);
  assert.equal(parsed.rows[0].supplierName,'Supplier Uji');
  assert.deepEqual({...parsed.capitalRows[0]},{productCode:'0000000000001',productName:'Biskuit Durian',stock:5,remainingCapital:36750});
});

test('parser penjualan Kaspin menggabungkan detail barang dengan total struk',async()=>{
  const XLSX=await sheetJs(),details=XLSX.utils.book_new(),transactions=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(details,XLSX.utils.aoa_to_sheet([
    ['Kode Transaksi','Timestamp','Kategori','Kode Barang','Nama Barang','Jumlah','Harga Beli','Harga Jual','Total','Diskon','Pajak','Kasir','Tipe Pembayaran','Metode Pembayaran','Email Pelanggan','Nama Pelanggan','Catatan Singkat'],
    ['TRX-1','2026-06-01 10:00:00','Snack','0000000000001','Biskuit Durian',2,3500,5000,10000,0,0,'Kasir Lama','tunai','Cash','','','']
  ]),'Transaksi_Barang');
  XLSX.utils.book_append_sheet(transactions,XLSX.utils.aoa_to_sheet([
    ['Kode Transaksi','Waktu','Total Pendapatan','Total Uang Real','Keuntungan','Bayar','Uang Kembalian','Kasir','Tipe Pembayaran','Metode Pembayaran','Email Pelanggan','Nama Pelanggan','Jatuh Tempo','Diskon','Nama Diskon','Pajak','Keterangan'],
    ['TRX-1','2026-06-01 10:00:00',9000,9000,2000,10000,1000,'Kasir Lama','tunai','Cash','','',null,1000,'Diskon toko',0,'Migrasi']
  ]),'Transaksi');
  const parsed=parseKaspinSalesWorkbooks(
    XLSX,XLSX.write(details,{bookType:'xlsx',type:'array'}),XLSX.write(transactions,{bookType:'xlsx',type:'array'})
  );
  assert.equal(parsed.report.receipts,1);
  assert.equal(parsed.report.salesLines,1);
  assert.equal(parsed.rows[0].transactionCode,'TRX-1');
  assert.equal(parsed.rows[0].productCode,'0000000000001');
  assert.equal(parsed.rows[0].lineGross,10000);
  assert.equal(parsed.rows[0].grandTotal,9000);
  assert.equal(parsed.rows[0].tendered,10000);
  assert.equal(parsed.rows[0].change,1000);
});

test('parser pelanggan Kaspin mempertahankan Member, Grosir, email, dan poin',async()=>{
  const XLSX=await sheetJs(),workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([
    ['alasan_gagal','email_customer_edit','nama_lengkap_customer_edit','no_hp','alamat','kode','tipe_pelanggan','point','status_olshopin'],
    ['Petunjuk','Jangan diubah','Nama','Telepon','Alamat','Kode','Tipe','Poin','Status'],
    ['', 'member@example.com','Pelanggan Member',628111222333,'Sinjai','','Member',12,0],
    ['', 'grosir@example.com','Pelanggan Grosir',628444555666,'Bulukumba','GR-01','grosir',5,0]
  ]),'pelanggan');
  const parsed=parseKaspinCustomerWorkbook(XLSX,XLSX.write(workbook,{bookType:'xlsx',type:'array'}));
  assert.equal(parsed.report.mapped,2);
  assert.deepEqual(parsed.report.types,{Member:1,grosir:1});
  assert.deepEqual({...parsed.rows[0]},{
    code:'KSP-628111222333',name:'Pelanggan Member',phone:'628111222333',
    email:'member@example.com',address:'Sinjai',groupId:'Member',loyaltyPoints:12
  });
  assert.equal(parsed.rows[1].code,'GR-01');
  assert.equal(parsed.rows[1].groupId,'grosir');
});

test('halaman impor menghubungkan pilihan Kasir Pintar dan parser ke cache PWA',async()=>{
  const [html,app,worker]=await Promise.all([
    readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/service-worker.js',import.meta.url),'utf8')
  ]);
  assert.match(html,/id="import-source"[\s\S]*Export Kasir Pintar/);
  assert.match(html,/id="kaspin-code-as-barcode"[^>]*checked/);
  assert.match(app,/parseKaspinProductWorkbook/);
  assert.match(app,/parseKaspinProductExtensionWorkbook/);
  assert.match(app,/parseKaspinFifoWorkbooks/);
  assert.match(app,/parseKaspinSalesWorkbooks/);
  assert.match(app,/parseKaspinCustomerWorkbook/);
  assert.match(app,/state\.importSourceReport/);
  assert.match(worker,/\/kaspin-import\.mjs/);
});
