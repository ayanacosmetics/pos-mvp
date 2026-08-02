# Checklist Uji Final Kasir Nusa

Checklist ini dilakukan setelah kandidat final dipasang. Gunakan produk contoh dan nominal kecil. Jangan langsung memindahkan seluruh operasional toko.

- [ ] `https://app.nusapos.my.id/api/health` merespons sukses.
- [ ] Keystore produksi permanen dibuat, dicadangkan di dua lokasi aman, dan kata sandinya disimpan di password manager.
- [ ] APK produksi ditandatangani keystore permanen; APK `1.3.0-uat` yang memakai debug key tidak dipakai untuk operasional.

## 1. Persiapan

- [ ] Nama usaha, alamat, telepon, dan pesan struk sudah benar.
- [ ] Outlet, gudang, dan perangkat kasir sudah terdaftar.
- [ ] Akun Owner, Admin, Kasir, Pembelian, dan Gudang memiliki akses yang sesuai.
- [ ] Owner sudah menjalankan **Kesehatan Sistem** tanpa temuan kritis.

## 2. Produk dan harga

- [ ] Scan barcode pcs memasukkan produk yang benar.
- [ ] Scan/pilih satuan lusin dan karton menghasilkan jumlah dasar yang benar.
- [ ] Harga ecer, grosir, dan harga bertingkat muncul pada jumlah yang tepat.
- [ ] Promo terjadwal menghasilkan harga sama di web, Android, dan Windows.
- [ ] Diskon manual meminta persetujuan dan tercatat pada audit.

## 3. Penjualan dan shift

- [ ] Kasir membuka shift dengan modal awal.
- [ ] Transaksi tunai menghitung kembalian dengan benar.
- [ ] Pembayaran QRIS/transfer/EDC dan split payment tersimpan dengan benar.
- [ ] Tahan dan lanjutkan transaksi tidak menggandakan penjualan.
- [ ] Struk menampilkan nomor, outlet, kasir, barang, pembayaran, dan total.
- [ ] Kasir menutup shift dan selisih kas dihitung benar.
- [ ] Kasir tidak dapat memakai atau menutup shift milik pengguna lain.

## 4. Pembelian dan stok

- [ ] Purchase Order dapat dibuat, disetujui, dan diterima sebagian/penuh.
- [ ] Restok menampilkan modal sebelumnya, perubahan modal, supplier, batch, dan EXP.
- [ ] Penerimaan menambah stok lokasi yang benar.
- [ ] Transfer mengurangi lokasi asal dan menambah lokasi tujuan dengan jumlah sama.
- [ ] Stok opname membuat jurnal selisih.
- [ ] Produk ber-EXP dipilih berdasarkan FEFO.

## 5. Retur dan rekening

- [ ] Retur pelanggan tidak melebihi jumlah yang terjual.
- [ ] Barang layak jual kembali ke stok; barang rusak tidak kembali ke stok jual.
- [ ] Retur kredit mengurangi piutang pelanggan.
- [ ] Retur supplier mengurangi batch dan membuat nota kredit/refund yang benar.
- [ ] Pembayaran piutang dan hutang mengurangi saldo serta masuk ke jurnal.

## 6. Offline dan banyak perangkat

- [ ] Putuskan internet setelah katalog termuat; aplikasi tetap membuka data terakhir.
- [ ] Buat transaksi offline lalu sambungkan internet dan sinkronkan.
- [ ] Pengiriman ulang tidak menggandakan transaksi atau stok.
- [ ] Konflik harga masuk ke layar Sinkronisasi dan dapat diputuskan Owner/Admin.
- [ ] Dua kasir menjual produk yang sama tanpa membuat saldo stok keliru.

## 7. Laporan dan pemulihan

- [ ] Penjualan, laba, retur, pembelian, dan stok sesuai transaksi uji.
- [ ] Audit menampilkan tindakan sensitif beserta pengguna dan waktu.
- [ ] Backup dapat diunduh dan hasil verifikasinya menyatakan file utuh.
- [ ] Kesehatan Sistem kembali aman setelah seluruh transaksi uji selesai.

## Keputusan

- [ ] **LULUS UAT** — boleh mulai pilot satu outlet/satu kasir.
- [ ] **PERLU REVISI** — catat nama layar, langkah, hasil yang muncul, hasil yang diinginkan, dan screenshot.

Pilot disarankan berlangsung 3–7 hari sebelum seluruh kasir dan outlet dipindahkan.
