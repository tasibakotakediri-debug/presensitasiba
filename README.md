# Tasiba 26 — Presensi & Kwitansi

## Menjalankan aplikasi

1. Pastikan Node.js sudah terpasang.
2. Jalankan `start.bat`.
3. Buka http://127.0.0.1:3000 di browser.
4. Pada penggunaan pertama, buat username dan kata sandi admin. Kata sandi minimal 10 karakter.

Aplikasi hanya dapat dibuka setelah admin login. Tema terang/gelap dapat diganti dari tombol di bagian atas dan pilihan tema disimpan di browser. Tautan **Atur ulang kata sandi** ada di halaman login; untuk keamanan, reset memerlukan username dan kata sandi saat ini.

## Penyimpanan data

Server menyimpan peserta, presensi, kwitansi, dan hash kredensial admin secara permanen di `data/database.json`. Data tidak bergantung pada cache atau local storage browser. Jangan hapus file tersebut. Untuk cadangan, salin `data/database.json` ke lokasi lain secara berkala. Jika komputer atau disk rusak, pulihkan file cadangan.

Server secara bawaan hanya menerima koneksi dari komputer ini (`127.0.0.1`). Untuk mengambil daftar peserta dari Google Sheets, buka menu **Koneksi Spreadsheet**, tempel tautan ke tab yang benar, simpan, lalu pilih **Impor / perbarui peserta**. Berikan akses **Siapa saja yang memiliki link — Viewer**. Kolom wajib: `Nama Peserta` dan `Asal Sekolah`; `ID Peserta` opsional. Peserta akan dikelompokkan menurut sekolah. Impor memperbarui peserta dengan ID yang sama atau menambahkan peserta baru; impor tidak menghapus peserta lokal yang tidak ada di sheet.

Koneksi ini mengimpor data peserta dari Google Sheets ke database lokal Tasiba 26. Perubahan dari aplikasi tidak ditulis kembali ke Google Sheets secara otomatis. Ekspor presensi ke CSV tersedia di menu **Data & Spreadsheet**.

## Keamanan

Kata sandi admin disimpan sebagai hash scrypt, bukan teks biasa. Sesi admin berakhir setelah 12 jam atau saat logout. Jangan membagikan file database atau membuka port server ke jaringan publik tanpa menambahkan HTTPS dan pengamanan hosting.

## Merilis ke internet dengan Render

Tasiba 26 adalah aplikasi Node.js dengan API dan database file. Jangan unggah sebagai situs statis saja. Gunakan Render **Web Service**, bukan Static Site.

1. Buat repository GitHub **private** dan unggah file proyek. `data/database.json` sudah dikecualikan melalui `.gitignore`; jangan menghapus pengecualian itu.
2. Di Render pilih **New → Web Service**, lalu hubungkan repository tersebut.
3. Atur Build Command menjadi `npm install` dan Start Command menjadi `npm start`.
4. Tambahkan environment variable `NODE_ENV=production` dan `DATA_DIR=/var/data`. Render menyediakan `PORT`; server akan bind ke `0.0.0.0` saat production.
5. Tambahkan persistent disk dengan mount path `/var/data`. Tanpa disk persisten, file database bisa hilang setelah restart/deploy. Persistent disk Render hanya tersedia pada layanan berbayar; layanan disk juga berjalan satu instance.
6. Deploy, buka URL HTTPS Render, buat akun admin, lalu tautkan dan impor Google Sheets kembali. Database lokal di komputer tidak ikut terunggah otomatis.

Render memberikan URL `onrender.com` dan TLS/HTTPS untuk web service. Lihat panduan [Web Services](https://render.com/docs/web-services) dan [Persistent Disks](https://render.com/docs/disks) untuk detail dashboard dan batasannya.
