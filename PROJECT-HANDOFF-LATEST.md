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
