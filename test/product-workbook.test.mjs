import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createTemplateWorkbook,productExportRows,workbookMatrix} from '../apps/web/product-workbook.mjs';

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
  assert.equal(matrix[0].includes('stok_minimum'),true);
});

test('export barang dapat difilter dan diurutkan menurut nomor barang, barcode, atau stok',()=>{
  const products=[
    {sku:'000010',name:'B',category:'Lip',brand:'Nusa',active:true,stockBase:2,minimumStock:1,trackExpiry:true,units:[{name:'pcs',factor:1,barcode:'8992'}],priceRules:[{customerGroupId:'retail',minBaseQty:1,unitPriceBase:2000}]},
    {sku:'000002',name:'A',category:'Lip',brand:'Nusa',active:true,stockBase:8,minimumStock:0,trackExpiry:false,units:[{name:'pcs',factor:1,barcode:'8991'}],priceRules:[{customerGroupId:'retail',minBaseQty:1,unitPriceBase:1000}]}
  ];
  assert.deepEqual(productExportRows(products,{status:'ALL',sort:'SKU_ASC'}).map((row)=>row.no_barang_sku),['000002','000010']);
  assert.equal(productExportRows(products,{status:'ALL',sort:'STOCK_ASC'})[0].stok_saat_ini,2);
});
