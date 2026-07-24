# Kasir Nusa POS — Paket Operasional v1.20

Kasir Nusa adalah sistem POS dan backoffice orisinal untuk toko kosmetik serta toko campuran yang melayani penjualan ecer dan grosir.

Produksi menggunakan:

- Vercel untuk aplikasi web/PWA dan API.
- Supabase untuk login, database PostgreSQL, transaksi atomik, dan audit.
- PWA untuk penggunaan sebagai aplikasi Android dan Windows.

Alamat produksi: <https://kasir-nusa-pos.vercel.app/>

## Cakupan kandidat final

- Login persisten, peran kerja, hak akses, dan penempatan outlet.
- Produk, varian, SKU, barcode, kategori, merek, dan status aktif.
- Satuan pcs, lusin, karton, serta konversi ke satuan dasar.
- Harga ecer, harga pelanggan grosir, dan harga bertingkat berdasarkan jumlah.
- Promo terversi, terjadwal, konsisten online/offline, simulasi, dan batas pemakaian.
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
- Histori modal per supplier dan batch, perbandingan supplier, serta indikator kenaikan.
- Stok per outlet/gudang, transfer, opname, jurnal, batch, EXP, dan FEFO.
- Retur pelanggan dan supplier dengan dampak stok serta keuangan.
- Shift kasir, kas masuk/keluar, kas harapan, dan selisih penutupan.
- Laporan penjualan, laba, stok, pembelian, outlet, produk, supplier, dan audit.
- Impor data awal, backup ber-checksum, sinkronisasi offline, dan resolusi konflik.
- Pusat kesehatan untuk rekonsiliasi stok, pembayaran, piutang, hutang, shift, dan sinkronisasi.
- Instalasi PWA dengan identitas aplikasi untuk Android dan Windows.

## Menjalankan versi lokal

Klik dua kali `Mulai-Kasir-Nusa.cmd`, lalu buka <http://localhost:4173>.

Akun demo lokal:

- Owner: `owner@demo.local` / `owner123`
- Kasir: `kasir@demo.local` / `kasir123`
- Pembelian: `beli@demo.local` / `beli123`

Data lokal hanya untuk demonstrasi. Data produksi tersimpan di Supabase.

## Deployment produksi

Klik dua kali `Deploy-Kasir-Nusa.cmd` dan tunggu sampai muncul tulisan **Deployment berhasil**.

Rahasia Supabase hanya boleh tersimpan di pengaturan Environment Variables Vercel. Jangan menaruh `SUPABASE_SERVICE_ROLE_KEY` di browser, screenshot, chat, atau repository.

## Pengujian

Jalankan:

```powershell
npm test
```

Paket operasional v1.20 memiliki 95 pengujian otomatis. Pengujian toko nyata tetap harus mengikuti `GO-LIVE-CHECKLIST.md`.

## Struktur

```text
api/                  API produksi Vercel
apps/web/             Antarmuka POS dan backoffice PWA
apps/api/             Server demo lokal
packages/domain/      Mesin harga, promo, akses, dan data contoh
supabase/migrations/  Fondasi database produksi
test/                 Pengujian otomatis
```
