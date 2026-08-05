# Rancangan QRIS Nusa POS — Midtrans Core API

Status: rancangan keselamatan sebelum implementasi produksi  
Target awal: Sandbox Midtrans, QRIS dinamis satu metode pembayaran  
Prinsip: QR berhasil dibuat bukan berarti uang sudah diterima.

## 1. Batas fitur

Nusa mempertahankan dua jalur yang sengaja dibedakan:

1. **QRIS statis/manual** — kasir memeriksa mutasi pada aplikasi merchant lalu mengonfirmasi manual. Metode lama tetap tersedia sebagai cadangan.
2. **QRIS dinamis/Midtrans** — nominal dikunci oleh Nusa, satu QR dibuat untuk satu transaksi, dan penjualan hanya diselesaikan setelah status resmi Midtrans terverifikasi.

Versi pertama QRIS dinamis hanya menerima pembayaran penuh dengan satu metode. Split payment, refund otomatis, dan mode offline tidak boleh diaktifkan sampai alur dasarnya lulus uji.

## 2. Aturan mutlak

- Kunci Server Midtrans hanya disimpan sebagai Cloudflare secret dan tidak pernah dikirim ke browser, APK, log, atau database.
- QR `pending` tidak membuat penjualan, struk, poin, jurnal pendapatan, atau pengurangan stok final.
- Penjualan hanya boleh dibuat satu kali setelah status Midtrans `settlement`, nilai pembayaran sama persis, jenis pembayaran `qris`, dan intent masih sah.
- Webhook tidak dipercaya sendirian. Tanda tangan SHA-512 wajib benar dan server mengambil ulang status langsung dari Midtrans.
- Pengulangan webhook, klik tombol periksa berulang, atau retry jaringan harus menghasilkan satu penjualan yang sama.
- Uang yang sudah `settlement` tidak boleh dibatalkan dengan Void biasa. Jalurnya adalah refund/retur yang tercatat dan dapat direkonsiliasi.
- Kasir tidak boleh menutup shift selama masih ada pembayaran QRIS yang `pending` pada shift tersebut.
- Mode offline tidak boleh membuat QRIS dinamis.
- Sandbox dan Production memakai kunci, endpoint, label, dan data yang terpisah. Sandbox tidak boleh membuat penjualan operasional.

## 3. State machine pembayaran

```text
DRAFT
  -> RESERVING
  -> PENDING          QR berhasil dibuat, stok direservasi
  -> SETTLEMENT       pembayaran sah dari Midtrans
  -> FINALIZING       posting penjualan atomik
  -> COMPLETED        sale_id dan receipt_no sudah terbentuk

PENDING -> EXPIRED    QR kedaluwarsa, reservasi dilepas
PENDING -> DENIED     pembayaran ditolak, reservasi dilepas
PENDING -> CANCELLED  dibatalkan sebelum dibayar, reservasi dilepas

SETTLEMENT/COMPLETED -> REFUND_PENDING -> REFUNDED/PARTIAL_REFUND
SETTLEMENT/COMPLETED -> REFUND_FAILED   perlu tindakan Owner

Keadaan khusus:
SETTLEMENT -> PAID_NEEDS_ACTION
```

`PAID_NEEDS_ACTION` dipakai jika uang telah diterima tetapi penjualan gagal diposting karena masalah tak terduga. Status ini harus tampil merah pada Owner, tidak boleh dihapus otomatis, dan penyelesaiannya wajib diaudit. Dengan reservasi yang benar, stok habis bukan alasan yang semestinya terjadi.

## 4. Model data

### `payment_gateway_intents`

- identitas: `id`, `tenant_id`, `outlet_id`, `shift_id`, `cashier_id`
- gateway: `provider=MIDTRANS`, `environment=SANDBOX|PRODUCTION`, `channel=QRIS_DYNAMIC`
- referensi: `order_id` unik global, `gateway_transaction_id`, `sale_id`
- nilai: `gross_amount`, `currency=IDR`
- snapshot: keranjang, pelanggan, harga, promo, voucher, otorisasi diskon, dan catatan yang sudah dihitung server
- status internal dan status terakhir gateway
- `idempotency_key` unik per percobaan checkout
- `expires_at`, waktu settlement, finalisasi, pembatalan, dan refund
- QR action URL hanya disimpan bila perlu; jangan menyimpan Server Key atau data sensitif lain
- `last_gateway_payload` disanitasi dan dibatasi ukurannya untuk audit
- `failure_code` dan `failure_message` yang aman ditampilkan

### `stock_reservations`

- satu baris per produk/lokasi/intent
- `quantity_base`, `status=ACTIVE|CONSUMED|RELEASED`
- kedaluwarsa mengikuti intent
- indeks unik mencegah reservasi ganda untuk intent dan produk yang sama

### `payment_gateway_events`

- append-only untuk hash payload, jenis status, waktu diterima, hasil verifikasi, dan hasil pemrosesan
- deduplikasi event mencegah webhook yang sama diproses dua kali
- payload sensitif tidak disimpan mentah tanpa batas

## 5. Transaksi database atomik

### Membuat intent

Satu RPC database harus:

1. mengunci baris stok yang dibutuhkan;
2. menghitung `tersedia = stok fisik - reservasi aktif`;
3. menolak jika tidak cukup;
4. membuat intent dan reservasi;
5. mengembalikan `order_id` dan waktu kedaluwarsa.

Jika panggilan Charge Midtrans gagal, API melepas reservasi dengan RPC idempoten. Proses pembersih berkala juga melepas intent kedaluwarsa yang tertinggal.

### Menyelesaikan intent

Satu RPC finalisasi harus:

1. mengunci intent dan seluruh reservasinya;
2. mengembalikan hasil lama bila `sale_id` sudah ada;
3. memastikan status terverifikasi `SETTLEMENT` dan nominal cocok;
4. memastikan reservasi masih aktif;
5. membuat penjualan, item, pembayaran `QRIS`, jurnal, poin, dan voucher;
6. mengonsumsi reservasi;
7. menautkan `sale_id` ke intent;
8. commit seluruhnya atau rollback seluruhnya.

Tidak boleh ada urutan “buat sale lalu update intent” dalam dua transaksi terpisah.

## 6. Alur kasir

1. Kasir memilih **QRIS Dinamis** lalu menekan **Buat QR pembayaran**.
2. Nusa menghitung ulang harga di server dan mereservasi stok.
3. Nusa meminta QR ke Midtrans dan menampilkan QR, nominal yang tidak bisa diedit, batas waktu, serta status **Menunggu pembayaran**.
4. Browser melakukan polling ringan sebagai cadangan; sumber utama tetap webhook.
5. Setelah settlement terverifikasi, layar berubah menjadi **Pembayaran berhasil**, sale diposting, lalu struk tersedia.
6. Tombol tutup sebelum pembayaran tidak menyelesaikan transaksi. Intent tetap dapat dibuka kembali sampai batal/kedaluwarsa.
7. Jika kedaluwarsa, kasir dapat membuat QR baru dengan `order_id` baru.

Kasir tidak pernah diberi tombol “Anggap sudah dibayar” untuk QRIS dinamis.

## 7. Gangguan dan pemulihan

- **Webhook terlambat:** polling status atau rekonsiliasi terjadwal akan menemukan settlement.
- **Webhook berulang/tidak berurutan:** status tidak boleh mundur; finalisasi idempoten.
- **Browser/APK ditutup:** intent tetap hidup di server dan dapat dibuka kembali.
- **Cloudflare/Supabase sementara gagal setelah pelanggan bayar:** intent menjadi `PAID_NEEDS_ACTION`; worker rekonsiliasi mencoba lagi dan Owner mendapat peringatan.
- **Nominal/status tidak cocok:** jangan buat sale; karantina sebagai anomali.
- **Shift hendak ditutup:** tampilkan jumlah intent pending dan arahkan kasir menyelesaikan atau menunggu kedaluwarsa.
- **Aplikasi restart:** daftar intent aktif dimuat dari server, bukan hanya memori browser.

## 8. Void, retur, dan refund

- `PENDING`: boleh dibatalkan; reservasi dilepas. Bila gateway menyediakan cancel, panggil cancel secara idempoten.
- `COMPLETED` dan belum ada refund: tombol Void lama disembunyikan/diblokir. Owner memilih retur/refund.
- Refund harus dikirim ke Midtrans dengan `refund_key` unik, lalu status lokal mengikuti hasil gateway.
- Stok kembali hanya berdasarkan keputusan retur barang, bukan hanya karena refund uang.
- Refund gagal tidak boleh menghapus retur maupun mengubah transaksi seolah selesai; tampilkan kewajiban pembayaran kepada pelanggan.
- Biaya MDR dan settlement Midtrans direkonsiliasi terpisah dari nilai penjualan bruto.

## 9. Akuntansi dan rekonsiliasi

- Saat settlement: debit `QRIS Belum Cair`, kredit penjualan/pajak sesuai jurnal Nusa.
- Saat dana cair: debit bank, debit biaya MDR, kredit `QRIS Belum Cair`.
- Dashboard rekonsiliasi membandingkan Nusa, status Midtrans, dan settlement/bank.
- Selisih nominal, pembayaran tanpa sale, sale tanpa settlement, refund tertunda, dan intent terlalu lama harus terlihat oleh Owner.

## 10. Keamanan

- Basic Auth Midtrans dibuat server-side dengan Server Key.
- Webhook menerima HTTPS saja, membatasi ukuran body, memvalidasi JSON, signature, payment type, currency, order ID, tenant intent, nominal, dan status hasil Get Status.
- Endpoint webhook tidak memakai sesi pengguna tetapi tidak dapat melakukan apa pun tanpa intent lokal yang cocok.
- Endpoint kasir tetap memerlukan sesi, permission `pos.sell`, outlet, dan shift yang sesuai.
- Rate limit diterapkan pada create/status; order ID tidak dapat ditebak dan tidak memuat data pelanggan.
- Log menyensor authorization, Server Key, token, email, telepon, dan payload berlebih.

## 11. Tahapan peluncuran

### Tahap A — Sandbox teknis

- integrasi kunci Sandbox, Charge, QR, webhook, Get Status, event log;
- label besar **SIMULASI — TIDAK MENERIMA UANG ASLI**;
- tidak menyentuh penjualan dan stok operasional;
- uji pending, settlement, expire, deny, webhook duplikat, signature palsu, nominal salah, dan Worker restart.

### Tahap B — Sandbox end-to-end terisolasi

- aktifkan reservasi dan finalisasi pada tenant/outlet khusus UAT;
- uji dua kasir berebut stok terakhir, shift ditutup saat pending, voucher, poin, diskon berizin, retry, dan pemulihan gangguan;
- split payment tetap nonaktif.

### Tahap C — Pilot Production terbatas

- hanya satu outlet dan daftar kasir yang dipilih;
- batas nominal dan jumlah transaksi harian;
- QRIS statis tetap tersedia sebagai fallback;
- pantau anomali dan rekonsiliasi setiap hari.

### Tahap D — Produksi umum

- dibuka setelah pilot tanpa anomali uang/stok;
- refund terintegrasi dan rekonsiliasi settlement sudah digunakan;
- split payment baru dirancang terpisah bila benar-benar dibutuhkan.

## 12. Kriteria lulus sebelum uang asli

- 100% pengujian otomatis dan skenario UAT kritis lulus.
- Satu settlement selalu menghasilkan tepat satu sale dan satu receipt.
- Signature palsu, nominal salah, dan order asing menghasilkan nol perubahan bisnis.
- Reservasi selalu dikonsumsi atau dilepas; tidak ada stok menggantung.
- Recovery berhasil ketika webhook hilang, datang dua kali, datang terlambat, atau layanan restart.
- Sale gateway tidak bisa di-void melalui jalur tunai.
- Shift tidak bisa ditutup saat ada intent pending.
- Owner dapat melihat dan menyelesaikan `PAID_NEEDS_ACTION` tanpa mengedit database manual.
- Backup dan prosedur insiden sudah diuji.

## 13. Keputusan implementasi awal

- Gunakan **Midtrans Core API QRIS**, bukan menganggap QR sebagai bukti bayar.
- Pertahankan QRIS statis sebagai metode manual yang namanya jelas.
- Mulai dari Sandbox dan satu metode penuh; jangan mulai dari split payment.
- Jangan mengaktifkan Production hanya karena QR Sandbox berhasil. Production menunggu reservasi, refund, rekonsiliasi, dan seluruh kriteria lulus.
