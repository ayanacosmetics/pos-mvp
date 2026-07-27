import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8');
const worker = await readFile(new URL('../apps/web/service-worker.js', import.meta.url), 'utf8');

test('Nusa Commerce memakai identitas rilis dan aset shell terbaru', () => {
  assert.match(html, /Daftar Owner · v2\.4\.5/);
  assert.match(html, /styles\.css\?v=69/);
  assert.match(html, /app\.js\?v=69/);
  assert.match(worker, /nusa-pos-shell-v69/);
});

test('login memiliki hierarki brand profesional tanpa aset eksternal', () => {
  assert.match(html, /class="login-showcase"/);
  assert.match(html, /Satu ruang kerja untuk menjalankan toko dengan tenang/);
  assert.match(html, /class="login-mobile-brand"/);
  assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)\.com/);
  assert.doesNotMatch(css, /url\(\s*['"]?https?:\/\//);
});

test('navigasi utama memakai ikon vektor yang aksesibel', () => {
  const groups = [...html.matchAll(/data-nav-group="[^"]+"/g)];
  const icons = [...html.matchAll(/class="nav-icon"><svg[^>]*aria-hidden="true"/g)];
  assert.equal(groups.length, 11);
  assert.equal(icons.length, groups.length);
  assert.match(css, /\.nav-icon svg\{/);
  assert.match(css, /\.feature-nav-item\.active::before\{/);
});

test('sistem desain mencakup shell, data, POS, fokus, dan gerak terbatas', () => {
  for (const token of ['--sidebar:#102c32', '--surface-soft:#f8faf9', '--brand-hover:#0d5957']) {
    assert.ok(css.includes(token), `token ${token} harus tersedia`);
  }
  assert.match(css, /:focus-visible\{/);
  assert.match(css, /thead\{background:#f0f4f2\}/);
  assert.match(css, /\.pos-layout\{height:calc\(100dvh - 72px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css, /@media\(max-width:760px\)[\s\S]*\.product-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});
