import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createProductExportWorkbook,createTemplateWorkbook,productExportRows,productExtensionExportRows,workbookMatrix,workbookTemplates} from '../apps/web/product-workbook.mjs';

async function sheetJs(){
  const source=await readFile(new URL('../apps/web/vendor/xlsx.full.min.js',import.meta.url),'utf8');
  const sandbox={console,Date,ArrayBuffer,Uint8Array,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array,Float32Array,Float64Array,TextEncoder,TextDecoder,setTimeout,clearTimeout};
  sandbox.globalThis=sandbox;sandbox.window=sandbox;vm.runInNewContext(source,sandbox);return sandbox.XLSX;
}

test('template barang adalah workbook sederhana dengan SKU opsional dan panduan',async()=>{
  const XLSX=await sheetJs(),workbook=createTemplateWorkbook(XLSX,'PRODUCTS');
  assert.deepEqual([...workbook.SheetNames],['Barang','Panduan']);
  const binary=XLSX.write(workbook,{bookType:'xlsx',type:'array'}),matrix=workbookMatrix(XLSX,binary,'PRODUCTS');
  assert.equal(matrix[0][0],'no_barang_sku');
  assert.equal(matrix[1][0],'');
  assert.equal(matrix[0].includes('harga_grosir'),false);
  assert.equal(matrix[0].includes('satuan_besar'),false);
  assert.equal(matrix[0].includes('satuan_dasar'),true);
  assert.equal(matrix[0].includes('stok_minimum'),true);
});

test('multi satuan, varian, dan harga pelanggan memakai file terpisah serta lolos roundtrip',async()=>{
  const XLSX=await sheetJs();
  for(const kind of ['PRODUCT_UNITS','PRODUCT_VARIANTS','PRODUCT_PRICES']){
    const workbook=createTemplateWorkbook(XLSX,kind),binary=XLSX.write(workbook,{bookType:'xlsx',type:'array'}),matrix=workbookMatrix(XLSX,binary,kind);
    assert.deepEqual([...workbook.SheetNames],[workbookTemplates[kind].sheet,'Panduan']);
    assert.deepEqual(Array.from(matrix[0].slice(0,workbookTemplates[kind].headers.length)),workbookTemplates[kind].headers);
    assert.ok(matrix.length>=2);
  }
  assert.equal(workbookMatrix(XLSX,XLSX.write(createTemplateWorkbook(XLSX,'PRODUCT_UNITS'),{bookType:'xlsx',type:'array'}),'PRODUCT_UNITS').length,5);
});

test('export barang dapat difilter dan diurutkan menurut nomor barang, barcode, atau stok',()=>{
  const products=[
    {sku:'000010',name:'B',category:'Lip',brand:'Nusa',active:true,stockBase:2,minimumStock:1,trackExpiry:true,variantGroup:'Lip Velvet',variantName:'Pink',units:[{name:'pcs',factor:1,barcode:'8992'},{name:'pak',factor:6,barcode:'8996'},{name:'dus',factor:72,barcode:'8972'}],priceRules:[{customerGroupId:'retail',minBaseQty:1,unitPriceBase:2000},{customerGroupId:'member',minBaseQty:1,unitPriceBase:1800},{customerGroupId:'wholesale',minBaseQty:3,unitPriceBase:1700}]},
    {sku:'000002',name:'A',category:'Lip',brand:'Nusa',active:true,stockBase:8,minimumStock:0,trackExpiry:false,units:[{name:'pcs',factor:1,barcode:'8991'}],priceRules:[{customerGroupId:'retail',minBaseQty:1,unitPriceBase:1000}]}
  ];
  assert.deepEqual(productExportRows(products,{status:'ALL',sort:'SKU_ASC'}).map((row)=>row.no_barang_sku),['000002','000010']);
  assert.equal(productExportRows(products,{status:'ALL',sort:'STOCK_ASC'})[0].stok_saat_ini,2);
  assert.equal(productExtensionExportRows(products,'PRODUCT_UNITS',{status:'ALL'}).filter((row)=>row.no_barang_sku==='000010').length,3);
  assert.equal(productExtensionExportRows(products,'PRODUCT_VARIANTS',{status:'ALL'})[0].nama_varian,'Pink');
  assert.equal(productExtensionExportRows(products,'PRODUCT_PRICES',{status:'ALL'}).length,2);
});

test('export setiap jenis produk menghasilkan sheet dan jumlah baris yang sesuai',async()=>{
  const XLSX=await sheetJs(),products=[{sku:'SKU-1',name:'Produk',category:'Tes',active:true,variantGroup:'Warna',variantName:'Merah',units:[{name:'pcs',factor:1,barcode:'1'},{name:'dus',factor:12,barcode:'12'}],priceRules:[{customerGroupId:'retail',minBaseQty:1,unitPriceBase:1000},{customerGroupId:'member',minBaseQty:1,unitPriceBase:900}]}];
  for(const [kind,count] of [['PRODUCTS',1],['PRODUCT_UNITS',2],['PRODUCT_VARIANTS',1],['PRODUCT_PRICES',1]]){
    const result=createProductExportWorkbook(XLSX,products,{status:'ALL'},kind);
    assert.equal(result.count,count);assert.equal(result.workbook.SheetNames[0],workbookTemplates[kind].sheet);
  }
});
