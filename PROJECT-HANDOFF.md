# Handoff Permanen — Kasir Nusa POS

Dokumen ini adalah sumber konteks utama untuk melanjutkan Kasir Nusa di task
Codex baru. Baca seluruh dokumen sebelum merencanakan atau mengubah proyek.

## 1. Tujuan produk

Kasir Nusa adalah POS dan backoffice orisinal untuk:

- toko kosmetik grosir dan ecer;
- toko campuran grosir dan ecer;
- operasional web backoffice, Android PWA, dan Windows PWA;
- beberapa outlet, toko, dan gudang.

Targetnya adalah mencapai kedalaman kapabilitas retail yang sekelas produk
seperti Olsera untuk kebutuhan usaha pengguna, bukan menyalin tampilan,
branding, atau alur Olsera secara identik.

Prinsip produk:

- cepat saat toko ramai;
- familiar untuk staf retail Indonesia;
- satu aturan harga dan promo untuk online maupun offline;
- stok dan keuangan dapat diaudit;
- fitur kompleks tetap mudah dipahami pengguna nonteknis.

## 2. Arsitektur yang telah dipilih

- Frontend: HTML, CSS, dan JavaScript PWA.
- Produksi: Vercel.
- Database dan autentikasi: Supabase/PostgreSQL.
- API produksi: Vercel Functions pada `api/index.mjs`.
- Demo lokal: Node.js dan SQLite pada `apps/api`.
- Mesin domain bersama: `packages/domain`.
- PWA digunakan untuk Android dan Windows terlebih dahulu.
- Laravel tidak digunakan. Keputusan ini disengaja agar tidak menambah
  backend kedua dan kompleksitas operasional yang belum diperlukan.

Produksi: <https://kasir-nusa-pos.vercel.app/>

Rahasia Supabase hanya boleh berada di environment variables. Jangan pernah
menaruh atau menampilkan `SUPABASE_SERVICE_ROLE_KEY` di browser, screenshot,
kode frontend, dokumentasi publik, atau chat.

## 3. Status rilis

### Terakhir dikonfirmasi live

- **Paket Operasional v1.21.2**
- SQL `202607260025_pos_speed_customer_service.sql` berhasil diterapkan pada
  Supabase sebelum deployment.
- Hotfix nomor struk memperbaiki `document_sequences` produksi dari tidak ada
  menjadi `next_value=5`, tepat setelah struk tertinggi `UTM-000004`.
- API kini mendeteksi benturan `sales_tenant_id_receipt_no_key`, menyelaraskan
  penghitung secara aman, lalu mencoba ulang RPC dengan idempotency key yang
  sama sehingga transaksi tidak tercatat ganda.
- Deployment Vercel `dpl_7tzqbzxjdyN3aL6rVp9m14QJ9Usy` berstatus Ready pada
  26 Juli 2026 dan alias `kasir-nusa-pos.vercel.app` sudah aktif.
- Verifikasi langsung produksi mengembalikan API `1.21.2-cloud`, aplikasi
  `v1.21.2`, cache `nusa-pos-shell-v41`, ZXing lokal, kebijakan `camera=(self)`,
  proteksi autentikasi riwayat POS, dan logout yang menghapus cookie refresh.
- Skema Supabase mengonfirmasi RPC `complete_sale_v6` dan `void_sale_v1`
  tersedia; verifikasi produksi tidak membuat transaksi nyata.
- Penyesuaian harga barang kini menjadi alur internal tersendiri dan hanya
  menetapkan harga jual akhir. Struk menampilkan harga akhir sebagai harga
  normal tanpa nominal, alasan, approver, atau label penyesuaian internal.
- Promo dan diskon pelanggan tetap dicantumkan tersendiri pada struk serta
  tidak digabung dengan penyesuaian harga internal.
- Validasi rilis mencakup 107 pengujian otomatis dan 5 pengujian browser
  tambahan; seluruhnya lulus.

SQL penguatan `202607260026_receipt_sequence_collision_fix.sql` sudah tersedia
untuk menyelaraskan semua outlet dan memasang trigger benturan di database.
Pembayaran produksi sudah pulih melalui perbaikan penghitung dan fallback API;
terapkan SQL tersebut sebelum melanjutkan paket database berikutnya.

### Isi rilis v1.21

- favorit produk per pengguna dan filter kategori cepat;
- shortcut pencarian, qty, tahan, bayar, cetak, dan riwayat;
- riwayat transaksi POS dengan pencarian serta cetak ulang;
- void transaksi sebelum shift ditutup dengan alasan, persetujuan Owner/Admin,
  pemulihan stok/modal atomik, penolakan transaksi piutang/sudah diretur,
  idempotensi, dan audit;
- catatan transaksi yang bertahan saat transaksi ditahan;
- catatan pelanggan yang terlihat secukupnya di POS dan riwayat;
- tombol lompat keranjang dan checkout sticky untuk penggunaan satu tangan.

UAT perangkat nyata Android/Windows tetap dilakukan mengikuti
`GO-LIVE-CHECKLIST.md`; hasil otomatis tidak boleh diklaim sebagai pengujian
perangkat keras fisik.

## 4. Kapabilitas yang sudah dibangun

### Identitas dan kontrol

- login Supabase yang persisten dan pemulihan sesi tanpa kilatan login;
- Owner, Admin, Kasir, Pembelian, dan Gudang;
- hak akses dan penempatan outlet;
- audit log dan pusat kesehatan sistem;
- identitas usaha, outlet, lokasi, perangkat, dan nomor struk.

### Produk, harga, dan promo

- produk, varian, SKU, kategori, merek, barcode, aktif/nonaktif;
- satuan pcs, lusin, karton, dan faktor ke satuan dasar;
- harga ecer, harga grosir/member, dan harga bertingkat;
- promo terversi dan terjadwal yang sama untuk online/offline;
- promo persen, nominal per pcs, nominal total, harga khusus, beli-gratis,
  bundling, batas penggunaan, prioritas, dan aturan gabung;
- promo nominal total dapat berlaku sekali atau kelipatan;
- harga jual manual naik/turun dengan persetujuan dan audit;
- diskon manual per item dalam persen atau Rupiah.

### POS dan pelanggan

- POS cepat dengan verifikasi harga server di belakang layar;
- scanner barcode, kamera barcode, dan fallback ZXing;
- blok produk stok kosong serta jumlah melebihi stok;
- transaksi dimulai sebagai pelanggan umum, bukan member otomatis;
- pencarian pelanggan berdasarkan nama, kode, atau telepon;
- tambah member langsung dari halaman kasir;
- tahan/lanjutkan transaksi;
- pembayaran tunai, QRIS, transfer, EDC, split payment, dan kembalian;
- struk dan instalasi PWA.

### Pembelian dan persediaan

- supplier dan Purchase Order draft, submit, approval, parsial, dan penuh;
- penerimaan/restok dengan pencarian dan scan;
- histori modal per supplier, dokumen, batch, dan tanggal;
- indikator kenaikan/penurunan modal;
- perbandingan supplier;
- saran harga ecer yang mempertahankan laba nominal sebelumnya;
- stok per outlet/gudang, jurnal stok, transfer, dan opname;
- batch, tanggal kedaluwarsa DD/MM/YYYY, FEFO, dan dashboard EXP;
- retur pelanggan dan retur supplier.

### Keuangan dan laporan

- shift kasir, modal awal, kas masuk/keluar, kas harapan, dan selisih;
- piutang pelanggan, plafon, jatuh tempo, umur piutang, dan pembayaran FIFO;
- hutang supplier, nota kredit retur, dan pembayaran FIFO;
- laporan penjualan, laba, retur, stok, pembelian, outlet, produk, dan supplier;
- impor data awal;
- backup ber-checksum dan verifikasi;
- sinkronisasi offline, idempotensi, dan penyelesaian konflik harga.

## 5. Keputusan perilaku yang tidak boleh berubah tanpa alasan kuat

- Jangan memilih member secara otomatis. Transaksi baru selalu pelanggan umum.
- Barang dengan stok nol tidak dapat masuk keranjang.
- Jumlah keranjang tidak boleh melampaui stok lokasi aktif.
- Promo nominal Rp8.000 dengan mode sekali tetap Rp8.000 walau qty bertambah.
- Mode kelipatan hanya berlaku bila secara eksplisit dipilih saat membuat promo.
- Harga jual saran tidak disimpan otomatis. Owner/Admin harus memeriksa dan
  menyimpan perubahan.
- Saran harga mempertahankan laba nominal lama. Contoh: modal lama Rp20.000,
  harga ecer Rp30.000, modal baru Rp22.000, saran harga Rp32.000.
- Tanggal kedaluwarsa yang dilihat pengguna memakai DD/MM/YYYY.
- Kasir tidak boleh melihat modal pembelian.
- Scanner fisik/Bluetooth dan scan kamera harus tersedia berdampingan bila ruang
  memungkinkan, dengan tombol ringkas pada mobile.

## 6. Cara bekerja yang diinginkan pengguna

Pengguna ingin menilai hasil setelah paket cukup matang, bukan mengarahkan setiap
detail terlalu dini. Hindari membuat update versi untuk perubahan sangat kecil.

Untuk setiap paket:

1. audit source dan tentukan lingkup;
2. implementasikan satu paket utuh;
3. jalankan tes domain, API, offline, dan UI yang relevan;
4. lakukan pemeriksaan mobile dan desktop;
5. bila database berubah, siapkan **satu** file SQL;
6. setelah SQL dikonfirmasi, minta **satu** deployment;
7. catat status live dan perubahan lokal di dokumen ini.

Jangan meminta pengguna menyetujui pembacaan file, pengecekan sintaks, atau tes
internal satu per satu. Pengguna hanya seharusnya menangani tindakan eksternal
yang memang diperlukan, terutama SQL Supabase dan deployment produksi.

## 7. Roadmap menuju kedalaman produk sekelas Olsera

Roadmap ini berdasarkan kebutuhan nyata usaha pengguna. Urutan dapat berubah
setelah UAT, tetapi task baru tidak boleh melewati fondasi yang belum stabil.

### v1.20.1 — Stabilitas mobile dan scanner (selesai)

- ikon scanner/kamera divalidasi di 360, 390, 430, 768 px dan desktop;
- drawer dapat dibuka, ditutup, memakai Escape, menjaga fokus, dan tidak
  menimpa isi;
- kamera berhenti ketika dialog ditutup atau halaman ditinggalkan;
- ZXing tersedia lokal dan masuk cache offline;
- alur input scanner dan lifecycle kamera diuji otomatis di Chromium;
- versi patch, cache PWA, tes, dan dokumentasi sudah diperbarui;
- satu deployment produksi tanpa SQL selesai pada 26 Juli 2026.

UAT kamera Android dan scanner/Chrome Windows pada perangkat fisik tetap menjadi
langkah operasional sebelum pemakaian toko, bukan pekerjaan source code.

### v1.21 — Kecepatan kasir dan layanan pelanggan (selesai)

- favorit/produk cepat dan filter kategori di POS;
- shortcut keyboard untuk pencarian, qty, tahan, bayar, dan cetak;
- riwayat transaksi terbaru dari POS;
- cari dan cetak ulang struk dengan hak akses;
- pembatalan/void transaksi yang benar, beralasan, disetujui, dan diaudit;
- catatan per transaksi dan catatan pelanggan yang terlihat secukupnya;
- pengujian penggunaan satu tangan pada mobile.

Status: migrasi utama, 107 pengujian otomatis, 5 pengujian browser, deployment
produksi, hotfix benturan nomor struk, dan privasi harga internal pada struk
selesai pada 26 Juli 2026. SQL penguatan
`202607260026_receipt_sequence_collision_fix.sql` menunggu diterapkan.

### v1.22 — Perencanaan restok dan pembelian

- minimum, maksimum, safety stock, dan lead time per produk/supplier;
- saran jumlah restok berdasarkan penjualan rata-rata dan stok tersedia;
- daftar barang perlu dipesan, stok nol paling atas, dan filter supplier;
- status PO terlambat dan sisa barang belum datang;
- perbandingan harga supplier lintas periode;
- draft PO dari rekomendasi restok;
- approval pembelian berdasarkan nilai.

### v1.23 — Loyalitas, CRM, dan promosi lanjutan

- poin pelanggan dan riwayat mutasi;
- level/member tier;
- voucher berkode dan masa berlaku;
- promo hari ulang tahun dan segmentasi pelanggan;
- kupon satu kali dan batas per outlet/pelanggan;
- kirim struk atau ringkasan transaksi melalui WhatsApp dengan persetujuan;
- dashboard pelanggan aktif, tidak aktif, dan nilai belanja.

### v1.24 — Operasional karyawan

- jadwal kerja dan absensi sederhana;
- target serta komisi sales/kasir;
- approval bertingkat untuk diskon, void, pembelian, dan opname;
- log aktivitas per pengguna dan perangkat;
- rekonsiliasi shift antar-metode pembayaran.

### v1.25 — Akuntansi dan analitik owner

- ringkasan laba rugi operasional;
- biaya outlet dan kategori biaya;
- arus kas serta proyeksi hutang/piutang;
- aging supplier dan pelanggan yang dapat ditindaklanjuti;
- dashboard tren, produk lambat/cepat, margin rendah, dan dead stock;
- ekspor yang siap diberikan kepada akuntan.

### v1.26 — Multi-outlet tingkat lanjut

- permintaan transfer dari cabang;
- approval dan penerimaan transfer;
- stok dalam perjalanan;
- harga dan promo per outlet;
- konsolidasi owner serta pembatasan manager outlet;
- notifikasi stok kritis dan aktivitas tidak wajar.

### v2.0 — Pilot produksi dan hardening

- UAT lengkap sesuai `GO-LIVE-CHECKLIST.md`;
- pilot satu outlet dan satu kasir selama 2–4 minggu;
- monitoring error dan performa;
- pengujian dua kasir menjual stok sama secara bersamaan;
- prosedur backup/restore yang benar-benar diuji;
- dokumentasi staf, onboarding, dan SOP gangguan internet;
- perbaikan temuan pilot sebelum ekspansi outlet.

### Fitur opsional, bukan prioritas otomatis

Fitur berikut hanya dibangun bila usaha memang membutuhkannya:

- integrasi marketplace dan omnichannel;
- toko online;
- payment gateway;
- akuntansi buku besar penuh;
- aplikasi native Play Store/Microsoft Store;
- API publik dan integrasi pihak ketiga.

Jangan mengejar jumlah fitur Olsera secara buta. Dahulukan alur yang mengurangi
waktu antre, mencegah salah harga, menjaga stok, dan membantu keputusan restok.

## 8. Definition of Done

Satu fitur belum dianggap selesai hanya karena tombolnya tampil. Minimal:

- aturan bisnis tertulis dan tidak ambigu;
- validasi frontend dan backend;
- transaksi database atomik untuk perubahan stok/uang;
- hak akses diuji;
- audit untuk tindakan sensitif;
- online/offline konsisten bila berlaku;
- mobile dan desktop rapi;
- tes otomatis lulus;
- SQL idempotent dan terversi bila ada;
- versi/cache/documentation diperbarui;
- status deployment dikonfirmasi pengguna.

## 9. Instruksi awal untuk task Codex baru

Gunakan prompt:

> Baca seluruh `outputs/pos-mvp/PROJECT-HANDOFF.md` dan lanjutkan dari status
> rilis yang tercatat. Jangan menebak status live. Kerjakan paket berikutnya
> secara utuh tanpa persetujuan teknis berulang, lalu berikan maksimal satu SQL
> dan satu deployment.

Task baru harus memeriksa source aktual dan menjalankan tes sebelum menyimpulkan
bahwa sebuah item roadmap sudah atau belum selesai.
