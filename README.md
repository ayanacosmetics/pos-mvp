# Kasir Nusa POS — Kandidat Pilot & Hardening v2.0.0

Kasir Nusa adalah sistem POS dan backoffice orisinal untuk toko kosmetik serta toko campuran yang melayani penjualan ecer dan grosir.

Produksi menggunakan:

- Vercel untuk aplikasi web/PWA dan API.
- Supabase untuk login, database PostgreSQL, transaksi atomik, dan audit.
- Aplikasi Android native untuk kasir; PWA untuk owner di iOS dan backoffice.

Alamat produksi: <https://kasir-nusa-pos.vercel.app/>

Konteks lintas-task, keputusan produk, status rilis, dan roadmap menuju
kapabilitas retail yang lebih lengkap tersedia di
[`PROJECT-HANDOFF.md`](PROJECT-HANDOFF.md).

## Cakupan kandidat final

- Login persisten, peran kerja, hak akses, dan penempatan outlet.
- Owner dapat mengganti konteks ke Owner aktif lain dalam usaha yang sama tanpa
  login ulang; pergantian diaudit dan berakhir saat logout.
- Produk, varian, SKU, barcode, kategori, merek, dan status aktif.
- Satuan pcs, lusin, karton, serta konversi ke satuan dasar.
- Harga ecer, harga pelanggan grosir, dan harga bertingkat berdasarkan jumlah.
- Promo terversi, terjadwal, konsisten online/offline, simulasi, dan batas pemakaian.
- Poin pelanggan, tier otomatis, histori mutasi, segmentasi, dan dashboard CRM.
- Voucher berkode dengan masa berlaku, minimal belanja, kuota total/per member,
  satu kali pakai, outlet, serta segmen ulang tahun/aktif/tidak aktif/nilai tinggi.
- Struk WhatsApp hanya tersedia untuk pelanggan yang memberi persetujuan dan
  hanya dibuka setelah kasir menekan tombol.
- POS, tahan transaksi, pembayaran tunai/non-tunai/split, piutang, dan struk.
- Transaksi baru selalu dimulai sebagai pelanggan umum; member dipilih secara sadar.
- Member baru dapat dibuat langsung dari halaman kasir tanpa meninggalkan keranjang.
- Stok kosong dan jumlah melebihi stok diblokir pada kartu, scan, dan keranjang.
- Diskon manual per item mendukung persen maupun nominal Rupiah.
- Promo nominal total mendukung berlaku sekali atau kelipatan syarat.
- Kamera barcode tersedia sebagai cadangan scanner serta saran harga jual mempertahankan laba lama.
- Harga jual manual naik/turun dengan persetujuan Owner/Admin dan jejak audit.
- Pencarian pelanggan menurut nama/telepon serta pemilihan barang tanpa jeda.
- Pelanggan, fasilitas kredit, umur piutang, pembayaran, dan retur kredit.
- Supplier, Purchase Order, penerimaan/restok, hutang, dan pembayaran supplier.
- Rencana restok memakai minimum, maksimum, safety stock, lead time, rata-rata
  penjualan, stok tersedia, dan sisa PO yang belum datang.
- Draft PO dapat dibuat dari rekomendasi per supplier, dengan approval
  berdasarkan nominal serta penanda PO terlambat.
- Histori modal per supplier dan batch, perbandingan supplier, serta indikator kenaikan.
- Stok per outlet/gudang, transfer, opname, jurnal, batch, EXP, dan FEFO.
- Transfer antar-outlet bertahap: permintaan, persetujuan, pengiriman, stok
  dalam perjalanan, dan penerimaan tujuan.
- Harga khusus dan cakupan promo per outlet, konsolidasi owner, Manajer Outlet
  terbatas pada penempatannya, serta notifikasi stok kritis/selisih shift.
- Retur pelanggan dan supplier dengan dampak stok serta keuangan.
- Shift kasir, kas masuk/keluar, kas harapan, dan selisih penutupan.
- Laporan penjualan, laba, stok, pembelian, outlet, produk, supplier, dan audit.
- Impor data awal, backup ber-checksum, sinkronisasi offline, dan resolusi konflik.
- Pusat kesehatan untuk rekonsiliasi stok, pembayaran, piutang, hutang, shift, dan sinkronisasi.
- Aplikasi kasir Android terhubung langsung ke printer ESC/POS Bluetooth Classic
  SPP tanpa kabel, bridge berbayar, atau langganan. Scanner Bluetooth HID
  diteruskan langsung ke halaman kasir.
- PWA tetap tersedia bagi owner di iOS dan penggunaan backoffice.
- Navigasi accordion: menekan kelompok di sidebar membuka daftar subfitur
  memanjang tepat di bawah kelompok tersebut, tanpa panel atau halaman menu
  tambahan.
- Pusat pilot khusus Owner dengan lima halaman terpisah: kesiapan, insiden,
  performa, pemulihan, dan SOP.
- Checklist pilot 25 langkah, keputusan lanjut/tunda berbasis bukti, pemantauan
  error/performa tanpa isi transaksi, serta pencatatan uji pemulihan backup
  tanpa menimpa data produksi.
- Promo dan Loyalitas, serta Pelanggan dan Supplier, memiliki halaman terpisah;
  rincian Stok, Pembelian, Laporan, dan Pengaturan juga dipisahkan sebagai
  tujuan navigasi masing-masing.

## Menjalankan versi lokal

Klik dua kali `Mulai-Kasir-Nusa.cmd`, lalu buka <http://localhost:4173>.

Akun demo lokal:

- Owner: `owner@demo.local` / `owner123`
- Kasir: `kasir@demo.local` / `kasir123`
- Pembelian: `beli@demo.local` / `beli123`

Data lokal hanya untuk demonstrasi. Data produksi tersimpan di Supabase.

## Deployment produksi

Untuk rilis v1.21, jalankan migrasi
`supabase/migrations/202607260025_pos_speed_customer_service.sql` di Supabase
terlebih dahulu. Jangan deploy source v1.21 sebelum migrasi berhasil.

Hotfix v1.21.1 menambahkan pemulihan otomatis penghitung nomor struk. Terapkan
`supabase/migrations/202607260026_receipt_sequence_collision_fix.sql` untuk
menyelaraskan seluruh penghitung dan memasang perlindungan benturan di database.

Untuk kandidat v1.22, jalankan satu file
`supabase/migrations/202607260027_restock_purchase_planning.sql`. Migrasi ini
idempotent dan sudah menyertakan penguatan nomor struk v1.21 yang masih tertunda,
kemudian menambahkan kebijakan restok serta approval pembelian berdasarkan nilai.

Untuk kandidat v1.23, jalankan satu file
`supabase/migrations/202607260028_loyalty_crm_vouchers.sql` sebelum deployment.
Migrasi ini menambahkan tier member, poin, voucher, segmentasi CRM, posting
loyalitas atomik saat checkout, dan pembalikan saat void.

Untuk rilis v1.25, jalankan satu file
`supabase/migrations/202607270029_employee_operations.sql` sebelum deployment.
Migrasi ini menambahkan jadwal dan absensi, target serta komisi, approval
bertingkat, log aktivitas perangkat, dan rekonsiliasi shift per metode
pembayaran. Jangan deploy source v1.25 sebelum migrasi berhasil.

Untuk rilis v1.26, jalankan satu file
`supabase/migrations/202607270030_owner_accounting_analytics.sql` sebelum
deployment. Migrasi ini menambahkan kategori dan buku biaya outlet, laporan
laba-rugi operasional, arus kas, aging hutang/piutang, serta analitik produk.
Jangan deploy source v1.26 sebelum migrasi berhasil.

Untuk rilis v1.27, jalankan satu file
`supabase/migrations/202607270031_advanced_multi_outlet.sql` sebelum
deployment. Migrasi ini menambahkan workflow transfer bertahap, harga dan
cakupan promo outlet, role Manajer Outlet, serta notifikasi operasional.
Jangan deploy source v1.27 sebelum migrasi berhasil.

Untuk kandidat v2.0, jalankan satu file
`supabase/migrations/202607270032_pilot_production_hardening.sql` sebelum
deployment. Migrasi ini menambahkan periode dan checklist pilot, insiden,
telemetri operasional yang minim data, bukti uji pemulihan, serta pemeriksaan
pengaman stok/idempotensi. Jangan deploy source v2.0 sebelum migrasi berhasil.

Klik dua kali `Deploy-Kasir-Nusa.cmd` dan tunggu sampai muncul tulisan **Deployment berhasil**.

Rahasia Supabase hanya boleh tersimpan di pengaturan Environment Variables Vercel. Jangan menaruh `SUPABASE_SERVICE_ROLE_KEY` di browser, screenshot, chat, atau repository.

## Pengujian

Jalankan:

```powershell
npm test
```

Kandidat v2.0.0 memiliki 148 pengujian otomatis. Pengujian toko nyata tetap
harus mengikuti `GO-LIVE-CHECKLIST.md`; keputusan lulus pilot tidak menggantikan
verifikasi printer, scanner, jaringan, dan alur kas pada perangkat toko.

## Aplikasi kasir Android

Pasangkan printer WP58D dan scanner melalui Pengaturan Bluetooth Android.
Unduh dan instal APK dari
<https://kasir-nusa-pos.vercel.app/downloads/Kasir-Nusa-Kasir-1.0.0-test.apk>,
masuk dengan akun kasir, lalu cetak struk. Saat pertama mencetak, pilih WP58D
dari daftar perangkat yang sudah dipasangkan. Scanner Bluetooth harus berada
pada mode HID dan mengirim Enter setelah barcode.

## Struktur

```text
api/                  API produksi Vercel
apps/web/             Antarmuka POS dan backoffice PWA
apps/android-cashier/ Aplikasi kasir Android, printer SPP, dan scanner HID
apps/api/             Server demo lokal
packages/domain/      Mesin harga, promo, akses, dan data contoh
supabase/migrations/  Fondasi database produksi
test/                 Pengujian otomatis
```
