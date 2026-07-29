import test from 'node:test';
import assert from 'node:assert/strict';
import {barcodeModuleCount,barcodeRasterBits,barcodeSvg,barcodeTypeFor,code128Modules,code128Svg,code128Values,eanBits,labelSize,normalizeCode128Text,validEan} from '../apps/web/product-labels.mjs';
import {productLabelFeedDots,productLabelPrinterWidthDots,productLabelRasterLayout,productLabelRasterPlacement} from '../apps/web/escpos-printer.mjs';

test('Code 128B membentuk checksum dan stop pattern yang valid',()=>{
  assert.deepEqual(code128Values('ABC'),[104,33,34,35,1,106]);
  const modules=code128Modules('ABC'),svg=code128Svg('ABC');
  assert.ok(modules.endsWith('2331112'));
  assert.match(svg,/<svg/);
  assert.equal((svg.match(/<rect/g)??[]).length,Math.ceil(modules.length/2));
  assert.match(svg,/<rect x="10"[^>]*width="2"/);
  assert.match(svg,/<rect x="13"[^>]*width="1"/);
  assert.doesNotMatch(svg,/<rect x="12"/);
  assert.doesNotMatch(code128Svg('A"><script>'),/aria-label="[^"]*<script>/);
});

test('barcode angka genap memakai Code 128C agar garis tidak terlalu rapat',()=>{
  assert.deepEqual(code128Values('899000000001'),[105,89,90,0,0,0,1,71,106]);
  assert.ok(code128Modules('899000000001').length<code128Modules('A899000000001').length);
});

test('EAN-13 dan EAN-8 tervalidasi serta dapat dipilih otomatis',()=>{
  assert.equal(validEan('8999908509109',13),true);
  assert.equal(barcodeTypeFor('8999908509109'),'EAN13');
  assert.equal(eanBits('8999908509109','EAN13').length,95);
  assert.match(barcodeSvg('8999908509109'),/aria-label="EAN13/);
  assert.match(barcodeSvg('8999908509109'),/shape-rendering="crispEdges"/);
  assert.equal(barcodeModuleCount('8999908509109'),113);
  assert.equal(validEan('96385074',8),true);
  assert.equal(eanBits('96385074','EAN8').length,67);
  assert.throws(()=>barcodeSvg('00000002',{type:'EAN8'}),/bukan EAN-8/);
});

test('raster label 33 x 15 mm menjaga quiet zone dan garis minimal dua dot',()=>{
  const bits=barcodeRasterBits('8999908509109');
  assert.equal(bits.length,113);
  assert.ok(bits.startsWith('0'.repeat(11)));
  assert.ok(bits.endsWith('0'.repeat(7)));
  const layout=productLabelRasterLayout({barcode:'8999908509109'},{width:33,height:15,moduleWidth:.26,barcodeHeight:4.8});
  assert.equal(layout.widthDots,264);
  assert.equal(layout.heightDots,120);
  assert.equal(layout.contentLeft,4);
  assert.equal(layout.contentTop,2);
  assert.equal(layout.moduleDots,2);
  assert.equal(layout.barcodeWidth,226);
  assert.equal(layout.barcodeHeight,38);
  assert.equal(productLabelPrinterWidthDots(58),384);
  assert.equal(productLabelPrinterWidthDots(80),576);
  assert.deepEqual(productLabelRasterPlacement(264,58),{rasterWidth:384,startX:60});
  assert.deepEqual(productLabelRasterPlacement(264,80),{rasterWidth:576,startX:156});
  assert.equal(productLabelFeedDots(0),0);
  assert.equal(productLabelFeedDots(2),16);
  assert.equal(productLabelFeedDots(-1),0);
  assert.throws(()=>productLabelRasterLayout({barcode:'X'.repeat(40)},{width:33,height:15,type:'CODE128B',moduleWidth:.26}),/terlalu padat/);
});

test('kode label dinormalisasi aman dan ukuran hanya dari preset',()=>{
  assert.equal(normalizeCode128Text(' SKU-1\n'),'SKU-1');
  assert.deepEqual(labelSize(33,15),{width:33,height:15});
  assert.deepEqual(labelSize(8,500),{width:10,height:200});
  assert.throws(()=>code128Values(''),/tidak boleh kosong/);
});

test('UI produk menyediakan seleksi dan dialog cetak label',async()=>{
  const {readFile}=await import('node:fs/promises');
  const [html,script,css,worker]=await Promise.all([
    readFile(new URL('../apps/web/index.html',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/styles.css',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/service-worker.js',import.meta.url),'utf8')
  ]);
  assert.match(html,/id="print-selected-product-labels"/);
  assert.match(html,/id="product-label-dialog"/);
  assert.match(html,/id="product-label-width"[^>]*value="33"/);
  assert.match(html,/id="product-label-height"[^>]*value="15"/);
  assert.match(html,/id="product-label-gap"[^>]*value="0"/);
  assert.match(script,/barcodeSvg/);
  for(const id of ['product-label-preset','product-label-source','product-label-type','product-label-columns','product-label-rows','product-label-name-size','product-label-price-size','product-label-code-size','product-label-barcode-height','product-label-module-width','product-label-gap','product-label-text-position','product-label-align','product-label-printer-width','product-label-margin-x','product-label-margin-y','product-label-offset-x','product-label-offset-y','product-label-vertical-align','product-label-copy-list','product-label-use-stock'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(script,/productLabelCopies:new Map/);
  assert.match(script,/setProductLabelCopies\('STOCK'\)/);
  assert.match(script,/function productLabelStock/);
  assert.match(script,/barcodeModuleCount/);
  assert.match(script,/printEscPosProductLabels/);
  assert.match(script,/renderEscPosProductLabelCanvas/);
  assert.match(script,/pageHeight=\(config\.size\.height\+config\.gap\)\*config\.rows/);
  assert.match(script,/window\.KasirNusaAndroid\?\.printBase64/);
  assert.match(html,/id="product-label-module-width"[^>]*value="0\.26"/);
  assert.match(css,/@page\{margin:4mm\}/);
  assert.match(css,/\.product-label-raster-preview/);
  assert.match(css,/gap:var\(--label-gap\) 0/);
  assert.match(worker,/product-labels\.mjs/);
});

test('direktori produk memakai kolom umum, barcode utuh, tipe barang, dan detail saat baris dibuka',async()=>{
  const {readFile}=await import('node:fs/promises');
  const [script,css]=await Promise.all([
    readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),
    readFile(new URL('../apps/web/styles.css',import.meta.url),'utf8')
  ]);
  for(const heading of ['SKU','Barcode','Nama produk','Tipe barang','Kategori','Merek','Harga umum','Stok','Min. stok','Status'])assert.match(script,new RegExp(`>${heading.replace('.','\\.')}</th>`));
  assert.doesNotMatch(script,/>Varian<\/th>|>Satuan<\/th>/);
  assert.match(script,/hasVariant&&hasMultipleUnits\?'Varian \+ Multisatuan'/);
  assert.match(script,/hasMultipleUnits\?`<div class="product-detail-units"/);
  assert.match(script,/const canViewCost=state\.session\?\.permissions\?\.includes\('purchasing\.view_cost'\)\?\?false/);
  assert.match(script,/>Modal<\/th>/);
  assert.doesNotMatch(script,/<th>Aksi<\/th>/);
  assert.match(script,/productActionId:null/);
  assert.match(script,/class="product-action-row product-detail-row"/);
  assert.match(script,/state\.productActionId===row\.dataset\.productId\?null:row\.dataset\.productId/);
  assert.match(css,/\.product-select-cell input\{width:14px;height:14px;min-width:14px!important;min-height:14px!important/);
  assert.match(css,/\.product-admin-table\{min-width:1105px;table-layout:fixed\}/);
  assert.match(css,/\.product-col-barcode\{width:165px\}/);
  assert.match(css,/\.product-admin-table \.product-admin-row>\.product-barcode-cell\{overflow:visible;text-overflow:clip;white-space:nowrap\}/);
  assert.match(css,/#page-products \.page-title\{display:grid;grid-template-columns:/);
  assert.match(css,/#page-products \.product-page-actions \.button\{min-height:34px/);
  assert.match(css,/#page-products \.product-metrics \.metric\{display:grid;min-height:62px/);
});
