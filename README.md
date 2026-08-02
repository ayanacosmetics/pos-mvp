# Kasir Nusa POS — Header & Footer Struk v2.6.3

Kasir Nusa adalah sistem POS dan backoffice orisinal untuk toko kosmetik serta toko campuran yang melayani penjualan ecer dan grosir.

Produksi menggunakan:

- Cloudflare Workers untuk aplikasi web/PWA dan API; Vercel dipertahankan sementara sebagai jalur cadangan.
- Supabase untuk login, database PostgreSQL, transaksi atomik, dan audit.
- Aplikasi Android native untuk kasir; PWA untuk owner di iOS dan backoffice.
- Pada ponsel, katalog dan keranjang Kasir berada di layar terpisah; tablet dan
  desktop tetap menampilkan keduanya berdampingan.
- Tombol Sinkronkan Data berada di bagian paling atas sidebar. Tombol mengambil
  ulang perubahan dari perangkat lain dan menampilkan tanggal serta waktu
  sinkron terakhir untuk akun dan outlet aktif.
- Owner dapat membuat tipe pelanggan seperti Member, Grosir, atau Reseller.
  Tipe tersebut otomatis menjadi pilihan harga pada setiap produk dan pilihan
  tipe pada data pelanggan; harga umum dipakai sebagai fallback jika harga
  khusus produk belum diisi.
- Struk pelanggan umum tidak mencetak identitas pelanggan. Struk pelanggan
  terdaftar hanya mencetak nama pelanggan, sedangkan tipe harga non-umum
  dicetak pada setiap baris barang sebagai `Harga Member`, `Harga Grosir`, dan
  seterusnya.
- Owner dapat mengatur desain struk dari `Sistem → Desain struk`: memasukkan
  logo, melihat pratinjau langsung, mengubah posisi dan kerapatan, serta memilih
  informasi yang dicetak. Desain yang sama berlaku ke seluruh kasir.
- Logo struk dan foto produk dapat dipilih langsung dari galeri atau kamera.
  Foto produk diperkecil otomatis dan disimpan di media storage agar katalog
  ribuan produk tidak terbebani data gambar mentah.
- Lebar kertas 58 mm atau 80 mm dapat dipilih langsung dari editor desain
  struk dan disimpan khusus untuk printer pada perangkat tersebut.
- Keterangan header/footer dapat ditulis beberapa baris. Label kontak dapat
  diganti bebas, misalnya dari `Tel.` menjadi `WA`, `HP`, atau istilah toko.
- Owner mengatur hak akses setiap akun Staff/Admin melalui checklist fitur.
  Harga manual dan void hanya tersedia bagi akun yang diberi izin, tanpa
  membagikan atau memasukkan sandi Owner.
- Riwayat struk berada di Analitik → Transaksi bersama ringkasan pendapatan,
  keuntungan, retur, jumlah transaksi, serta tren harian untuk periode harian,
  mingguan, bulanan, atau rentang tanggal khusus.

Alamat produksi: <https://kasir-nusa-pos.vercel.app/>

Konteks lintas-task, keputusan produk, status rilis, dan roadmap menuju
kapabilitas retail yang lebih lengkap tersedia di
[`PROJECT-HANDOFF.md`](PROJECT-HANDOFF.md).

## Cakupan kandidat final

- Login persisten, peran kerja, hak akses, dan penempatan outlet.
- Halaman login menyediakan pendaftaran mandiri khusus Owner. Pendaftaran
  membuat ruang usaha, outlet utama, toko, gudang, pelanggan umum, kategori
  biaya, serta akun akuntansi dasar. Akun Staff tetap hanya dibuat oleh Owner
  melalui menu Kelola Staff setelah masuk.
- Owner dapat mengganti konteks ke Owner aktif lain dalam usaha yang sama tanpa
  login ulang; pergantian diaudit dan berakhir saat logout.
- Produk, varian, SKU, barcode, kategori, merek, foto, dan status aktif.
- Label rak/barcode Code 128 dapat dicetak massal dari produk terpilih, dengan
  ukuran bebas dalam milimeter (default 33×15 mm), pratinjau langsung, serta
  opsi nama, SKU, dan Harga Umum.
- Editor label menyediakan EAN-13, EAN-8, Code 128, mode barcode saja, sumber
  barcode/SKU, jumlah kolom dan baris, ukuran teks/barcode, posisi, dan perataan.
- Jumlah label dapat diisi per barang atau mengikuti stok outlet aktif. Lebar
  modul fisik dan garis SVG tajam menjaga barcode kecil tidak tampak menyatu.
- Daftar barang pada Kasir, Pilih Barang Restok, dan Daftar Stok memakai baris
  kompak memanjang: foto di kiri, identitas di tengah, serta harga dan stok di
  kanan. Barang tanpa foto memakai placeholder otomatis.
- Satuan pcs, lusin, karton, serta konversi ke satuan dasar.
- Harga ecer, harga pelanggan grosir, dan harga bertingkat berdasarkan jumlah.
- Promo terversi, terjadwal, konsisten online/offline, simulasi, dan batas pemakaian.
- Poin pelanggan, tier otomatis, histori mutasi, segmentasi, dan dashboard CRM.
- Voucher berkode dengan masa berlaku, minimal belanja, kuota total/per member,
  satu kali pakai, outlet, serta segmen ulang tahun/aktif/tidak aktif/nilai tinggi.
- Struk WhatsApp hanya tersedia untuk pelanggan yang memberi persetujuan dan
  hanya dibuka setelah kasir menekan tombol.
- POS, tahan transaksi, pembayaran tunai/non-tunai/split, piutang, dan struk.
- Keranjang menyediakan tombol Uang Pas. Dialog pembayaran tunai memiliki
  keypad angka layar sentuh, hapus angka, saran pecahan praktis, serta
  perhitungan kembalian langsung; transaksi tetap membutuhkan konfirmasi akhir.
- Produk dengan beberapa satuan membuka pilihan pcs/lusin/dus saat kartu
  ditekan. Scan barcode satuan besar memilih satuan tersebut langsung; scan
  barcode dasar membuka pilihan hanya bila satuan lain belum mempunyai
  barcode. Satuan juga dapat diganti langsung dari keranjang.
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
- Penerimaan restok memakai empat layar terpandu: Dokumen, Barang, Periksa,
  dan Histori. Tombol Kembali/Lanjut menjaga isian yang sudah dibuat serta
  memvalidasi faktur dan barang sebelum pengguna berpindah langkah.
- Pada mobile, langkah Periksa menyediakan tombol Terima dan tambah stok di
  footer. Pesan gagal tampil permanen di kartu dan sebagai toast di atas
  footer sehingga tidak tertutup tombol navigasi.
- Sidebar Restok menyatukan alur toko menjadi Pilih barang, Pesanan supplier,
  Terima barang, dan Retur supplier. Produk diurutkan dari stok paling sedikit;
  jumlah pesanan dapat diubah langsung, lalu surat pesanan dapat dicetak,
  disimpan sebagai PDF, atau dibagikan dengan penanda bukan bukti pembayaran.
- Semua produk dapat langsung dicentang tanpa mengatur kebijakan restok atau
  supplier utama terlebih dahulu. Supplier tujuan dipilih satu kali untuk
  seluruh surat pesanan; bila hanya ada satu supplier, sistem memilihnya
  otomatis.
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
- Impor data awal, backup ber-checksum, reset selektif, pemulihan atomik dengan simulasi dan OTP Owner, sinkronisasi offline, serta resolusi konflik.
- Pusat kesehatan untuk rekonsiliasi stok, pembayaran, piutang, hutang, shift, dan sinkronisasi.
- Aplikasi kasir Android terhubung langsung ke printer ESC/POS Bluetooth Classic
  SPP tanpa kabel, bridge berbayar, atau langganan. Scanner Bluetooth HID
  diteruskan langsung ke halaman kasir.
- PWA tetap tersedia bagi owner di iOS dan penggunaan backoffice.
- Navigasi accordion: menekan kelompok di sidebar membuka daftar subfitur
  memanjang tepat di bawah kelompok tersebut, tanpa panel atau halaman menu
  tambahan.
- Sistem desain Nusa Commerce menyatukan login, sidebar, POS, form, tabel,
  laporan, dialog, dan tampilan mobile dalam hierarki visual profesional.
  Ikon memakai SVG lokal, tidak ada font atau aset UI eksternal, dan seluruh
  alur bisnis v2.1 tetap dipertahankan.
- Pusat pilot khusus Owner dengan lima halaman terpisah: kesiapan, insiden,
  performa, pemulihan, dan SOP.
- Checklist pilot 25 langkah, keputusan lanjut/tunda berbasis bukti, pemantauan
  error/performa tanpa isi transaksi, serta pencatatan uji pemulihan backup
  tanpa menimpa data produksi.
- Akuntansi debit-kredit khusus Owner dengan daftar akun, jurnal umum, buku
  besar, neraca saldo, neraca, dan periode/tutup buku pada halaman terpisah.
- Penjualan, void, retur pelanggan, penerimaan pembelian, pembayaran
  hutang/piutang, retur supplier, serta biaya outlet disinkronkan ke jurnal
  secara idempoten. Jurnal manual wajib seimbang dan pembatalan memakai jurnal
  pembalik tanpa menghapus histori.
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

Untuk kandidat v2.1, jalankan satu file
`supabase/migrations/202607270033_core_accounting.sql` sebelum deployment.
Migrasi ini menambahkan daftar akun, periode, jurnal berimbang, sinkronisasi
transaksi operasional, buku besar, neraca saldo, dan neraca. Setelah live,
Owner perlu membuat jurnal saldo awal untuk modal/persediaan yang berasal dari
masa sebelum Kasir Nusa. Jangan deploy source v2.1 sebelum migrasi berhasil.

Untuk hotfix penerimaan v2.3.3, jalankan satu file
`supabase/migrations/202607270034_supplier_bill_trigger_receipt_id_fix.sql`.
Migrasi ini mengganti trigger hutang supplier yang salah membaca
`OLD.receipt_id` ketika penerimaan barang diproses.

Untuk rilis v2.4.5, jalankan satu file
`supabase/migrations/202607270035_owner_self_registration.sql` sebelum
deployment. Migrasi ini menyediakan pembuatan ruang usaha Owner secara atomik
dan hanya dapat dijalankan service role. Jangan deploy halaman daftar Owner
sebelum migrasi berhasil.

Untuk rilis v2.4.6, jalankan satu file
`supabase/migrations/202607270036_product_images.sql` sebelum deployment.
Migrasi ini menambahkan URL foto produk dan transaksi penyimpanan produk v3.
Jangan deploy source v2.4.6 sebelum migrasi berhasil.

Untuk rilis v2.16.18, jalankan
`supabase/migrations/202607290044_stock_management_fifo_cost.sql` sebelum
deployment. Migrasi ini menambahkan penyesuaian stok per barang, log alokasi
batch, HPP penjualan sesuai FEFO/FIFO, dan pemulihan lapisan modal saat void.

Klik dua kali `Deploy-Kasir-Nusa.cmd` dan tunggu sampai muncul tulisan **Deployment berhasil**.

Rahasia Supabase hanya boleh tersimpan sebagai secret Cloudflare Worker (dan Environment Variables Vercel selama masih menjadi cadangan). Jangan menaruh `SUPABASE_SERVICE_ROLE_KEY` di browser, screenshot, chat, atau repository.

## Pengujian

Jalankan:

```powershell
npm test
```

Source saat ini memiliki 322 pengujian otomatis. Pengujian toko nyata tetap
harus mengikuti `GO-LIVE-CHECKLIST.md`; keputusan lulus pilot tidak menggantikan
verifikasi printer, scanner, jaringan, dan alur kas pada perangkat toko.

## Aplikasi kasir Android

APK produksi dapat diunduh dari
<https://app.nusapos.my.id/downloads/Kasir-Nusa-POS-1.3.0.apk>.
Printer dihubungkan dari halaman Perangkat. Scanner dipasangkan sebagai
keyboard/HID melalui Pengaturan Bluetooth Android, bukan dari aplikasi. Setelah
tersambung, barcode diteruskan otomatis ke halaman Kasir dan scanner sebaiknya
mengirim Enter setelah barcode. APK produksi v1.3.0 memiliki SHA-256
`195EA34F080AD974088FE11C369926040D1B5DD5D937D7AE26DE694117AD7B27` dan
ditandatangani kunci permanen Kasir Nusa. Seluruh pembaruan berikutnya wajib
memakai kunci yang sama. APK `1.3.0-uat` tetap hanya untuk pengujian internal.

## Struktur

```text
api/                  API Cloudflare Worker dan fallback Vercel
apps/web/             Antarmuka POS dan backoffice PWA
apps/android-cashier/ Aplikasi kasir Android, printer SPP, scanner HID
apps/api/             Server demo lokal
packages/domain/      Mesin harga, promo, akses, dan data contoh
supabase/migrations/  Fondasi database produksi
test/                 Pengujian otomatis
```
