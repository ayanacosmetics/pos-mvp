# Handoff Permanen — Kasir Nusa POS

Dokumen ini adalah sumber konteks utama untuk melanjutkan Kasir Nusa di task
Codex baru. Baca seluruh dokumen sebelum merencanakan atau mengubah proyek.

## 1. Tujuan produk

Kasir Nusa adalah POS dan backoffice orisinal untuk:

- toko kosmetik grosir dan ecer;
- toko campuran grosir dan ecer;
- operasional web backoffice, aplikasi kasir Android, iOS PWA, dan Windows PWA;
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
- Aplikasi native Android digunakan khusus kasir agar Bluetooth Classic SPP dan
  scanner HID dapat diakses; owner tetap memakai PWA di iOS.
- Laravel tidak digunakan. Keputusan ini disengaja agar tidak menambah
  backend kedua dan kompleksitas operasional yang belum diperlukan.

Produksi: <https://kasir-nusa-pos.vercel.app/>

Rahasia Supabase hanya boleh berada di environment variables. Jangan pernah
menaruh atau menampilkan `SUPABASE_SERVICE_ROLE_KEY` di browser, screenshot,
kode frontend, dokumentasi publik, atau chat.

## 3. Status rilis

### Rilis v2.16.0 Editor Label Fleksibel

- Jenis barcode dapat dipilih: otomatis, EAN-13, EAN-8, Code 128 otomatis,
  Code 128B, atau Code 128C. Mode otomatis memprioritaskan EAN yang checksum-nya
  valid agar barcode retail 13 digit tidak lagi tampak seperti blok rapat.
- Sumber kode dapat memakai barcode satuan dasar atau SKU. Preset isi tersedia
  untuk nama-harga-barcode, barcode dengan angka, barcode saja, dan kustom.
- Pengguna dapat mengatur jumlah kolom dan baris per halaman, jumlah salinan,
  ukuran nama/harga/angka kode, tinggi barcode, posisi tulisan di atas/bawah,
  serta perataan kiri/tengah/kanan.
- Pratinjau langsung mengikuti ukuran halaman dan pengaturan. Jenis EAN yang
  dipaksakan tetapi tidak valid diblokir sebelum dialog cetak dibuka.
- Rilis memakai API `2.16.0-cloud`, aset/cache PWA `v111`, tanpa migrasi SQL.
- Seluruh 236 pengujian otomatis lulus. Produksi dan alias utama diverifikasi
  setelah deployment otomatis dari commit fitur.

### Rilis v2.15.1 Barcode Label Ringkas

- Barcode yang seluruhnya angka dan berjumlah digit genap otomatis memakai
  Code 128C, sehingga dua digit dikemas per simbol dan garis tidak terlalu
  rapat pada label kecil 33×15 mm.
- Barcode campuran huruf/angka tetap memakai Code 128B agar SKU dan kode khusus
  tetap dapat dicetak.
- Rilis memakai API `2.15.1-cloud`, aset/cache PWA `v110`, tanpa migrasi SQL.
- Seluruh 235 pengujian otomatis lulus dan produksi telah diverifikasi pada
  `kasir-nusa-pos.vercel.app`.

### Rilis v2.15.0 Label Produk

- Direktori Produk dapat mencetak label massal dari barang yang dicentang.
- Label memakai barcode Code 128 SVG lokal agar tetap tersedia offline. Barcode
  satuan dasar dipakai bila tersedia; SKU menjadi cadangan yang terlihat jelas.
- Kode angka dengan jumlah digit genap memakai Code 128C agar garis lebih
  renggang dan aman dipindai pada label kecil 33×15 mm.
- Pengguna dapat mengisi lebar dan tinggi label bebas dalam milimeter, dengan
  default 33×15 mm, jumlah salinan per barang, serta menampilkan/menyembunyikan
  nama, SKU, dan Harga Umum.
- Pratinjau langsung diperbesar tersedia sebelum dialog cetak browser dibuka. Isi cetak
  dibersihkan setelah selesai agar tidak mengganggu cetak struk berikutnya.
- Rilis memakai API `2.15.0-cloud`, aset/cache PWA `v109`, tanpa migrasi SQL.
- Seluruh 234 pengujian otomatis lulus. Commit fitur `6399b6b` sudah didorong
  ke `origin/main`.
- Deployment Vercel `dpl_7oojMMU6uwhW6c1uKGdVz2K6Yh9w` berstatus Ready dan
  alias `kasir-nusa-pos.vercel.app` aktif pada 29 Juli 2026.
- Verifikasi publik mengembalikan API `2.15.0-cloud`, aset/cache `v109`, serta
  modul label dengan ukuran default 33×15 mm.

### Rilis v2.14.1 Produk Massal Aman

- Halaman Import produk baru dan Edit produk massal memiliki alur terpisah.
  Import baru hanya menerima SKU baru, sedangkan edit massal mewajibkan SKU
  produk yang sudah ada.
- Keduanya memiliki tombol Kembali ke Produk dan petunjuk yang sesuai dengan
  alurnya masing-masing.
- Direktori Produk memiliki checkbox per barang, Pilih semua sesuai daftar yang
  sedang tampil, penghitung pilihan, dan aksi Hapus barang massal.
- Produk yang benar-benar belum digunakan dihapus permanen. Produk yang sudah
  memiliki stok atau riwayat diarsipkan, sedangkan produk pada PO aktif tidak
  diubah.
- API `2.14.1-cloud`, aset/cache PWA `v108`, migrasi SQL
  `202607290043_bulk_product_delete.sql`.
- Migrasi telah dijalankan dan rilis produksi telah diverifikasi pada 29 Juli
  2026 di `kasir-nusa-pos.vercel.app`.

### Rilis v2.14.0 Excel Produk Fleksibel

- Tombol Import produk baru, Export/edit produk, dan Tipe produk berada langsung
  di header halaman Produk, sejajar dengan Tambah produk manual.
- Template Barang hanya memakai satuan dasar; kolom satuan terbesar/kecil yang
  memaksakan dua satuan telah dihapus. File lama tetap kompatibel.
- Multi Satuan, Varian, dan Harga Pelanggan memakai workbook terpisah. Satu SKU
  dapat memiliki jumlah satuan dan tingkat harga yang tidak dibatasi dua baris.
- Varian adalah SKU mandiri yang dikelompokkan sehingga barcode, stok, modal,
  dan harga setiap varian tetap dapat berbeda.
- Harga pelanggan manual tidak ditimpa aturan harga aman otomatis pada tipe dan
  tingkat minimal pembelian yang sama.
- API `2.14.0-cloud`, aset/cache PWA `v107`, migrasi SQL
  `202607290042_product_extension_imports.sql`.
- Migrasi telah dijalankan dan rilis produksi telah diverifikasi pada 29 Juli
  2026 di `kasir-nusa-pos.vercel.app`.

### Rilis v2.13.2 Startup Cepat

- Cache katalog terakhir ditampilkan segera saat aplikasi dibuka, sementara
  validasi sesi dan sinkronisasi data terbaru berjalan di belakang.
- Katalog aktif langsung mengisi halaman Produk sehingga tidak lagi menampilkan
  nol palsu selama master produk lengkap belum selesai dimuat.
- Modul berat dimuat melalui antrean latar belakang maksimal tiga permintaan
  bersamaan, bukan ditunggu satu per satu pada startup.
- API `2.13.2-cloud` dan aset/cache PWA `v106`; tidak memerlukan SQL baru.

### Rilis v2.13.1 Refresh Sesi Permanen

- Access token diperbarui otomatis sebelum kedaluwarsa menggunakan refresh
  token permanen; permintaan pengguna tidak perlu gagal lebih dahulu.
- Respons Supabase `401/403` saat JWT tidak berlaku dinormalisasi sebagai sesi
  yang perlu diperbarui, lalu permintaan asli otomatis diulang satu kali.
- API `2.13.1-cloud` dan aset/cache PWA `v105`; tidak memerlukan SQL baru.

### Rilis v2.13.0 Excel Data Massal

- Halaman Import Data sekarang memakai workbook XLSX sederhana: sheet `Barang`
  dan `Panduan`; CSV lama tetap dapat dibaca.
- SKU/no. barang boleh kosong untuk produk baru dan dibuat otomatis berurutan.
  Reservasi SKU terikat idempotency key sehingga percobaan ulang tidak membuat
  barang ganda atau memakai nomor berbeda.
- Satu file dapat berisi sampai 10.000 baris dan API membaginya otomatis per
  500 baris; pengguna tidak perlu memecah file sendiri.
- Export barang memiliki filter kategori, merek, status, serta urutan SKU,
  barcode, nama, dan stok. File dapat diedit lalu diimpor kembali memakai SKU.
- Edit massal hanya mengganti Harga Umum dan data dasar; harga Member, Grosir,
  serta tingkat pelanggan lain tidak dihapus. Stok barang lama juga tidak dapat
  ditimpa melalui kolom stok awal.
- API `2.13.0-cloud`, aset/cache PWA `v104`, migrasi SQL
  `202607280041_excel_product_import.sql`.
- Migrasi SQL dikonfirmasi berhasil diterapkan pada 28 Juli 2026. Produksi
  `kasir-nusa-pos.vercel.app`, aset SheetJS, dan cache PWA telah diverifikasi;
  seluruh 225 pengujian otomatis lulus.

### Rilis v2.12.0 Harga Aman Otomatis

- Halaman Produk memiliki `Aturan harga massal` untuk membentuk harga Member,
  Grosir, dan tipe lain sebagai potongan dari Harga Umum.
- Pratinjau memakai modal rata-rata tertinggi seluruh outlet dan keuntungan
  minimum yang dapat diatur. Tingkat aman diterapkan, sedangkan tingkat BEP,
  rugi, di bawah keuntungan minimum, atau tanpa modal dilewati.
- Produk yang belum aman mendapat rekomendasi kenaikan Harga Umum minimum.
- Kebijakan tersimpan dan diterapkan ulang ketika Harga Umum, modal, atau impor
  produk berubah. Harga yang menjadi tidak aman otomatis tidak dipakai.
- API `2.12.0-cloud`, aset/cache PWA `v103` (hotfix validasi nominal potongan), migrasi SQL
  `202607280040_safe_customer_price_policy.sql`.

### Rilis v2.11.0 Harga Bertingkat per Tipe Pelanggan

- Editor produk tidak lagi memakai satu harga bertingkat global yang bercampur
  dengan seluruh tipe pelanggan.
- Harga Umum, Member, Grosir, dan tipe pelanggan lain memiliki daftar tingkat
  masing-masing: minimal 1 pcs selalu terlihat, lalu minimal 3/6/12 atau jumlah
  lain dapat ditambahkan dan dihapus sesuai kebutuhan.
- Harga minimal 1 untuk tipe khusus boleh kosong agar otomatis memakai harga
  Umum; tingkat harga yang diisi tetap diterapkan hanya pada tipe tersebut.
- Data lama tetap dapat dibuka. Tingkat global lama ditampilkan pada setiap tipe
  dan akan disimpan sebagai aturan eksplisit saat produk diperbarui.
- API `2.11.0-cloud`, aset/cache PWA `v101`, migrasi SQL
  `202607280039_customer_group_price_tiers.sql`.

### Rilis v2.10.3 Laporan Pembelian

- Laporan pembelian memakai halaman awal seperti laporan transaksi penjualan:
  pilihan hari ini, bulan ini, tahun ini, dan selama ini membuka rincian periode.
- Rincian menampilkan jumlah transaksi, total pembelian, qty diterima, jumlah
  supplier, pencarian, dan daftar struk penerimaan.
- Laporan pembelian dan riwayat pembelian lama digabung menjadi satu tujuan agar
  tidak ada menu ganda.
- Struk pembelian kini dibuka sebagai halaman penuh dengan tombol kembali dan
  cetak. Baris barang responsif di mobile tanpa tabel yang harus digeser.
- API `2.10.3-cloud`, aset/cache PWA `v100`, tanpa migrasi SQL baru.

### Rilis v2.10.2 Jurnal Arus Stok

- Arus stok tidak lagi mengakumulasi per produk. Setiap kejadian jurnal menjadi
  satu baris: pergerakan masuk mengisi Masuk dan nol pada Keluar, sedangkan
  pergerakan keluar mengisi Keluar dan nol pada Masuk.
- Nama barang menampilkan waktu kejadian dan urutan awal adalah yang terbaru.
- Nama lipatan `Laporan transaksi` diubah menjadi `Laporan penjualan` agar
  serasi dan tidak rancu dengan Laporan pembelian.
- API `2.10.2-cloud`, aset/cache PWA `v99`, tanpa migrasi SQL baru.

### Rilis v2.10.1 Laporan Kategori & Arus Stok

- Penjualan kategori memiliki filter staff/pembayaran bersama, periode Today,
  7 hari, bulan, tahun, seluruh waktu, dan khusus dalam satu baris yang dapat
  digeser pada layar sempit.
- Diagram kategori membandingkan pendapatan dan menampilkan keuntungan setiap
  kategori; daftar di bawahnya tetap memuat qty terjual, pendapatan, dan laba.
- Tombol urutkan laporan barang dipadatkan menjadi satu ikon dengan menu lipat.
- Arus stok memakai jurnal stok yang sudah ada, dengan pencarian, urutan,
  filter Today/Kemarin/Kustom, dan kolom Nama barang, Kode barang, Masuk, Keluar.
- Add-on tetap didefinisikan sebagai barang yang ikut terjual bersama barang
  lain dalam satu transaksi, tanpa menambah tipe produk atau migrasi SQL.
- API `2.10.1-cloud`, aset/cache PWA `v98`, tanpa migrasi SQL baru.

### Rilis v2.10.0 Laporan Transaksi

- Modul `Analitik` berganti nama menjadi `Laporan`.
- Lipatan `Laporan transaksi` berisi halaman terpisah untuk Transaksi,
  Penjualan barang, Penjualan kategori, Add-on, dan Arus stok.
- Penjualan barang menyediakan filter staff/pembayaran, urutan, pencarian,
  periode Today/Bulan/Tahun/Khusus, dashboard qty-pendapatan-keuntungan, foto
  barang, stok terjual, serta angka pendapatan dan keuntungan per barang.
- Kinerja produk lama tidak ditampilkan ganda; Kinerja outlet tetap tersedia.
- Kategori, add-on lintas barang dalam satu transaksi, dan arus stok memiliki
  halaman serta sumber data produksi sendiri.
- API `2.10.0-cloud`, aset/cache PWA `v97`, tanpa migrasi SQL baru.

### Rilis v2.9.7 Filter Penjualan

- Empat tombol metrik dipadatkan menjadi satu baris teks tanpa ikon.
- Laporan penjualan memakai filter lipat staff, status lunas/piutang, urutan,
  metode Tunai/QRIS/Transfer/EDC/Piutang/Multipayment, dan dasar pengakuan
  pendapatan serta keuntungan.
- Keuntungan sebelum piutang dibayar aktif secara default; pendapatan sebelum
  piutang dibayar tidak aktif. Pelunasan piutang yang sudah diterima tetap
  masuk ke pendapatan berbasis kas.
- Filter tanggal manual disembunyikan dari laporan penjualan karena periode
  dipilih dari menu hari, bulan, tahun, atau seluruh waktu.
- API `2.9.7-cloud`, aset/cache PWA `v96`, 214 pengujian otomatis, tanpa SQL.

### Rilis v2.9.6 Laporan Penjualan Ringkas dikonfirmasi live

- Halaman awal laporan penjualan hanya menampilkan pilihan hari, bulan, tahun,
  dan seluruh waktu; pilihan membuka halaman rincian bertingkat.
- Empat tombol metrik mengganti satu panel nilai bersama untuk jumlah transaksi,
  pendapatan, keuntungan, dan retur pelanggan.
- Riwayat harian menampilkan nomor struk, waktu, pendapatan, serta keuntungan;
  angka retur dan void ikut dihitung dengan benar.
- API `2.9.6-cloud`, aset/cache PWA `v95`, dan 213 pengujian otomatis lulus.
- Commit fitur `e298008` sudah didorong ke `origin/main`; alias produksi aktif.
- Tidak memerlukan migrasi SQL baru.

### Rilis v2.6.3 Header & Footer dikonfirmasi live

- Editor struk menyediakan keterangan header dan footer tambahan yang mendukung
  beberapa baris.
- Sebutan nomor kontak tidak lagi hardcoded `Tel.`; Owner dapat memakai `WA`,
  `HP`, atau teks lain hingga 16 karakter.
- Keterangan footer tambahan dicetak sebelum pesan penutup usaha/outlet, sehingga
  keduanya dapat dipakai bersama.
- HTML, pratinjau, dan cetak thermal ESC/POS memakai konfigurasi yang sama.
- Rilis memakai API `2.6.3-cloud`, aset web `v80`, dan cache PWA `v80`.
- Seluruh 202 pengujian otomatis lulus. Tidak memerlukan migrasi SQL baru.
- Commit fitur `da193bb` sudah didorong ke `origin/main`.
- Deployment Vercel `dpl_9TQMUgUAtTvhmnkDYr5ceaVJPvcF` berstatus Ready dan
  alias `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi publik menemukan kolom header, footer tambahan, label kontak, dan
  cache PWA `v80`.

### Rilis v2.6.2 Kertas 58/80 dikonfirmasi live

- Pilihan lebar kertas 58 mm dan 80 mm kini tersedia langsung pada halaman
  `Sistem → Desain struk`, bukan hanya di pengaturan perangkat.
- Pilihan memperbarui pratinjau seketika dan disimpan sebagai pengaturan
  printer khusus perangkat yang sedang digunakan.
- Pengaturan layout tetap berlaku ke seluruh kasir, sedangkan lebar kertas
  tidak mengubah printer pada perangkat lain.
- Rilis memakai API `2.6.2-cloud`, aset web `v79`, dan cache PWA `v79`.
- Seluruh 202 pengujian otomatis lulus. Tidak memerlukan migrasi SQL baru.
- Commit fitur `7c48d3d` sudah didorong ke `origin/main`.
- Deployment Vercel `dpl_DBsSqNyd5ruh8iU3WrwPeSHV3KQH` berstatus Ready dan
  alias `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi publik mengembalikan API `2.6.2-cloud`, aset/cache `v79`, serta
  pilihan kertas 58 mm dan 80 mm pada editor struk.

### Rilis v2.6.1 Foto Galeri dikonfirmasi live

- Logo struk mengutamakan pilihan langsung dari galeri/kamera; URL dipindahkan
  ke opsi lanjutan.
- Editor produk kini menerima foto langsung dari galeri/kamera, menampilkan
  pratinjau, memperkecil gambar otomatis, dan menyediakan tombol hapus.
- Foto produk diunggah ke bucket publik `pos-media` dengan nama acak per tenant,
  sehingga tabel dan bootstrap katalog tetap ringan untuk ribuan produk.
- Upload hanya tersedia untuk akun dengan izin kelola katalog, dibatasi tipe
  PNG/JPEG/WebP dan ukuran hasil maksimal 900 KB.
- Kandidat memakai API `2.6.1-cloud`, aset web `v78`, dan cache PWA `v78`.
- Seluruh 202 pengujian otomatis lulus. Editor produk lulus pemeriksaan visual
  ponsel 390×844 tanpa overlap atau overflow.
- Migrasi `supabase/migrations/202607280040_pos_media_storage.sql` telah
  berhasil dijalankan di produksi.
- Commit fitur `e3210b7` sudah didorong ke `origin/main`.
- Deployment Vercel `dpl_32Jz7XXs5WyXMQhbqqNLdHrxZbHs` berstatus Ready dan
  alias `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi publik mengembalikan API `2.6.1-cloud`, aset/cache `v78`, serta
  pemilih galeri untuk logo struk dan foto produk.

### Rilis v2.6.0 Desain Struk dikonfirmasi live

- Owner mendapat halaman `Sistem → Desain struk` dengan pratinjau langsung.
- Logo dapat dipilih dari galeri atau URL, diperkecil otomatis, lalu digunakan
  pada struk browser dan cetak thermal ESC/POS Bluetooth.
- Posisi kepala/penutup, ukuran nama dan logo, kerapatan, garis pemisah, teks
  tambahan, serta informasi yang dicetak dapat diatur per usaha.
- Pengaturan berlaku ke seluruh kasir; lebar kertas dan jumlah salinan tetap
  menjadi pengaturan setiap perangkat.
- Penyimpanan logo lama dilindungi agar perubahan identitas usaha tidak
  menghapusnya tanpa sengaja.
- Kandidat memakai API `2.6.0-cloud`, aset web `v77`, dan cache PWA `v77`.
- Seluruh 200 pengujian otomatis lulus. Visual desktop 1440×1000 dan ponsel
  390×844 lulus tanpa overflow.
- Migrasi `supabase/migrations/202607280039_receipt_layout_settings.sql`
  telah berhasil dijalankan di produksi.
- Commit fitur `fc3d2f2` sudah didorong ke `origin/main`.
- Deployment Vercel `dpl_9aqbns6XVfuyVQUvbvhRapqvMLQ5` berstatus Ready dan
  alias `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi publik mengembalikan API `2.6.0-cloud`, aset/cache `v77`, dan
  halaman Desain Struk baru.

### Rilis v2.5.0 Tipe Pelanggan & Harga dikonfirmasi live

- Tipe pelanggan kini merupakan master dinamis milik tenant. Data awal
  menyediakan Umum, Member, dan Grosir; Owner/Admin dapat menambah tipe lain.
- Satu master yang sama dipakai oleh profil pelanggan, harga produk, promo, dan
  harga khusus outlet. Produk tanpa harga khusus aman memakai harga umum.
- Server menentukan tipe harga dari profil pelanggan, sehingga permintaan
  kasir tidak dapat memilih tipe harga yang berbeda secara manual.
- Form produk menampilkan harga dinamis untuk setiap tipe pelanggan. Harga
  khusus boleh dikosongkan agar memakai harga umum.
- Daftar pelanggan tidak menampilkan badge untuk pelanggan umum; tipe
  non-umum ditampilkan dengan nama dinamis.
- Struk umum tidak mencetak baris pelanggan. Pelanggan terdaftar hanya
  mencetak nama, bukan tipe; label `Harga <tipe>` dicetak pada setiap barang
  untuk tipe non-umum.
- Kandidat memakai API `2.5.0-cloud`, aset web `v76`, dan cache PWA `v76`.
- Seluruh 197 pengujian otomatis lulus. Pemeriksaan visual halaman dan dialog
  tipe pelanggan lulus pada desktop 1365×900.
- Migrasi
  `supabase/migrations/202607270038_dynamic_customer_price_groups.sql`
  telah berhasil dijalankan di produksi.
- Commit fitur `cd0b379` sudah didorong ke `origin/main`.
- Deployment Vercel `dpl_7UkCQzgmS3kZd1wJPprajFTQFeTg` berstatus Ready dan
  alias `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi publik mengembalikan API `2.5.0-cloud`, aset `v76`, cache PWA
  `v76`, label rilis, serta dialog tipe pelanggan baru.

### Rilis v2.4.11 Sinkronisasi Data dikonfirmasi live

- Tombol `Sinkronkan data` ditempatkan paling atas pada sidebar, tepat di bawah
  logo, dan tersedia bagi seluruh peran.
- Sinkronisasi mengambil ulang katalog, harga, stok, pelanggan, supplier,
  promo, shift, serta data halaman aktif seperti laporan, restok, atau staff.
- Keranjang dihitung ulang setelah sinkron agar perubahan harga/promo dari
  perangkat lain segera diterapkan secara aman.
- Tombol menampilkan status proses dan tanggal/jam sinkron terakhir. Waktu
  disimpan per akun dan outlet pada perangkat, termasuk setelah aplikasi dibuka
  ulang.
- Saat offline, sinkronisasi ditolak dengan pesan yang jelas tanpa menghapus
  data lokal atau keranjang.
- Kandidat memakai API `2.4.11-cloud`, aset web `v75`, dan cache PWA `v75`.
- Seluruh 193 pengujian otomatis lulus. Pemeriksaan visual tombol dan waktu
  sinkron lulus pada desktop 1365×900 serta drawer ponsel 390×844.
- Tidak memerlukan migrasi SQL.
- Commit fitur `10dd9c4` sudah didorong ke `origin/main`.
- Deployment Vercel `dpl_4si5xP4TnqR7JA6a9UUA6Yxjz382` berstatus Ready dan
  alias `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi publik mengembalikan API `2.4.11-cloud`, tombol serta logika waktu
  sinkron, aset `v75`, dan cache PWA `v75`.

### Rilis v2.4.10 Kelola Staff dikonfirmasi live

- Menu `Pengguna` diganti menjadi `Kelola Staff`.
- Halaman utama hanya menampilkan ringkasan dan daftar Staff/Admin; akun Owner
  tidak dicampur ke dalam direktori staff.
- Form pembuatan akun tidak lagi memenuhi halaman. Tombol `+ Tambah staff`
  membuka dialog berisi data login, peran, checklist izin, dan outlet.
- Pembuatan maupun perubahan staff tidak menawarkan peran Owner. Owner baru
  tetap dibuat melalui alur pendaftaran Owner yang terpisah.
- Kandidat memakai API `2.4.10-cloud`, aset web `v74`, dan cache PWA `v74`.
- Seluruh 192 pengujian otomatis lulus. Pemeriksaan visual daftar dan dialog
  lulus pada desktop 1365×900 serta ponsel 390×844 tanpa overflow horizontal.
- Tidak memerlukan migrasi SQL.
- Commit fitur `b5c71cb` sudah didorong ke `origin/main`.
- Deployment Vercel `dpl_8d5ftiQWVyaiFcXeMfvCc8vnz85h` berstatus Ready dan
  alias `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi publik mengembalikan API `2.4.10-cloud`, menu Kelola Staff,
  daftar sebelum dialog pembuatan, aset `v74`, serta cache PWA `v74`.

### Rilis v2.4.9 Hak Akses Akun dikonfirmasi live

- Menu Pengguna kini menyediakan checklist hak akses per akun Staff/Admin,
  terpisah dari label peran dan penempatan outlet.
- Hak `sale.adjust` mengontrol harga/diskon manual dan `sale.void` mengontrol
  void transaksi. Keduanya tidak lagi meminta email atau sandi Owner.
- API menghitung izin efektif dari `profiles.custom_permissions` dan tetap
  memeriksanya pada server; menyembunyikan tombol di UI bukan satu-satunya
  perlindungan.
- Izin khusus Owner `identity.manage`, `finance.owner`, dan `pilot.manage` tidak
  tersedia di checklist dan tidak dapat disimpan sebagai izin kustom.
- Profil lama dengan izin `null` tetap memakai bawaan peran agar migrasi tidak
  memutus akses yang sudah berjalan.
- Migrasi `supabase/migrations/202607270037_custom_permissions.sql` sudah
  dijalankan pengguna sebelum deployment.
- Rilis menggunakan API `2.4.9-cloud`, aset web `v73`, dan cache PWA `v73`.
- Seluruh 192 pengujian otomatis lulus. Pemeriksaan visual checklist juga lulus
  pada desktop 1365×900 dan ponsel 390×844 tanpa overflow horizontal.
- Commit fitur `b1de472` sudah didorong ke `origin/main`.
- Deployment Vercel `dpl_8MLECJxqzvaUE5BpoHHWXtpcpPn8` berstatus Ready dan
  alias `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi publik mengembalikan API `2.4.9-cloud`, label Hak Akses Akun,
  checklist pengguna, aset `v73`, cache PWA `v73`, serta tidak memuat input
  sandi Owner untuk penyesuaian harga atau void.

### Rilis v2.4.8 Laporan Transaksi dikonfirmasi live

- Tombol Riwayat di Kasir dihapus agar layar penjualan fokus pada transaksi
  baru. Riwayat struk dipindahkan ke `Analitik → Transaksi`.
- Halaman Transaksi menampilkan pendapatan/penjualan bersih, keuntungan/laba
  kotor, retur, jumlah transaksi, nilai persediaan, pembelian, dan tren harian.
- Periode tersedia untuk hari ini, minggu ini, 7 hari terakhir, bulan ini,
  30 hari terakhir, dan rentang tanggal khusus serta dapat difilter per outlet.
- Maksimal 500 transaksi terbaru pada periode dipilih dapat dicari dan ditekan
  untuk melihat barang, pelanggan, outlet, pembayaran, cetak ulang, serta void.
- Riwayat lintas outlet memakai hak akses `report.view`; endpoint memvalidasi
  periode/outlet dan memecah pengambilan rincian menjadi kelompok aman.
- Tidak memerlukan migrasi SQL. API disiapkan ke `2.4.8-cloud`, aset web `v72`,
  dan cache PWA `v72`.
- Commit fitur `7ca110b` sudah didorong ke `origin/main`.
- Deployment Vercel `dpl_6sRjBNonxYp9qEKF7LheyETmqVrF` berstatus Ready dan
  alias `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi publik mengembalikan API `2.4.8-cloud`, halaman Laporan Transaksi,
  periode mingguan, scope laporan, aset `v72`, dan cache PWA `v72`.

### Rilis v2.4.7 Keranjang Mobile dikonfirmasi live

- Pada ponsel sampai 760 px, katalog dan keranjang Kasir menjadi dua layar.
  Tombol Keranjang tetap mengambang di katalog dan menampilkan jumlah barang.
- Layar keranjang mempunyai tombol `Pilih barang` untuk kembali ke katalog.
  Isi keranjang, member, promo, tahan transaksi, dan pembayaran tetap tersimpan
  saat berpindah layar.
- Tablet mulai 761 px dan desktop tetap memakai katalog serta keranjang
  berdampingan.
- QA browser lulus pada ponsel 390 x 844 dan tablet 800 x 1000 tanpa overflow.
  Seluruh 190/190 pengujian otomatis lulus.
- Tidak memerlukan migrasi SQL. API disiapkan ke `2.4.7-cloud`, aset web `v71`,
  dan cache PWA `v71`.
- Commit fitur `7b0eed3` sudah didorong ke `origin/main`.
- Deployment Vercel `dpl_EnRYzUk8XExe9bGPLP6bvhqxcZs9` berstatus Ready dan
  alias `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi publik mengembalikan API `2.4.7-cloud`, rilis Keranjang Mobile,
  aset `v71`, logika pemisah layar, dan cache PWA `v71`.

### Rilis v2.4.6 Daftar Barang Ringkas dikonfirmasi live

- Katalog Kasir tidak lagi memakai kartu besar dua kolom. Produk menjadi baris
  memanjang dengan foto/placeholder di kiri, kategori/nama/SKU di tengah, serta
  harga dan stok di kanan. Favorit dan kondisi stok kosong tetap berfungsi.
- Pilih Barang Restok memakai pola baris foto yang sama tanpa mengubah urutan
  stok terendah, pemuatan bertahap 100 barang, pilihan jumlah, atau pembuatan PO.
- Daftar Stok tidak lagi memakai tabel lebar. Setiap produk menampilkan foto,
  identitas, stok toko, stok gudang, total, dan modal dalam baris responsif.
- Editor Produk mempunyai URL foto HTTPS opsional. Gambar dimuat secara lazy;
  foto kosong atau rusak kembali ke placeholder huruf produk.
- Migrasi `202607270036_product_images.sql` menambah `products.image_url` dan
  RPC atomik `save_product_v3`. API memvalidasi protokol dan panjang URL.
- QA browser desktop 1440 x 1000 serta mobile 390 x 844 lulus untuk Kasir,
  Restok, dan Stok tanpa overflow. Seluruh 190/190 pengujian otomatis lulus.
  Cache PWA disiapkan ke `v70` dan API ke `2.4.6-cloud`.
- Migrasi `supabase/migrations/202607270036_product_images.sql` telah
  dikonfirmasi berhasil.
- Commit fitur `46bd29f` sudah didorong ke `origin/main`.
- Deployment Vercel `dpl_AH8v859da3mgfhR3iSqVpSSrkDBh` berstatus Ready dan
  alias `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi publik mengembalikan API `2.4.6-cloud`, aset daftar/foto produk
  `v70`, dan cache PWA `v70`.

### Rilis v2.4.5 Daftar Owner dikonfirmasi live

- Halaman login kini mempunyai layar pendaftaran terpisah khusus Owner dengan
  nama Owner, nama usaha, email, kata sandi, dan konfirmasi kata sandi.
- Tombol daftar hanya muncul pada portal Owner. Staff tetap tidak dapat
  mendaftar mandiri dan harus dibuat Owner melalui menu Pengguna.
- Endpoint `POST /api/register-owner` memakai Supabase Auth signup, mendukung
  konfigurasi konfirmasi email, lalu membuat seluruh ruang usaha secara atomik.
  Jika workspace gagal, user Auth baru dibersihkan agar tidak menjadi akun
  yatim.
- Migrasi `202607270035_owner_self_registration.sql` membuat tenant, profil
  Owner, outlet utama, lokasi toko/gudang, pelanggan umum, pengaturan restok,
  kategori biaya, akun akuntansi dasar, dan audit awal. RPC hanya dapat
  dijalankan service role.
- QA visual desktop 1440 x 1000 dan mobile 390 x 844 lulus tanpa overflow.
  Seluruh 187/187 pengujian otomatis lulus. Cache PWA disiapkan ke `v69` dan API
  ke `2.4.5-cloud`.
- Migrasi `202607270035_owner_self_registration.sql` sudah dikonfirmasi berhasil.
  Commit `f575c3c` didorong ke `origin/main`; deployment Vercel
  `dpl_9Ky2YEAhU1nrXzvWsUkZm3DeedVq` berstatus Ready dan alias produksi aktif.
- Verifikasi publik mengembalikan API `2.4.5-cloud`, halaman daftar Owner,
  validasi endpoint publik, aset `v69`, dan cache `nusa-pos-shell-v69`.

### Rilis v2.4.4 dan APK Kasir Nusa POS v1.2.0 dikonfirmasi live

- Nama produk Android ditetapkan menjadi **Kasir Nusa POS**, termasuk label
  launcher dan nama berkas APK. Package `app.kasirnusa.cashier` tetap
  dipertahankan agar pembaruan dapat dipasang tanpa menghapus aplikasi atau sesi.
- Logo baru berbentuk struk dengan huruf N dan aksen jingga dipakai konsisten
  pada launcher Android, ikon PWA, pemulihan sesi, halaman login, dan sidebar.
- APK stabil `Kasir-Nusa-POS-1.2.0.apk` memakai versionCode `4`, target SDK 35,
  build release, serta sertifikat yang sama dengan versi uji sebelumnya.
  SHA-256:
  `E95CBCB88B2FCBF77031D848EDB803FA82F5151EADA2E9E39C3B3D898DD4372C`.
- Cache PWA dinaikkan ke `v68`, API menjadi `2.4.4-cloud`, dan rilis tidak
  memerlukan SQL baru.
- Build Gradle `assembleRelease` dan seluruh 184/184 pengujian otomatis lulus.
  Commit `83d8a97` didorong ke `origin/main`; deployment Vercel
  `dpl_HDtNxXTA391Wcs66tiU7yPbBigtg` berstatus Ready dan alias produksi aktif.
- Verifikasi publik mengonfirmasi API `2.4.4-cloud`, identitas dan logo baru,
  cache `v68`, nama unduhan yang benar, serta checksum APK yang sama dengan
  artefak build.

### Rilis v2.4.3 dan APK kasir v1.1.1 dikonfirmasi live

- **Scanner HID Stabil v2.4.3** mencabut pemilih scanner dari aplikasi, bridge
  scanner langsung, Companion Device Pairing, serta koneksi SPP khusus scanner.
  Printer Bluetooth Classic SPP tetap berfungsi seperti sebelumnya.
- Scanner kembali ke alur yang sudah terbukti: pasangkan sebagai keyboard/HID
  melalui Pengaturan Bluetooth Android, lalu barcode diteruskan otomatis oleh
  APK ke halaman Kasir saat scanner mengirim Enter.
- Tombol scanner langsung di samping pencarian produk diganti tombol pelanggan
  berbentuk ikon orang dengan tanda tambah. Tombol membuka dialog daftar,
  pencarian, pilihan, dan tambah member.
- APK `Kasir-Nusa-Kasir-1.1.1-test.apk` memakai versionCode `3`, target SDK 35,
  dan sertifikat yang sama dengan APK sebelumnya sehingga dapat dipasang sebagai
  pembaruan tanpa menghapus sesi. SHA-256:
  `0050F9D6307D5CB05D764DF6E02228BB945911BF6A21085C2CC62941B8BF1595`.
- Kompilasi Gradle `assembleDebug` dan seluruh 183/183 pengujian otomatis lulus.
  Cache PWA dinaikkan ke `v67`. Rilis ini tidak memerlukan SQL.
- Commit `36e3b40` didorong ke `origin/main`. Deployment Vercel
  `dpl_Gdsb9qGK5hKZXKuXyDHx6EPo6Ffc` berstatus Ready dan alias produksi aktif.
- Verifikasi publik mengembalikan API `2.4.3-cloud`, identitas
  `Scanner HID Stabil · v2.4.3`, ikon pelanggan, aset/cache `v67`, tanpa kontrol
  scanner langsung, serta APK produksi dengan checksum yang benar.

### Rilis v2.4.2 dikonfirmasi live

- **Member Ringkas v2.4.2** menyisakan satu tombol Member pada halaman Kasir.
  Kolom pencarian dan tombol tambah member tidak lagi memenuhi area katalog.
- Menekan tombol membuka dialog daftar member dengan pencarian nama, kode, atau
  telepon, pilihan pelanggan umum, serta tombol tambah member baru.
- Nama member aktif tetap terlihat pada tombol Kasir. Memilih member atau
  pelanggan umum langsung menutup dialog dan memperbarui harga transaksi.
- Cache PWA dinaikkan ke `v66`. Perubahan ini tidak memerlukan SQL atau pembaruan
  APK karena seluruhnya berada pada aplikasi web.
- Seluruh 183/183 pengujian otomatis lulus. Commit `ceff82b` didorong ke
  `origin/main`; deployment Vercel `dpl_HBLj6g8y1MPB86Z2QfZCEJDv4FJf`
  berstatus Ready dan alias produksi aktif.
- Verifikasi publik mengembalikan API `2.4.2-cloud`, identitas
  `Member Ringkas · v2.4.2`, tombol/dialog member, serta aset/cache `v66`.

### Rilis v2.4.1 dan APK kasir v1.1.0 dikonfirmasi live

- **Scanner Langsung v2.4.1** menambahkan tombol scanner Bluetooth di samping
  tombol kamera pada halaman Kasir. Tombol hanya muncul di aplikasi Android,
  sehingga PWA owner tidak menampilkan kontrol yang tidak dapat digunakan.
- Aplikasi memakai Companion Device Pairing Android untuk memindai dan memilih
  perangkat terdekat dari dalam aplikasi tanpa izin lokasi. Scanner Bluetooth
  Classic SPP dibaca melalui socket RFCOMM; scanner HID tetap didukung sebagai
  fallback dan meneruskan barcode secara otomatis.
- Status scanner, sambungkan ulang, putuskan, dan Tes scan tersedia pada
  Pengaturan > Perangkat. Mode tes membaca barcode tanpa memasukkan barang ke
  keranjang.
- APK `Kasir-Nusa-Kasir-1.1.0-test.apk` memakai versionCode `2`, target SDK 35,
  serta sertifikat yang sama dengan APK v1.0.0. APK dapat dipasang sebagai
  pembaruan tanpa menghapus aplikasi atau sesi. SHA-256:
  `9E78D6794054FAAEFFB2BF8520EFA466EB68C539138A11061DC7995F8B049D97`.
- Kompilasi Gradle `assembleDebug`, QA mobile 390 x 844, dan 182/182 pengujian
  otomatis lulus. Rilis ini tidak memerlukan SQL.
- Commit `29b65b9` didorong ke `origin/main`. Deployment Vercel
  `dpl_t7Vc5wS91k9BkUMYiWZmV9ezBcFg` berstatus Ready dan alias produksi aktif.
- Verifikasi publik mengembalikan API `2.4.1-cloud`, identitas
  `Scanner Langsung · v2.4.1`, aset/cache `v65`, bridge scanner, serta APK
  produksi dengan checksum yang benar.

### Rilis v2.4.0 dikonfirmasi live

- **Restok Ringkas v2.4.0** mengganti kartu produk restok yang padat menjadi
  daftar ringkas berisi nama/SKU, harga jual, jumlah stok, dan status pilihan.
- Menekan satu baris membuka popup jumlah restok. Popup juga menampilkan saran
  sistem, akses opsional ke aturan otomatis/perbandingan supplier, serta aksi
  memperbarui atau menghapus pilihan.
- Pilihan barang disimpan terpisah dari DOM sehingga tidak hilang saat daftar
  dirender ulang. Lokasi atau filter supplier baru sengaja membersihkan pilihan
  untuk mencegah PO membawa barang dari konteks lama.
- Pencarian nama/SKU tersedia dan daftar hanya merender 100 barang per tahap.
  Tombol berikutnya menambah 100 barang, sehingga katalog ribuan produk tidak
  langsung membebani browser.
- QA browser desktop 1440 x 1000 dan mobile 390 x 844 lulus, termasuk popup,
  penyimpanan jumlah, dan pemeriksaan tanpa overflow horizontal. Seluruh
  180/180 pengujian otomatis lulus. Rilis ini tidak memerlukan SQL.
- Commit `15b3788` didorong ke `origin/main`. Deployment Vercel
  `dpl_ERmHYdNPj2UY3WcquMCYyDkCHK6p` berstatus Ready dan alias produksi aktif.
- Verifikasi domain publik mengembalikan API `2.4.0-cloud`, identitas
  `Restok Ringkas · v2.4.0`, aset `v64`, popup pemilihan, pencarian, serta cache
  `nusa-pos-shell-v64`.

### Rilis v2.3.4 dikonfirmasi live

- **Pilih Langsung v2.3.4** menghapus kewajiban mengatur kebijakan/supplier
  utama per produk sebelum barang dapat dicentang pada rencana restok.
- Semua produk dan input jumlah selalu aktif. Keterangan supplier pada baris
  hanya menjadi saran otomatis, bukan pengunci pemilihan.
- Supplier tujuan dipilih satu kali di bagian bawah untuk seluruh surat
  pesanan. Bila usaha hanya memiliki satu supplier, pilihan diisi otomatis;
  bila lebih dari satu, pengguna memilih sebelum tombol pembuatan aktif.
- QA mobile 390 x 844 pada barang tanpa aturan berhasil membuat pesanan 7 pcs
  kepada supplier yang dipilih, tanpa overflow atau error JavaScript.
- Tidak memerlukan migrasi SQL. Cache offline dinaikkan ke
  `nusa-pos-shell-v63`; 178/178 pengujian otomatis lulus.
- Commit `f545c67` didorong ke `origin/main`. Deployment Vercel
  `dpl_HBWipvKHATRoe4vAMZmnU9ZFR2bJ` berstatus Ready dan alias produksi aktif.
- Verifikasi domain publik mengembalikan API `2.3.4-cloud`, identitas
  `Pilih Langsung · v2.3.4`, checkbox/jumlah tanpa pengunci aturan, pilihan
  supplier per pesanan, aset `v63`, serta cache `nusa-pos-shell-v63`.

### Rilis v2.3.3 dikonfirmasi live

- Produksi mengembalikan error `record "old" has no field "receipt_id"` ketika
  pengguna menekan Terima dan tambah stok.
- Akar masalah berada pada `sync_supplier_bill_trigger()` dari migrasi v1.16.
  Satu ekspresi CASE mengakses `OLD.receipt_id` pada `purchase_receipts`,
  sedangkan tabel itu memiliki `id`, bukan `receipt_id`.
- Migrasi
  `supabase/migrations/202607270034_supplier_bill_trigger_receipt_id_fix.sql`
  mengganti fungsi secara idempoten. Pemilihan ID kini memakai `to_jsonb`
  berdasarkan `TG_TABLE_NAME`, sehingga tidak pernah mengakses field yang
  tidak tersedia.
- Trigger penerimaan, item penerimaan, retur supplier, dan sinkronisasi hutang
  tetap dipertahankan. Tidak ada tabel atau data transaksi yang dihapus.
- Pengguna mengonfirmasi SQL berhasil dijalankan di Supabase pada 27 Juli
  2026. Source hotfix memiliki 177/177 pengujian otomatis lulus.
- Commit migrasi `e4a9d8b` dan commit rilis `2a71967` didorong ke
  `origin/main`. Deployment Vercel `dpl_9pG1zSpqMC6BhZ8FKgLLbJAGoos2`
  berstatus Ready dan alias produksi aktif.
- Verifikasi domain publik mengembalikan API `2.3.3-cloud`, identitas
  `Restok Stabil · v2.3.3`, aset `v62`, serta cache
  `nusa-pos-shell-v62`.

### Rilis v2.3.2 dikonfirmasi live

- **Restok Mobile v2.3.2** memperbaiki pesan kegagalan penerimaan yang
  sebelumnya tertutup footer pada layar ponsel.
- Pada langkah Periksa, tombol footer kini menjalankan `Terima dan tambah
  stok`, bukan membuka Histori. Histori tetap dapat dibuka melalui indikator
  langkah atau tombol riwayat pada barang.
- Pesan kegagalan disimpan sebagai alert di dalam kartu Periksa dan toast
  diposisikan di atas footer dengan lapisan lebih tinggi. Tombol kartu dan
  footer sama-sama dikunci selama penyimpanan untuk mencegah input ganda.
- QA mobile 390 x 844 menguji kegagalan dan keberhasilan: pesan tidak
  tumpang tindih, sedangkan penerimaan sukses kembali ke Dokumen dan
  menampilkan konfirmasi stok bertambah.
- Tidak memerlukan migrasi SQL. Cache offline dinaikkan ke
  `nusa-pos-shell-v61`; 174/174 pengujian otomatis lulus.
- Commit `c52f757` didorong ke `origin/main`. Deployment Vercel
  `dpl_HfCsPjgXowkpNTzvL6SgZ4csPqNH` berstatus Ready dan alias produksi aktif.
- Verifikasi domain publik mengembalikan API `2.3.2-cloud`, identitas
  `Restok Mobile · v2.3.2`, alert penerimaan permanen, tombol footer
  penerimaan, lapisan/offset toast mobile, aset `v61`, serta cache
  `nusa-pos-shell-v61`.

### Rilis v2.3.1 dikonfirmasi live

- **Restok Sederhana v2.3.1** memindahkan seluruh pembelian dari kelompok
  Barang & Stok ke satu lipatan Restok dengan empat submenu: Pilih barang,
  Pesanan supplier, Terima barang, dan Retur supplier.
- Daftar menampilkan seluruh produk dari stok paling sedikit. Pengguna memilih
  barang dan mengubah jumlah pesan langsung; pengaturan analisis/approval
  disembunyikan dalam bagian lanjutan.
- Satu tombol membuat surat pesanan lalu mengajukannya ke alur persetujuan.
  Pesanan dapat dicetak A4, disimpan PDF, atau dibagikan sebagai teks dan
  selalu bertanda `BUKAN BUKTI PEMBAYARAN`.
- Pesanan yang disetujui diteruskan ke penerimaan dengan supplier, lokasi, dan
  sisa barang otomatis terisi. Staf mencatat faktur serta jumlah yang benar-benar
  tiba sebelum stok bertambah.
- QA browser desktop dan mobile 390 x 844 lulus tanpa overflow. Tidak
  memerlukan migrasi SQL. Cache offline dinaikkan ke `nusa-pos-shell-v60`;
  173/173 pengujian otomatis lulus.
- Commit `ad7616a` didorong ke `origin/main`. Deployment Vercel
  `dpl_HuszaY4qufZUA265jauVErno2aqs` berstatus Ready dan alias produksi aktif.
- Verifikasi domain publik mengembalikan API `2.3.1-cloud`, identitas
  `Restok Sederhana · v2.3.1`, tepat satu kelompok/panel Restok, tombol
  cetak/bagikan, penanda bukan bukti pembayaran, pengurutan stok, aset `v60`,
  serta cache `nusa-pos-shell-v60`.

### Rilis v2.3.0 dikonfirmasi live

- **Restok Terpandu v2.3.0** mengubah penerimaan barang yang sebelumnya
  memanjang menjadi empat layar: Dokumen, Barang, Periksa, dan Histori.
- Tombol Kembali/Lanjut memvalidasi supplier, faktur, lokasi, jumlah, modal,
  serta EXP sebelum maju. Isian tetap tersimpan ketika pengguna kembali.
- Ringkasan akhir memperlihatkan dokumen, barang, konversi satuan, dan total
  modal sebelum stok ditambahkan. Histori modal tidak lagi menumpuk di bawah
  formulir.
- Desktop membatasi daftar panjang di panel. Pada mobile, indikator langkah
  dapat digeser mendatar dan tombol Kembali/Lanjut tetap terlihat di bawah.
- Tidak memerlukan migrasi SQL. Cache offline dinaikkan ke
  `nusa-pos-shell-v59`; 168/168 pengujian otomatis lulus.
- Commit `2571921` didorong ke `origin/main`. Deployment Vercel
  `dpl_FYFFf6LmuNNWG66ejeP5fqjtUvnA` berstatus Ready dan alias produksi aktif.
- Verifikasi domain publik mengembalikan API `2.3.0-cloud`, identitas
  `Restok Terpandu · v2.3.0`, empat tombol dan empat panel langkah, aset
  `v59`, serta cache `nusa-pos-shell-v59`.

### Rilis v2.2.2 dikonfirmasi live

- **Kas Tunai Cepat v2.2.2** menambahkan tombol Uang Pas langsung di keranjang
  dan keypad nominal pada dialog pembayaran tanpa migrasi SQL.
- Keypad mendukung angka 0–9, `000`, hapus satu angka, bersihkan seluruh
  nominal, serta saran Uang Pas dan pecahan pembulatan praktis.
- Nominal di bawah total mengunci tombol penyelesaian. Nominal di atas total
  langsung menampilkan kembalian; transaksi tetap membutuhkan konfirmasi
  `Selesaikan transaksi` untuk mencegah salah tekan.
- Alur nyata diuji pada total Rp38.000: input Rp5.000 ditolak, sedangkan
  Rp50.000 menghasilkan kembalian Rp12.000. Mobile 390 x 844 tidak overflow,
  tombol keypad setinggi 52 px, dan dialog dapat digulir.
- Modul keypad masuk cache offline `nusa-pos-shell-v58`; 164/164 pengujian
  otomatis lulus.
- Commit `6c43f6c` didorong ke `origin/main`. Deployment Vercel
  `dpl_VW8u6N8BEB6JCG3Z6zCPf67WLDko` berstatus Ready dan alias produksi aktif.
- Verifikasi domain publik mengembalikan API `2.2.2-cloud`, identitas
  `Kas Tunai Cepat · v2.2.2`, tombol Uang Pas, keypad, aset/cache `v58`, serta
  modul `/payment-keypad.mjs` dengan HTTP 200.

### Rilis v2.2.1 dikonfirmasi live

- **Satuan Pintar v2.2.1** memperjelas penjualan produk yang memiliki
  pcs/lusin/dus/karton tanpa migrasi SQL.
- Menekan kartu produk dengan beberapa satuan membuka dialog pilihan. Scan
  barcode satuan besar langsung memilih satuan itu tanpa dialog.
- Bila hanya barcode satuan dasar yang tersedia, scan barcode dasar membuka
  pilihan seluruh satuan. Bila semua satuan memiliki barcode, setiap scan
  langsung memilih satuan yang cocok.
- Satuan baris transaksi dapat diganti dari keranjang. Sistem memeriksa stok
  berdasarkan faktor isi, menggabungkan baris yang sama, lalu menghitung ulang
  harga, promo, dan total.
- Modul pemilihan satuan ikut cache offline `nusa-pos-shell-v57`. QA browser
  desktop dan mobile 390 x 844 lulus tanpa overflow; 161/161 pengujian otomatis
  lulus.
- Commit `b8bad34` didorong ke `origin/main`. Deployment Vercel
  `dpl_2ACyiyfNj4XUKQi3wgujCRu11Ric` berstatus Ready dan alias produksi aktif.
- Verifikasi domain publik mengembalikan API `2.2.1-cloud`, identitas
  `Satuan Pintar · v2.2.1`, aset/cache `v57`, serta modul
  `/pos-units.mjs` dengan HTTP 200.

### Rilis v2.2 dikonfirmasi live

- **Nusa Commerce UI v2.2.0** menyegarkan seluruh antarmuka tanpa migrasi SQL
  dan tanpa mengubah kontrak data atau alur bisnis v2.1.
- Login memakai layout profesional responsif; sidebar memakai ikon SVG
  konsisten, active state yang jelas, serta accordion yang tetap berada di
  sidebar sesuai keputusan produk.
- POS memisahkan katalog dan checkout dengan lebih tegas. Form, tombol, metrik,
  tabel, laporan, dialog, dan feedback memakai sistem warna, jarak, radius,
  fokus keyboard, serta tipografi yang sama.
- Mobile telah diperiksa pada viewport 390 x 844: tidak ada overflow horizontal,
  drawer berada di atas backdrop, area klik tetap jelas, dan tombol Favorit
  tidak meluap.
- Tidak memakai font, gambar, atau library UI eksternal. Cache PWA naik ke
  `nusa-pos-shell-v56`; API dan package naik ke `2.2.0`.
- 156/156 pengujian otomatis lulus. Pengujian baru memeriksa identitas rilis,
  aset offline, ikon navigasi, token desain, breakpoint, fokus, dan
  `prefers-reduced-motion`.
- Commit `5f6ddc7` didorong ke `origin/main`. Deployment Vercel
  `dpl_Gky9YdjL2LzHXJgaU4RbN17CKPiS` berstatus Ready dan alias
  `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi produksi mengembalikan API `2.2.0-cloud`, database Supabase, UI
  `Nusa Commerce · v2.2.0`, aset `v56`, cache `nusa-pos-shell-v56`, tanpa
  overflow horizontal pada login desktop, dan route Akuntansi tanpa sesi tetap
  ditolak dengan HTTP 401.

### Rilis v2.1 dikonfirmasi live

- **Akuntansi Inti v2.1.0** live pada 27 Juli 2026.
- Migrasi `supabase/migrations/202607270033_core_accounting.sql`
  dikonfirmasi berhasil sebelum source didorong.
- Enam halaman Owner terpisah tersedia di accordion Keuangan: daftar akun,
  jurnal umum, buku besar, neraca saldo, neraca, serta periode/tutup buku.
- Pembukuan memakai debit-kredit berimbang. Penjualan/void, retur pelanggan,
  penerimaan pembelian, pembayaran hutang/piutang, retur supplier, dan biaya
  outlet disinkronkan idempoten berdasarkan sumber transaksi.
- Jurnal manual hanya dapat dibuat Owner, wajib seimbang, tidak dapat dimasukkan
  ke periode tertutup, dan pembatalannya membuat jurnal pembalik tanpa
  menghapus histori.
- Data akuntansi masuk backup. Saldo awal modal/persediaan dari masa sebelum
  Kasir Nusa tetap harus dimasukkan Owner melalui jurnal manual setelah live.
- Commit source `6cb386a` didorong ke `origin/main`; 152/152 pengujian
  otomatis lulus.
- Deployment Vercel `dpl_Cfkp2kcW8kqHSLJbBqhLiyjZpa4E` berstatus Ready dan
  alias `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi produksi mengembalikan API `2.1.0-cloud`, UI `v2.1.0`, enam
  halaman Akuntansi, cache `nusa-pos-shell-v55`, dan route dashboard
  akuntansi terlindungi sesi.

### Rilis v2.0 dikonfirmasi live

- **Pilot Produksi dan Hardening v2.0.0** live pada 27 Juli 2026.
- Migrasi `supabase/migrations/202607270032_pilot_production_hardening.sql`
  dikonfirmasi berhasil sebelum source didorong.
- Lima halaman Owner terpisah tersedia di accordion Pilot: kesiapan, insiden,
  performa, pemulihan, dan SOP.
- Pilot memiliki periode pelaksanaan, checklist 25 langkah, keputusan
  lanjut/tunda yang divalidasi server, pencatatan insiden, serta pengaman stok,
  idempotensi, dan kesehatan operasional.
- Telemetri hanya menyimpan jenis kejadian, endpoint yang dinormalisasi, status,
  durasi, konteks perangkat/outlet/pengguna, dan kondisi online. Isi transaksi
  maupun data pelanggan tidak disimpan.
- Uji pemulihan mencatat bukti backup, checksum, dan langkah verifikasi; fitur
  ini sengaja tidak dapat menimpa database produksi.
- Commit source `f3028ad` didorong ke `origin/main`; 148/148 pengujian
  otomatis lulus.
- Deployment Vercel `dpl_6mb7kSiEC8TiacDa4UvoaoiufzWx` berstatus Ready dan
  alias `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi produksi mengembalikan API `2.0.0-cloud`, UI `v2.0.0`, lima
  halaman Pilot, cache `nusa-pos-shell-v54`, dan route dashboard pilot
  terlindungi sesi.

### Terakhir dikonfirmasi live

- **Paket Akuntansi dan Analitik Owner v1.26.0** live pada 27 Juli 2026.
- Migrasi `supabase/migrations/202607270030_owner_accounting_analytics.sql`
  dikonfirmasi berhasil sebelum source didorong.
- Enam halaman terpisah tersedia di accordion Keuangan: laba rugi, biaya
  outlet, arus kas, aging, kesehatan produk, dan ekspor akuntan.
- Biaya memiliki kategori arus kas, nomor dokumen, idempotensi, status
  posting/pembatalan, integrasi kas keluar saat memakai shift Owner, hak akses
  khusus Owner, dan audit.
- Laba operasional memisahkan biaya operasional dari investasi/pendanaan dan
  arus kas tidak menganggap penjualan kredit sebagai kas masuk.
- Commit `e6af84a` sudah didorong ke `origin/main`; 140/140 pengujian lulus.
- Deployment Git/Vercel `dpl_G1JQL6oAiwtnQJmCU9XnYxHUA2SX` berstatus Ready
  dan alias `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi produksi mengembalikan API `1.26.0-cloud`, UI `v1.26.0`, enam
  halaman Keuangan, cache `nusa-pos-shell-v52`, route finansial terlindungi
  sesi, dan APK kasir tetap tersedia.

### Rilis v1.27 dikonfirmasi live

- **Paket Multi-outlet Tingkat Lanjut v1.27.0** live pada 27 Juli 2026.
- Migrasi `supabase/migrations/202607270031_advanced_multi_outlet.sql`
  dikonfirmasi berhasil sebelum source didorong.
- Tujuh halaman terpisah di accordion Multi-outlet: permintaan transfer,
  persetujuan/pengiriman, stok perjalanan, harga outlet, promo outlet,
  konsolidasi, dan notifikasi.
- Transfer baru bertahap dan atomik: `REQUESTED` → `APPROVED` → `IN_TRANSIT`
  → `RECEIVED`; stok asal berkurang saat dikirim dan stok tujuan bertambah
  saat diterima. Batch/EXP ikut berpindah dan seluruh tindakan diaudit.
- Role `MANAGER`/Manajer Outlet dibatasi oleh penempatan outlet. Harga outlet
  mengungguli harga pusat pada kasir outlet tersebut; promo tanpa penempatan
  tetap global.
- Notifikasi terbuka mencakup stok di bawah kebijakan minimum dan selisih
  rekonsiliasi shift minimal Rp100.000.
- Commit source `9a5230e` didorong ke `origin/main`; 144/144 pengujian
  otomatis lulus.
- Deployment Git/Vercel `dpl_CUndEUhYHtg2rphwPmYCBckz5nEa` berstatus Ready
  dan alias `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi produksi mengembalikan API `1.27.0-cloud`, UI `v1.27.0`, tujuh
  halaman Multi-outlet, cache `nusa-pos-shell-v53`, route konsolidasi
  terlindungi sesi, dan APK kasir tetap tersedia.
- **Paket Operasional Karyawan v1.25.0** live pada 27 Juli 2026.
- Migrasi `supabase/migrations/202607270029_employee_operations.sql`
  dikonfirmasi berhasil sebelum deployment.
- Rilis menambahkan halaman terpisah untuk jadwal/absensi, target/komisi,
  antrean approval bertingkat, aktivitas pengguna/perangkat, dan rekonsiliasi
  shift per metode pembayaran.
- Sebanyak 136/136 pengujian otomatis lulus. Commit source `fe4ccae` sudah
  didorong ke `origin/main`.
- Deployment Vercel `dpl_CywxzdQz7ZtRTxSmakzUPTADWv4V` berstatus Ready dan
  alias `kasir-nusa-pos.vercel.app` aktif.
- Verifikasi langsung mengembalikan API `1.25.0-cloud`, UI `v1.25.0`, cache
  `nusa-pos-shell-v51`, route operasional terlindungi sesi, dan APK kasir tetap
  dapat diunduh.
- **Hotfix v1.24.1** memperbaiki startup aplikasi Android yang tertahan pada
  “Memulihkan sesi kerja”. WebView native tidak lagi mengakses Web Serial yang
  tidak tersedia, dan watchdog 12 detik menjamin login tetap dapat ditampilkan.
- Versi UI `v1.24.1`, API `1.24.1-cloud`, cache `nusa-pos-shell-v50`. Tidak
  memerlukan SQL maupun APK baru karena aplikasi memuat web produksi.
- **Rilis v1.24.0 dikonfirmasi live** dan menambahkan aplikasi kasir Android native di
  `apps/android-cashier`.
- Printer WP58D memakai RFCOMM/SPP langsung dan ESC/POS tanpa kabel, bridge
  berbayar, atau langganan. Daftar printer berasal dari perangkat yang sudah
  dipasangkan pada Pengaturan Android.
- Scanner Bluetooth HID ditangkap sebagai keyboard eksternal dan barcode
  diteruskan ke halaman POS. Kamera tetap tersedia sebagai cadangan.
- WebView dikunci ke `kasir-nusa-pos.vercel.app`, menolak cleartext dan akses
  file lokal, serta tidak mencadangkan sesi atau data aplikasi.
- APK uji ada di `releases/Kasir-Nusa-Kasir-1.0.0-test.apk` dan disajikan dari
  `/downloads/Kasir-Nusa-Kasir-1.0.0-test.apk`. Tidak memerlukan SQL baru.
- **Paket uji printer v1.23.3** memprioritaskan validasi printer fisik sebelum
  roadmap fitur dilanjutkan.
- Chrome/PWA Android dapat memilih printer Bluetooth Classic SPP melalui Web
  Serial dan mengirim struk ESC/POS langsung tanpa aplikasi bridge berbayar.
- Pengaturan perangkat menyediakan status, hubungkan/sambungkan ulang, tes
  cetak, putuskan, lebar 58/80 mm, 1–3 salinan, dan cetak otomatis.
- Izin printer yang pernah diberikan dipulihkan melalui `getPorts()`. Kegagalan
  cetak tidak membatalkan transaksi; struk tetap dapat dicetak ulang.
- Format ESC/POS memakai tampilan harga pelanggan sehingga alasan dan nominal
  penyesuaian harga internal tetap tidak tercetak.
- Tidak memerlukan SQL baru. Validasi otomatis berjumlah 129 pengujian; printer
  fisik masih harus dikonfirmasi pengguna.
- **Paket Operasional v1.23.2** mengganti panel navigasi kedua dengan accordion
  langsung di sidebar.
- Menekan Penjualan, Barang & Stok, Relasi, Pertumbuhan, Analitik, atau Sistem
  membuka subfiturnya memanjang tepat di bawah induk. Menekan ulang menutupnya.
- Hanya satu kelompok terbuka pada satu waktu. Setelah subfitur dipilih,
  halaman kerja tampil di area kanan; drawer mobile menutup otomatis.
- Pemisahan halaman Promo/Loyalitas, Pelanggan/Supplier, dan tampilan kerja
  fitur lainnya tetap dipertahankan.
- Tidak memerlukan SQL baru dan 127 pengujian otomatis lulus.
- **Paket Operasional v1.23.1** menambahkan navigasi dua tingkat responsif.
- Sidebar utama berisi enam kelompok: Penjualan, Barang & Stok, Relasi,
  Pertumbuhan, Analitik, dan Sistem. Memilih kelompok membuka daftar fitur
  pada panel kedua setelah sidebar; memilih fitur membuka halaman kerjanya.
- Promo dan Loyalitas, serta Pelanggan dan Supplier, tidak lagi ditumpuk dalam
  satu halaman. Tampilan Stok, Pembelian, Laporan, dan Pengaturan juga memiliki
  tujuan navigasi masing-masing tanpa menghilangkan hak akses yang ada.
- Drawer mobile, tombol Escape, fokus keyboard, status aktif, dan pemulihan
  tampilan tetap bekerja pada navigasi baru.
- Perubahan v1.23.1 hanya UI/PWA dan tidak memerlukan SQL baru.
- Seluruh **127 pengujian otomatis** lulus.
- **Paket Operasional v1.23.0**
- SQL `202607260028_loyalty_crm_vouchers.sql` terkonfirmasi tersedia di
  Supabase melalui pemeriksaan tabel produksi.
- Commit rilis diperbaiki memakai identitas GitHub
  `ayanacosmetics <budiwirayu0412@gmail.com>` agar diterima integrasi Vercel.
- Deployment Vercel `dpl_6D2intxTbmuHHgbDpQQikXfiDf7s` berstatus Ready dan
  alias `kasir-nusa-pos.vercel.app` aktif pada 26 Juli 2026.
- Verifikasi produksi mengembalikan API `1.23.0-cloud`, UI `v1.23.0`, aset
  `app.js?v=45`, dan cache `nusa-pos-shell-v45`.
- SQL `202607260025_pos_speed_customer_service.sql` berhasil diterapkan pada
  Supabase sebelum deployment.
- Hotfix nomor struk memperbaiki `document_sequences` produksi dari tidak ada
  menjadi `next_value=5`, tepat setelah struk tertinggi `UTM-000004`.
- API kini mendeteksi benturan `sales_tenant_id_receipt_no_key`, menyelaraskan
  penghitung secara aman, lalu mencoba ulang RPC dengan idempotency key yang
  sama sehingga transaksi tidak tercatat ganda.
- SQL `202607260027_restock_purchase_planning.sql` berhasil diterapkan. Migrasi
  tersebut sekaligus memasang penguatan nomor struk `026` secara idempotent.
- Deployment Vercel `dpl_6ja9QtwaA8ouaHS3CADauJUMXTF6` berstatus Ready pada
  26 Juli 2026 dan alias `kasir-nusa-pos.vercel.app` sudah aktif.
- Verifikasi langsung produksi mengembalikan API `1.22.0-cloud`, aplikasi
  `v1.22.0`, cache `nusa-pos-shell-v44`, ZXing lokal, kebijakan `camera=(self)`,
  proteksi autentikasi riwayat POS, dan logout yang menghapus cookie refresh.
- Skema Supabase mengonfirmasi RPC `complete_sale_v6` dan `void_sale_v1`
  tersedia; verifikasi produksi tidak membuat transaksi nyata.
- Penyesuaian harga barang kini menjadi alur internal tersendiri dan hanya
  menetapkan harga jual akhir. Struk menampilkan harga akhir sebagai harga
  normal tanpa nominal, alasan, approver, atau label penyesuaian internal.
- Promo dan diskon pelanggan tetap dicantumkan tersendiri pada struk serta
  tidak digabung dengan penyesuaian harga internal.
- Cetak ulang dari riwayat mengambil kembali metadata otorisasi internal agar
  aturan privasi yang sama juga berlaku pada transaksi lama.
- Halaman login memiliki jalur Owner dan Staff terpisah. API menolak peran yang
  masuk melalui jalur yang salah dan mencabut token login sementara.
- Owner yang sudah login dapat memakai Ganti Owner untuk berpindah ke Owner
  aktif lain dalam tenant yang sama tanpa memasukkan kredensial lagi.
- Token autentikasi tetap milik Owner asal, Owner terpilih menjadi konteks kerja
  aktif, perpindahan dicatat dalam audit, dan konteks bertahan saat reload.
- Staff dan Kasir tidak melihat Ganti Owner. Logout mencabut sesi server serta
  membersihkan token, cache bootstrap, dan konteks Owner dari browser.
- Aset login memakai penanda versi agar CDN/PWA tidak mempertahankan tampilan
  lama, dan kartu login dibatasi aman pada viewport mobile.
- Validasi rilis mencakup 119 pengujian otomatis dan 5 pengujian browser
  tambahan; seluruhnya lulus.

Penguatan `202607260026_receipt_sequence_collision_fix.sql` sudah tercakup dan
diterapkan melalui migrasi `027`; tidak ada SQL v1.21 yang masih tertunda.

### Rilis v1.23.1

- Navigasi semua fitur dipisahkan menjadi kelompok sidebar, daftar fitur
  tingkat kedua, dan halaman kerja tersendiri.
- Promo/Loyalitas serta Pelanggan/Supplier memiliki halaman terpisah.
- Versi UI `v1.23.1`, API `1.23.1-cloud`, dan cache `nusa-pos-shell-v46`.
- Tidak memerlukan migrasi Supabase.
- Validasi lokal: 127/127 pengujian otomatis lulus.

### Rilis v1.23.2

- Panel/kolom subfitur kedua dihapus.
- Seluruh subfitur menjadi accordion yang menyatu dengan sidebar.
- Versi UI `v1.23.2`, API `1.23.2-cloud`, dan cache `nusa-pos-shell-v47`.
- Tidak memerlukan migrasi Supabase.
- Validasi lokal: 127/127 pengujian otomatis dan inspeksi browser desktop/mobile
  lulus.

### Paket uji printer v1.23.3

- Driver ESC/POS Bluetooth Classic SPP memakai Web Serial Android.
- UI koneksi dan tes printer tersedia pada Sistem → Perangkat.
- Cetak manual, cetak ulang, shortcut P, dan cetak otomatis memakai jalur
  printer langsung; browser tanpa Web Serial tetap memakai dialog sistem.
- Versi UI `v1.23.3`, API `1.23.3-cloud`, cache `nusa-pos-shell-v48`.
- Tidak memerlukan migrasi Supabase.

### Rilis v1.24.0

- Aplikasi Android native menggantikan keterbatasan Web Serial untuk printer
  Bluetooth Classic WP58D.
- UI/PWA mendeteksi bridge Android untuk memilih printer, menyambung ulang,
  mengirim ESC/POS, dan menerima barcode scanner HID.
- Versi UI `v1.24.0`, API `1.24.0-cloud`, cache `nusa-pos-shell-v49`.
- Deployment Vercel pertama `dpl_DeoJLuRktvU4aZciqPEQDedThESP` berstatus
  `READY`; alias utama telah diverifikasi langsung.
- Tidak memerlukan migrasi Supabase.

### Rilis v1.23 dikonfirmasi live

- **Paket Operasional v1.23.0** selesai, live, dan 125 pengujian otomatis lulus.
- Migrasi `202607260028_loyalty_crm_vouchers.sql` sudah diterapkan.
- Migrasi menambahkan pengaturan loyalitas, tier Member/Silver/Gold, mutasi
  poin, voucher berkode, kuota total/per pelanggan, satu kali pakai, masa
  berlaku, outlet, segmen aktif/tidak aktif/nilai tinggi/ulang tahun, serta
  pembalikan poin dan kuota saat void.
- Checkout memakai `complete_sale_v7`; void memakai `void_sale_v2`.
- Profil pelanggan menyimpan tanggal lahir dan persetujuan WhatsApp. Tombol
  WhatsApp hanya tersedia setelah persetujuan dan selalu memerlukan klik kasir.
- UI `v1.23.0`, API `1.23.0-cloud`, cache `nusa-pos-shell-v45`.
- Deployment produksi `dpl_6D2intxTbmuHHgbDpQQikXfiDf7s` berstatus Ready dan
  alias utama sudah diverifikasi.

### Rilis v1.22 dikonfirmasi live

- **Paket Operasional v1.22.0** sudah selesai dan live.
- Migrasi tunggal `202607260027_restock_purchase_planning.sql` bersifat
  idempotent dan menyertakan penguatan nomor struk dari migrasi `026`, sehingga
  pengguna hanya perlu menjalankan satu SQL.
- Rencana restok memakai stok lokasi, sisa PO disetujui yang belum datang,
  rata-rata penjualan, minimum, maksimum, safety stock, dan lead time.
- Daftar kebutuhan memprioritaskan stok kosong, dapat difilter per supplier,
  dan dapat langsung membuat draft PO untuk satu supplier.
- Dokumen PO menampilkan sisa barang serta status terlambat. Perbandingan modal
  supplier menampilkan dua penerimaan terakhir dan tren perubahan.
- Staff Pembelian memperoleh persetujuan otomatis sampai batas nominal tenant;
  PO di atas batas menunggu Owner/Admin. Seluruh perubahan kebijakan, aturan,
  draft rekomendasi, dan transisi PO dicatat dalam audit.
- Admin kini memiliki hak pembelian yang konsisten dengan validasi database.
- API kandidat `1.22.0-cloud`, UI `v1.22.0`, dan cache `nusa-pos-shell-v44`.
- Seluruh 119 pengujian otomatis lulus. Deployment produksi dan alias utama
  sudah diverifikasi tanpa membuat transaksi atau PO nyata.

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

Status: migrasi utama, 112 pengujian otomatis, 5 pengujian browser, deployment
produksi, hotfix benturan nomor struk, dan privasi harga internal pada struk
selesai pada 26 Juli 2026. SQL penguatan
`202607260026_receipt_sequence_collision_fix.sql` telah diterapkan melalui
migrasi `027` yang idempotent.

### v1.22 — Perencanaan restok dan pembelian (selesai)

- minimum, maksimum, safety stock, dan lead time per produk/supplier;
- saran jumlah restok berdasarkan penjualan rata-rata dan stok tersedia;
- daftar barang perlu dipesan, stok nol paling atas, dan filter supplier;
- status PO terlambat dan sisa barang belum datang;
- perbandingan harga supplier lintas periode;
- draft PO dari rekomendasi restok;
- approval pembelian berdasarkan nilai.

Status: implementasi domain, database, API, UI responsif, audit, hak akses,
migrasi `027`, 119 pengujian otomatis, dan deployment produksi selesai pada
26 Juli 2026.

### v1.23 — Loyalitas, CRM, dan promosi lanjutan

- poin pelanggan dan riwayat mutasi;
- level/member tier;
- voucher berkode dan masa berlaku;
- promo hari ulang tahun dan segmentasi pelanggan;
- kupon satu kali dan batas per outlet/pelanggan;
- kirim struk atau ringkasan transaksi melalui WhatsApp dengan persetujuan;
- dashboard pelanggan aktif, tidak aktif, dan nilai belanja.

Status: implementasi domain, database, API, UI, privasi WhatsApp, backup, void,
125 pengujian otomatis, migrasi `028`, dan deployment produksi selesai.

### v1.25 — Operasional karyawan (selesai)

- jadwal kerja dan absensi sederhana;
- target serta komisi sales/kasir;
- approval bertingkat untuk diskon, void, pembelian, dan opname;
- log aktivitas per pengguna dan perangkat;
- rekonsiliasi shift antar-metode pembayaran.

Status: migrasi `029`, source, 136 pengujian otomatis, push, deployment, dan
verifikasi produksi selesai pada 27 Juli 2026. Nomor v1.24 telah dipakai
aplikasi kasir Android, sehingga paket roadmap ini dirilis sebagai v1.25.0.

### v1.26 — Akuntansi dan analitik owner (selesai)

- ringkasan laba rugi operasional;
- biaya outlet dan kategori biaya;
- arus kas serta proyeksi hutang/piutang;
- aging supplier dan pelanggan yang dapat ditindaklanjuti;
- dashboard tren, produk lambat/cepat, margin rendah, dan dead stock;
- ekspor yang siap diberikan kepada akuntan.

Status: domain, migrasi `030`, API cloud/lokal, enam halaman responsif,
hak akses khusus Owner, ekspor CSV, 140 pengujian otomatis, push, deployment,
dan verifikasi produksi selesai pada 27 Juli 2026.

### v1.27 — Multi-outlet tingkat lanjut

- permintaan transfer dari cabang;
- approval dan penerimaan transfer;
- stok dalam perjalanan;
- harga dan promo per outlet;
- konsolidasi owner serta pembatasan manager outlet;
- notifikasi stok kritis dan aktivitas tidak wajar.

Status: migrasi `031`, workflow stok atomik, role Manajer Outlet, tujuh halaman
terpisah, audit, 144 pengujian otomatis, push, deployment, dan verifikasi
produksi selesai pada 27 Juli 2026.

### v2.0 — Pilot produksi dan hardening

- UAT lengkap sesuai `GO-LIVE-CHECKLIST.md`;
- pilot satu outlet dan satu kasir selama 2–4 minggu;
- monitoring error dan performa;
- pengujian dua kasir menjual stok sama secara bersamaan;
- prosedur backup/restore yang benar-benar diuji;
- dokumentasi staf, onboarding, dan SOP gangguan internet;
- perbaikan temuan pilot sebelum ekspansi outlet.

Status: migrasi `032`, lima halaman Owner, checklist 25 langkah, insiden,
telemetri minim data, bukti uji pemulihan, pengaman stok/idempotensi, 148
pengujian otomatis, push, deployment, dan verifikasi produksi selesai pada
27 Juli 2026. Pelaksanaan pilot fisik tetap dilakukan di toko.

### v2.1 — Akuntansi inti

- daftar akun standar dan saldo normal debit/kredit;
- sinkronisasi jurnal otomatis dari transaksi operasional;
- jurnal manual berimbang dan jurnal pembalik;
- buku besar per akun dan outlet;
- neraca saldo serta neraca dengan laba berjalan;
- periode akuntansi dan tutup buku.

Status: migrasi `033`, enam halaman Owner, backup, audit, kontrol periode,
152 pengujian otomatis, push, deployment, dan verifikasi produksi selesai
pada 27 Juli 2026.

### Fitur opsional, bukan prioritas otomatis

Fitur berikut hanya dibangun bila usaha memang membutuhkannya:

- integrasi marketplace dan omnichannel;
- toko online;
- payment gateway;
- rekonsiliasi rekening koran, aset tetap, dan pajak lanjutan;
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
