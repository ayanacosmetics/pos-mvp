import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read=(path)=>readFile(new URL(path,import.meta.url),'utf8');

test('logo struk dan foto produk mengutamakan galeri atau kamera',async()=>{
  const [html,app,css]=await Promise.all([
    read('../apps/web/index.html'),read('../apps/web/app.js'),read('../apps/web/styles.css')
  ]);
  assert.match(html,/id="setting-receipt-logo-file" type="file"/);
  assert.match(html,/Logo dari galeri atau kamera/);
  assert.match(html,/id="new-image-file" type="file"/);
  assert.match(html,/Pilih dari galeri atau kamera/);
  assert.match(html,/id="new-image-preview"/);
  assert.match(html,/Gunakan URL gambar \(opsional\)/);
  assert.match(app,/productImageDataFromFile/);
  assert.match(app,/\/api\/media\/product-image/);
  assert.match(app,/Mengunggah foto/);
  assert.match(css,/product-photo-preview/);
});

test('foto produk disimpan sebagai objek publik terpisah agar katalog tetap ringan',async()=>{
  const [sql,api]=await Promise.all([
    read('../supabase/migrations/202607280040_pos_media_storage.sql'),
    read('../api/index.mjs')
  ]);
  assert.match(sql,/insert into storage\.buckets/);
  assert.match(sql,/'pos-media'/);
  assert.match(sql,/file_size_limit/);
  assert.match(api,/function uploadPublicMedia/);
  assert.match(api,/storage\/v1\/object\/pos-media/);
  assert.match(api,/route==='media\/product-image'/);
  assert.match(api,/requirePermission\(session,'catalog\.manage'\)/);
  assert.match(api,/storage\/v1\/object\/public\/pos-media/);
});
