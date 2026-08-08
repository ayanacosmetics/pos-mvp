# Handoff terbaru — 6 Agustus 2026

Gunakan bersama `PROJECT-HANDOFF.md`. Baca masing-masing sekali saja. Jangan mengulang pekerjaan yang sudah selesai.

## Kondisi terakhir yang sudah selesai

- Rekonsiliasi shift telah dirombak menjadi daftar padat dan halaman detail penuh.
- Detail menampilkan modal awal, penjualan tunai, kas masuk, kas keluar/refund, kas sistem, kas fisik, selisih, seluruh metode pembayaran, dan pergerakan laci.
- Semua 366 tes lulus.
- Commit terakhir: `cf8aff9 feat: redesign shift reconciliation workspace`.
- Sudah push ke `main` dan deploy ke Cloudflare `app.nusapos.my.id`.
- Deployment Cloudflare terakhir berhasil, Version ID `b861c671-1888-40d0-a0dc-8295a830b79d`.
- Tidak ada SQL baru untuk pekerjaan rekonsiliasi tersebut.

## APK Android 1.4.1 — izin lokasi absensi selesai

- Manifest memuat `ACCESS_FINE_LOCATION` dan `ACCESS_COARSE_LOCATION`.
- Izin runtime baru diminta ketika WebView meminta geolokasi saat alur absensi, bukan saat aplikasi dibuka.
- Callback geolokasi hanya mengizinkan origin resmi `https://app.nusapos.my.id`; origin lain ditolak bersih.
- Penolakan izin diteruskan ke halaman dan petunjuk mengarahkan pengguna ke Pengaturan Android.
- Kamera, Bluetooth printer, scanner HID, Firebase/FCM, dan package `app.kasirnusa.cashier` dipertahankan.
- APK memakai versionCode `10`, versionName `1.4.1`, dan sertifikat yang sama persis dengan 1.4.0 sehingga dapat dipasang sebagai pembaruan tanpa uninstall.
- APK release identik di `releases/` dan `apps/web/downloads/`, SHA-256 `560BEAAE37D0E707BF57D64A500FBA3887DD144C27EDE899451497CF313C1097`.
- Build Android berhasil dan seluruh 367 tes otomatis lulus.
- Tidak memerlukan SQL.
- Commit fitur `08c7c59 fix: enable Android attendance location` sudah didorong ke `main`.
- Deployment Cloudflare berhasil, Version ID `bd09c3ee-f71f-43ad-afbc-34f849a3e141`.
- URL publik APK, checksum hasil unduhan, petunjuk izin pada `app.js`, dan API health sudah diverifikasi pada `app.nusapos.my.id`.

## APK Android 1.4.2 — hotfix origin lokasi

- WebView menserialisasi origin produksi sebagai `https://app.nusapos.my.id/`; validasi 1.4.1 keliru hanya menerima path kosong sehingga lokasi ditolak walaupun izin Android aktif.
- Validasi 1.4.2 menerima path kosong atau `/` untuk origin HTTPS, host, dan port resmi yang sama, serta tetap menolak path, query, fragment, user-info, atau host lain.
- APK memakai versionCode `11`, versionName `1.4.2`, package dan sertifikat permanen yang sama.
- APK release identik di `releases/` dan `apps/web/downloads/`, SHA-256 `4461E85EAE0EF2F0D00E0492E7FFB9AB74E187B7521CBD9E7E4F91EAFA434867`.
- Tidak memerlukan SQL.
- Seluruh 367 tes lulus; commit fitur `6c0d3c2 fix: accept canonical WebView location origin` sudah didorong ke `main`.
- Deployment Cloudflare berhasil, Version ID `c2c3bd47-5b5a-4dd0-be53-c99198e801c4`; URL publik APK dan API health sudah diverifikasi.

## APK Android 1.4.3 — scanner tetap di halaman aktif

- Event HID non-barcode saat scanner tersambung ulang, termasuk Enter kosong dan key-up, dikonsumsi APK agar tidak mengaktifkan tombol/menu WebView.
- Barcode valid diarahkan menurut halaman aktif: Kasir, draft PO, atau langkah Barang pada penerimaan/restok; handler scanner tidak memanggil navigasi.
- APK memakai versionCode `12`, versionName `1.4.3`, package dan sertifikat permanen yang sama.
- APK release identik di `releases/` dan `apps/web/downloads/`, SHA-256 `28F7587A121207582DA94E0E55464054932FF5524477FD6EA55B115D02A7F931`.
- Build Android berhasil dan seluruh 368 tes lulus. Tidak memerlukan SQL.
- Commit fitur `3f8562c fix: keep scanner on active workflow` sudah didorong ke `main`.
- Deployment Cloudflare berhasil, Version ID `08a50f93-5499-498a-b34e-5bd264f93586`; APK publik, handler scanner restok, dan API health sudah diverifikasi.

## APK Android 1.4.4 — cegah restart saat scanner tersambung

- Foto perangkat membuktikan scanner bukan memicu tombol, tetapi perubahan konfigurasi HID me-restart Activity dan menampilkan ulang “Memulihkan sesi kerja”.
- Manifest kini menangani perubahan `navigation` selain `keyboard` dan `keyboardHidden`; callback konfigurasi mempertahankan Activity/WebView serta draft restok yang sedang aktif.
- APK memakai versionCode `13`, versionName `1.4.4`, package dan sertifikat permanen yang sama.
- APK release identik di `releases/` dan `apps/web/downloads/`, SHA-256 `2D354C1E1CA0BA2501EA8AECEF5C03DC2EA78711F55EDC6A23A1734EB2A2D66C`.
- Build Android berhasil dan seluruh 369 tes lulus. Tidak memerlukan SQL.
- Commit implementasi dan APK: `a8e4a1d` (`fix: preserve activity on scanner reconnect`).
- Cloudflare berhasil diterbitkan dengan Version ID `009914a4-12cb-471c-a947-51c94f39af70`.
- URL publik `https://app.nusapos.my.id/downloads/Kasir-Nusa-POS-1.4.4.apk` telah diverifikasi: 2.830.245 byte dan SHA-256 cocok dengan APK lokal.

## Draft penerimaan aman saat staf berpindah ke Kasir

- Menu Terima Barang tidak lagi kembali paksa ke langkah Dokumen; langkah, barang, jumlah, modal, batch, EXP, dan usulan harga dipertahankan.
- Draft disimpan otomatis di perangkat dengan kunci terisolasi per user dan outlet, termasuk saat aplikasi disembunyikan, logout, atau dimuat ulang.
- Draft tidak mengubah stok. Draft hanya dibersihkan setelah penerimaan/pengajuan berhasil, atau lewat tombol Batalkan draft dengan konfirmasi.
- Pergantian sumber/PO yang dapat membuang pemeriksaan meminta konfirmasi. Kegagalan local storage ditampilkan sebagai peringatan dan tidak diklaim sudah tersimpan.
- Shell PWA dinaikkan ke v205. Seluruh 373 tes lulus; dry-run Cloudflare berhasil. Tidak membutuhkan SQL atau APK baru.
- Commit implementasi: `6b2985a`. Cloudflare Version ID: `ee02176c-be82-4600-a7d3-9f3982c01883`; domain produksi telah diverifikasi menyajikan shell v205 dan modul draft.

## Kategori kanonis pada seluruh jalur pembuatan barang

- Form Tambah/Edit Produk dan Barang Baru dari Restok sekarang memakai dropdown kategori katalog, bukan input teks bebas.
- Import Produk Baru dan Migrasi Kaspin divalidasi terhadap kategori yang sudah tersedia; template produk membawa sheet `Pilihan Kategori`.
- Perbedaan kapital dan spasi otomatis memakai label kategori kanonis yang sudah ada. Kategori asing ditolak server sebelum produk/draft approval ditulis.
- Guard mencakup create/edit produk, preview/commit import, Kaspin, serta barang baru melalui persetujuan restok. `Lainnya` tetap tersedia sebagai fallback sistem.
- Shell PWA dinaikkan ke v206. Seluruh 376 tes dan dry-run Cloudflare lulus. Tidak membutuhkan SQL atau APK baru.
- Commit implementasi: `01e9a71`. Cloudflare Version ID: `b8a203ba-6cfc-48f7-b3b3-afdde861abd0`; domain produksi telah diverifikasi menampilkan kedua dropdown dan modul kategori kanonis.

## Izin staff untuk menyimpan perubahan produk

- Akar masalah: API menerima `catalog.manage`, tetapi rantai `save_product_v6 -> v5 -> v3 -> v2` berakhir pada pemeriksaan database lama yang hanya menerima role Owner/Admin.
- Migrasi `202608070001_catalog_manage_product_permissions.sql` menyelaraskan simpan/edit dan perubahan status produk dengan izin granular `catalog.manage`.
- Manager tanpa override memakai izin bawaan; staff dengan daftar izin khusus wajib memiliki `catalog.manage`; akun tanpa izin tetap ditolak. Hapus produk massal tetap Owner/Admin.
- Seluruh 378 tes lulus. Commit: `57d0ed6`.
- Migrasi SQL telah berhasil dijalankan di Supabase pada 2026-08-07; perbaikan aktif di produksi. Tidak memerlukan APK atau deploy Cloudflare.

## Audit izin granular lintas role (2026-08-08)

- Ditemukan pola lama pemeriksaan jabatan tetap pada fungsi database meskipun UI/API sudah memakai `custom_permissions`; laporan awal terjadi pada `sale.adjust`.
- Migrasi `202608080001_align_granular_permissions.sql` menambahkan satu pemeriksa izin efektif yang mengikuti API dan menyelaraskan jalur diskon/harga manual, retur penjualan, promo, laporan, persetujuan, jadwal staf, transfer antar-outlet, pembelian/restok, pembayaran supplier/pelanggan, serta void penjualan.
- Hak Owner yang sengaja sensitif tetap tidak diperluas: hapus produk massal, impor penuh, reset/restore data, keuangan Owner, jurnal manual, dan persetujuan akhir PO bernilai besar.
- Pengujian penuh: 381 lulus. Migrasi SQL ini masih harus dijalankan di Supabase agar aktif di produksi; tidak memerlukan APK atau deploy Cloudflare.
