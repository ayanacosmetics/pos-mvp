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
