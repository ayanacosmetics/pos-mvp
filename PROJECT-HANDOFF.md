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

### Kandidat berikutnya — belum live

- **Paket Multi-outlet Tingkat Lanjut v1.27.0** sudah selesai di source lokal.
- Migrasi tunggal yang harus dijalankan lebih dahulu:
  `supabase/migrations/202607270031_advanced_multi_outlet.sql`.
- Source belum boleh didorong/deploy sebelum pengguna mengonfirmasi SQL
  berhasil.
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
- API/UI `v1.27.0`, cache PWA `nusa-pos-shell-v53`, dan 144/144 pengujian
  otomatis lulus. Deployment produksi masih menunggu konfirmasi SQL.
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

Status: kandidat source selesai dengan migrasi `031`, workflow stok atomik,
role Manajer Outlet, tujuh halaman terpisah, audit, dan 144 pengujian otomatis.
Belum live; jalankan migrasi `031` lalu lanjutkan commit, push, deployment, dan
verifikasi produksi.

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
