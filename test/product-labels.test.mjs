import test from 'node:test';
import assert from 'node:assert/strict';
import {code128Modules,code128Svg,code128Values,labelSize,normalizeCode128Text} from '../apps/web/product-labels.mjs';

test('Code 128B membentuk checksum dan stop pattern yang valid',()=>{
  assert.deepEqual(code128Values('ABC'),[104,33,34,35,1,106]);
  assert.ok(code128Modules('ABC').endsWith('2331112'));
  assert.match(code128Svg('ABC'),/<svg/);
  assert.match(code128Svg('ABC'),/<rect/);
  assert.doesNotMatch(code128Svg('A"><script>'),/aria-label="[^"]*<script>/);
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
  assert.match(script,/code128Svg/);
  assert.match(css,/@page\{margin:4mm\}/);
  assert.match(worker,/product-labels\.mjs/);
});
