import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {parseKaspinProductWorkbook} from '../apps/web/kaspin-import.mjs';

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
    ['',8990000000002,'Harga Kosong',0,0,0,0,0,2,0,0,'',0,'','','Kosmetik','Varian']
  ];
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(rows),'barang');
  return XLSX.write(workbook,{bookType:'xlsx',type:'array'});
}

test('parser Kaspin mempertahankan seluruh digit kode dan melewati baris invalid secara transparan',async()=>{
  const XLSX=await sheetJs();
  const parsed=parseKaspinProductWorkbook(XLSX,kaspinWorkbook(XLSX));
  assert.equal(parsed.report.source,'KASPIN');
  assert.equal(parsed.report.total,3);
  assert.equal(parsed.report.mapped,2);
  assert.equal(parsed.report.skipped,1);
  assert.equal(parsed.report.issues[0].row,5);
  assert.equal(parsed.rows[0].sku,'8993137697170');
  assert.equal(parsed.rows[0].baseBarcode,'8993137697170');
  assert.equal(parsed.rows[1].sku,'0000000000001');
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

test('halaman impor menghubungkan pilihan Kasir Pintar dan parser ke cache PWA',async()=>{
  const [html,app,worker]=await Promise.all([
    readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/service-worker.js',import.meta.url),'utf8')
  ]);
  assert.match(html,/id="import-source"[\s\S]*Export barang Kasir Pintar/);
  assert.match(html,/id="kaspin-code-as-barcode"[^>]*checked/);
  assert.match(app,/parseKaspinProductWorkbook/);
  assert.match(app,/state\.importSourceReport/);
  assert.match(worker,/\/kaspin-import\.mjs/);
});
