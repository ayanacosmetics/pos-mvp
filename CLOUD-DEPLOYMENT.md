# Operasional Produksi — Supabase dan Vercel

## Arsitektur

```text
Android PWA / Windows PWA / Browser
                  |
              HTTPS /api
                  |
          Vercel Functions
    validasi sesi, akses, dan transaksi
                  |
         Supabase PostgreSQL
      Auth, data, jurnal, dan audit
```

Browser tidak menerima `SUPABASE_SERVICE_ROLE_KEY`. Semua operasi sensitif berjalan melalui API Vercel dan fungsi database yang memeriksa tenant, pengguna, outlet, peran, serta idempotensi.

## Variabel produksi

Variabel berikut harus tersimpan sebagai secret Cloudflare Worker. Nilainya tetap
disimpan di Vercel selama masa migrasi dan fallback:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
ALLOW_OWNER_BOOTSTRAP
DEFAULT_BUSINESS_NAME
```

Setelah akun Owner pertama berhasil dibuat, nilai berikut wajib dipakai:

```text
ALLOW_OWNER_BOOTSTRAP=false
```

## Database

Database produksi memakai seluruh migrasi bernomor `001` sampai `022` di folder `supabase/migrations`.

Jangan menjalankan ulang migrasi secara acak pada proyek lain. Untuk pemulihan atau pemasangan baru, jalankan berurutan berdasarkan nama berkas dan gunakan proyek staging terlebih dahulu.

## Keamanan minimum

- Aktifkan MFA pada Supabase, Vercel, dan akun penyedia Git.
- Jangan mengirim kunci rahasia melalui chat, WhatsApp, email, atau screenshot.
- Gunakan akun berbeda untuk Owner, kasir, pembelian, dan gudang.
- Nonaktifkan akun karyawan yang sudah tidak bekerja.
- Periksa menu **Pengaturan → Kesehatan Sistem** secara berkala.
- Unduh backup operasional dan verifikasi checksum-nya.
- Jangan memakai akun Owner untuk transaksi kasir harian.

## Deployment Cloudflare

Deployment pertama memakai alamat staging `*.workers.dev`. Jangan hubungkan
`nusapos.my.id` sebelum health check, login, transaksi uji, laporan, dan batas CPU
selesai diperiksa.

```powershell
npm run check:cloudflare
npm run deploy:cloudflare
```

Secret wajib diatur melalui dashboard Cloudflare atau `wrangler secret put` dan
tidak boleh ditulis di `wrangler.jsonc`:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

`PUBLIC_APP_URL`, `ALLOW_OWNER_BOOTSTRAP=false`, dan nama usaha non-rahasia berada
di `wrangler.jsonc`.

## Deployment Vercel cadangan

Selama migrasi, `Deploy-Kasir-Nusa.cmd` tetap dapat dipakai. Setelah deployment:

1. Pastikan `/api/health` menunjukkan versi yang baru.
2. Muat ulang aplikasi satu kali agar service worker memperbarui cache.
3. Login sebagai Owner dan periksa Kesehatan Sistem.
4. Uji satu transaksi kecil sebelum membuka operasional penuh.

## Pemulihan

Backup Kasir Nusa adalah snapshot operasional ber-checksum, bukan pengganti backup database terkelola. Gunakan backup Supabase/PITR sesuai paket yang dipilih untuk pemulihan database penuh.

Jika aplikasi tidak dapat diakses:

1. Jangan menghapus data atau menjalankan SQL perbaikan tanpa diagnosis.
2. Simpan screenshot pesan kesalahan dan waktu kejadian.
3. Periksa status deployment Vercel serta Kesehatan Sistem.
4. Hentikan transaksi ganda pada banyak perangkat sampai koneksi stabil.
