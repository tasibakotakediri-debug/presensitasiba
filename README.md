# Tasiba 26 — Presensi & Kwitansi

## Menjalankan lokal di VS Code

1. Instal Node.js 20 atau lebih baru.
2. Jalankan `start.bat` dari terminal VS Code.
3. Buka http://127.0.0.1:3000.
4. Pada pemakaian pertama, buat username dan kata sandi admin. Kata sandi minimal 10 karakter.

Data lokal disimpan di `data/database.json`. Untuk hosting Cloudflare Pages, data disimpan di Cloudflare D1.

## Hosting Cloudflare Pages + D1

Cloudflare Pages menyajikan tampilan web dan menjalankan API melalui Pages Functions. D1 menyimpan akun admin, peserta, presensi, kwitansi, dan tautan spreadsheet. Tidak perlu Firebase atau Render.

1. Push repository ini ke GitHub, termasuk folder `functions` dan file `schema.sql`.
2. Di Cloudflare Dashboard, buka **Workers & Pages → Create application → Pages → Connect to Git**. Pilih repository Tasiba.
3. Pada pengaturan build, biarkan perintah build kosong dan isi **Build output directory** dengan `.` karena file situs berada di root repository. Simpan lalu mulai deployment.
4. Setelah proyek Pages dibuat, buka **Workers & Pages → D1 SQL Database → Create database**. Beri nama, misalnya `tasiba26`.
5. Buka proyek Pages → **Settings → Functions → D1 database bindings → Add binding**. Isi variable name dengan `DB`, pilih database `tasiba26`, simpan, lalu redeploy proyek.
6. Buka alamat Pages yang diberikan Cloudflare. Saat pertama kali dibuka, buat username dan kata sandi admin dari formulir **Buat akun admin**.

API akan membuat tabel D1 secara otomatis saat pertama kali dipanggil. `schema.sql` disediakan sebagai skema yang bisa diperiksa atau dijalankan manual melalui D1 Console. Jangan menaruh kata sandi atau token akun Cloudflare di repository.

Untuk menghubungkan spreadsheet, login admin, buka **Koneksi Spreadsheet**, tempel tautan Google Sheets dan simpan. Berikan akses Viewer atau publikasikan tab sebagai CSV. Klik **Impor / perbarui peserta** setelah spreadsheet berubah; sinkronisasi tidak berjalan otomatis. Presensi dan kwitansi tersimpan di D1.

## Keamanan dan cadangan

Kata sandi admin di-hash dengan PBKDF2. Sesi login menggunakan cookie `HttpOnly`, dan setiap endpoint data mensyaratkan sesi admin. Simpan cadangan database D1 secara berkala dari Cloudflare Dashboard atau gunakan fitur ekspor D1.

Untuk mengatur ulang kata sandi, gunakan **Atur ulang kata sandi** di halaman login; masukkan username, kata sandi saat ini, lalu kata sandi baru. Jika kata sandi admin hilang, hubungi administrator Cloudflare untuk mengelola database D1 secara langsung.
