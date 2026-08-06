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

## Masalah aktif berikutnya

APK Android 1.4.0 belum dapat memberikan lokasi ke absensi.

Diagnosis yang sudah dipastikan:

- `apps/android-cashier/app/src/main/AndroidManifest.xml` belum memiliki `ACCESS_FINE_LOCATION` dan `ACCESS_COARSE_LOCATION`.
- `MainActivity.java` sudah menangani kamera, notifikasi, dan Bluetooth, tetapi belum menangani callback geolokasi WebView (`onGeolocationPermissionsShowPrompt`) serta izin lokasi runtime Android.
- Perbaikan ini tidak cukup melalui deploy web; wajib membuat APK pembaruan.

## Pekerjaan yang harus dilanjutkan

1. Tambahkan izin lokasi kasar dan presisi pada manifest.
2. Tambahkan alur izin runtime yang dipicu ketika halaman absensi meminta lokasi, bukan meminta izin tanpa konteks saat aplikasi dibuka.
3. Teruskan keputusan izin ke WebView dengan aman, hanya untuk origin resmi `https://app.nusapos.my.id`.
4. Jika izin ditolak, kembalikan kegagalan dengan bersih dan biarkan aplikasi memberi petunjuk membuka Pengaturan Android.
5. Pertahankan kamera, Bluetooth printer, scanner HID, Firebase/FCM, package `app.kasirnusa.cashier`, dan kunci penandatanganan yang sama.
6. Naikkan APK menjadi versi `1.4.1` dengan versionCode berikutnya.
7. Tambahkan/perbarui tes Android untuk manifest, runtime permission, pembatasan origin, dan identitas pembaruan.
8. Jalankan seluruh tes, build APK release dengan kunci permanen yang sama, salin ke lokasi unduhan resmi, perbarui referensi versi/checksum, commit, push, lalu deploy web bila halaman unduhan berubah.
9. Pastikan APK baru dapat dipasang langsung di atas 1.4.0 tanpa uninstall.

Tidak perlu SQL untuk perbaikan izin lokasi APK.

## Solusi sementara operasional

Sampai APK 1.4.1 terpasang, staff dapat absen melalui Chrome di `https://app.nusapos.my.id`, mengizinkan kamera dan lokasi presisi, serta memastikan GPS aktif.
