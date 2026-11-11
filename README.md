# Sampai Mana — API

Backend untuk **Sampai Mana**, pelacak perkembangan kasus hukum publik di Indonesia: dari pelaporan, penyidikan, penuntutan,
persidangan, sampai putusan. Situs web dan meja redaksinya ada di [`mrfroglab/sampaimana`](https://github.com/mrfroglab/sampaimana).

Node.js 22 · Express 5 · Prisma 6 · PostgreSQL 16 · Zod 4 · Vitest

## Fitur

- **Linimasa kasus.** Setiap kasus punya tahapan, tenggat (`dueAt`), artikel penjelasan per tahapan, dan sumber. Menambah tahapan berstatus *AKTIF* otomatis menutup tahapan sebelumnya dan menggeser status kasus.
- **Riwayat revisi publik.** Setiap perubahan status, tahapan, artikel, sumber, dan koreksi tercatat di `case_revisions` dan bisa dibaca publik. Perubahan status langsung wajib disertai alasan.
- **Sumber terverifikasi.** Sumber bertipe resmi, putusan pengadilan, media, atau lainnya, dengan tanda verifikasi oleh redaksi.
- **Ikuti kasus dan notifikasi.** Notifikasi di aplikasi, plus email bila `SMTP_URL` diisi.
- **Kontribusi publik.** File bukti diperiksa dari *magic bytes* (bukan ekstensi) dan disimpan privat. Akun baru dibatasi, dan moderator melihat reputasi kontributor. Kontribusi yang diterima bisa langsung dijadikan tahapan dan tautannya diimpor sebagai sumber.
- **Hak jawab dan koreksi.** Formulir publik tanpa login, dibatasi rate limit dan dilengkapi honeypot. Catatan koreksi bisa ditampilkan di riwayat kasus.
- **Data terbuka.** `GET /api/cases/export.csv` dan `export.json` (CC BY 4.0). CSV aman dari *formula injection*.
- **Statistik.** Rata-rata dan median durasi tiap tahapan, kasus aktif terlama, dan pembaruan terbaru.
- **Impor semi-otomatis dari SIPP.** SIPP dilindungi reCAPTCHA, jadi API **tidak** mengambil halamannya. Redaksi menempelkan halaman *Detil Perkara*, parser berbasis label (`src/lib/sipp.js`) membacanya, lalu mengusulkan tahapan persidangan dan putusan yang bisa dipilih. `POST /api/admin/cases/:id/sipp/preview` tidak menulis apa pun; `.../sipp/apply` membuat usulan terpilih lewat jalur "tambah tahapan" yang sama. Panduan dan aturan usulannya: [docs/SIPP-IMPORT.md](docs/SIPP-IMPORT.md).
- **Perhatian redaksi dan pengingat harian.** `GET /api/admin/attention` menampilkan tahapan aktif yang lewat tenggat, yang jatuh tempo dalam 7 hari, dan kasus yang menggantung. Pekerjaan harian di proses API (`src/jobs/scheduler.js`, setelah 07:00 WIB) mengirim ringkasan ke setiap EDITOR dan SUPER_ADMIN sebagai notifikasi (`EDITORIAL_REMINDER`) dan email bila SMTP aktif, hanya bila ada isinya. Aman dijalankan di banyak instance: `pg_try_advisory_lock` plus tabel `job_runs` (unik per nama dan tanggal) menjamin satu pengiriman per hari. Diatur oleh `REMINDERS_ENABLED`.
- **Tren dan durasi.** `GET /api/stats/trends?groupBy=institution|court|region|category` mengukur hari dari penyidikan sampai putusan per kelompok, **hanya dari tahapan terverifikasi**, lengkap dengan jumlah sampel, `coverage`, dan `method`. Rumus dan ambangnya: [docs/METHODOLOGY.md](docs/METHODOLOGY.md).
- **Halaman pihak dan lembaga (SEO).** `GET /api/people/:slug`, `GET /api/institutions`, `GET /api/institutions/:slug`, dan `GET /api/sitemap-data` untuk sitemap situs web. Tiap pihak punya `slug` (bukan unik: orang yang sama bisa muncul di beberapa kasus) yang tampil di `defendants[].slug` pada detail kasus.

## Keamanan

- Server menolak start bila `JWT_SECRET` kurang dari 32 karakter, atau bila `CORS_ORIGIN` kosong atau `*` di production.
- Access token JWT berumur 15 menit dan disimpan di memori klien. Refresh token *opaque* disimpan di cookie `httpOnly; Secure; SameSite=Strict; Path=/api/auth`, dirotasi setiap dipakai, dan hanya hash-nya yang tersimpan di DB. Pemakaian ulang token lama mencabut seluruh keluarga sesi.
- **Sesi.** Pengguna bisa melihat sesi aktif (waktu dan *user agent*), mencabut satu sesi, atau mencabut semua sesi lain.
- **Lockout.** Akun dikunci sementara setelah `LOGIN_MAX_FAILURES` kali gagal masuk (default 10) selama `LOGIN_LOCK_MINUTES` menit (default 15). SUPER_ADMIN bisa membuka kunci.
- **Verifikasi dua langkah (TOTP).** Rahasia disimpan terenkripsi AES-256-GCM dengan kunci turunan `JWT_SECRET` (mengganti `JWT_SECRET` membuat 2FA semua pengguna harus di-reset). Kode pemulihan sekali pakai disimpan sebagai hash. Kode yang sama tidak bisa dipakai dua kali. SUPER_ADMIN bisa me-reset 2FA pengguna.
- **Pendaftaran.** Kata sandi yang pernah bocor ditolak lewat Have I Been Pwned (k-anonymity, hanya 5 karakter awal hash yang dikirim; `PWNED_CHECK`). Domain email sekali pakai ditolak. Cloudflare Turnstile aktif bila `TURNSTILE_SITE_KEY` dan `TURNSTILE_SECRET_KEY` diisi. Pendaftaran publik bisa ditutup dengan `REGISTRATION_OPEN=false`.
- `helmet`, rate limit (umum, login/daftar, dan endpoint tulis publik), batas ukuran body, dan bcrypt cost 12.
- `sort` dan `limit` di-*whitelist* (maks 50). Pengguna yang diblokir langsung kehilangan akses.
- Log audit internal menyamarkan field sensitif dan mencatat IP pada peristiwa keamanan akun.

Melaporkan celah keamanan: [SECURITY.md](SECURITY.md).

## Menjalankan secara lokal

```bash
docker run -d --name sampaimana-devdb -e POSTGRES_USER=sm -e POSTGRES_PASSWORD=sm \
  -e POSTGRES_DB=sampaimana -p 127.0.0.1:55432:5432 postgres:16-alpine

cp .env.example .env               # isi JWT_SECRET: openssl rand -hex 32
pnpm install
pnpm migrate:deploy                # terapkan migrasi
SEED_ADMIN_EMAIL=admin@local.test SEED_ADMIN_PASSWORD='ganti-dengan-12+karakter' SEED_DEMO=true pnpm seed
pnpm dev                           # http://localhost:5000/api/docs
```

Untuk perubahan skema, ubah `prisma/schema.prisma` lalu jalankan `pnpm migrate:dev --name <nama>`. Jangan pakai `db push`. Aturan
lengkapnya ada di [CONTRIBUTING.md](CONTRIBUTING.md).

Seed bersifat idempoten dan **tidak pernah menghapus data**. Seed memastikan kategori dasar ada, membuat SUPER_ADMIN dari env bila belum ada, dan mengisi kasus demo hanya bila `SEED_DEMO=true` dan tabel kasus masih kosong.

## Test

```bash
pnpm test:unit          # unit test, tanpa database (juga jalan di pre-commit)
pnpm test:coverage      # unit test + laporan coverage
pnpm test:integration   # test HTTP + Postgres sungguhan, butuh TEST_DATABASE_URL
pnpm docs:check         # dokumentasi sinkron dengan kode
```

- **Unit** (`test/unit`) menguji parser SIPP (fixture HTML dan teks di `test/fixtures/sipp`), usulan tahapan, hitungan durasi, seleksi pengingat harian, validasi env, slug, deteksi file dari *magic bytes*, pengaman path traversal, pemetaan error, paginasi, RBAC, token JWT, TOTP, penyamaran log audit, escape CSV, filter pencarian, dan bypass rate limit internal.
- **Integration** (`test/integration`) menguji alur auth, rotasi token, lockout, 2FA dan sesi, RBAC, sinkronisasi tahapan dan status, notifikasi, unggahan, moderasi, koreksi, ekspor, impor SIPP, perhatian redaksi dan pengingat harian, tren, serta halaman pihak dan lembaga. Test ini memakai DB yang namanya harus mengandung `test`; migrasi diterapkan dengan `migrate deploy` dan data dibersihkan dengan `TRUNCATE`.

## Konfigurasi

Semua env beserta artinya dan nilai default-nya ada di [`.env.example`](.env.example). Skemanya divalidasi di
`src/config/env.js`, dan `pnpm docs:check` memastikan keduanya selalu cocok.

## CI/CD

`.github/workflows/deploy.yml` berjalan di setiap push ke `main`:

1. Unit test, integration test (dengan service container Postgres), dan `docs:check` di GitHub Actions.
2. Build image, lalu push ke `ghcr.io/mrfroglab/api-sampaimana` (`latest` dan sha).
3. Deploy oleh runner self-hosted di server: `docker compose pull api && up -d --no-deps api`, lalu cek health. Migrasi berjalan otomatis saat container start.

Pull request hanya menjalankan test.

## Dokumentasi API

Swagger UI ada di `/api/docs`, dan spesifikasi mentahnya di `/api/openapi.json`. Spesifikasinya ditulis tangan di
`src/docs/openapi.js`; `pnpm docs:check` gagal bila ada rute yang belum tercantum.

## Deploy

Image Docker menjalankan `prisma migrate deploy` lalu seed (idempoten) sebelum start. Upload disimpan di `/data/uploads`, jadi pasang volume. Setup awal stack di server, backup, dan runbook insiden ada di `deploy/` repo web; update berikutnya lewat CI/CD.

## Dokumentasi

Peta lengkap dokumen kedua repo dan aturan sinkronisasinya ada di
[docs/README.md repo web](https://github.com/mrfroglab/sampaimana/blob/main/docs/README.md). Dokumen di repo ini:

- [CONTRIBUTING.md](CONTRIBUTING.md): migrasi, test, OpenAPI, dan alur kerja
- [CLAUDE.md](CLAUDE.md): instruksi untuk agen AI
- [SECURITY.md](SECURITY.md): melaporkan celah keamanan
- [CHANGELOG.md](CHANGELOG.md): perubahan per tanggal (dibuat otomatis)
- [docs/METHODOLOGY.md](docs/METHODOLOGY.md): cara durasi, tren, dan "perlu dicek" dihitung
- [docs/SIPP-IMPORT.md](docs/SIPP-IMPORT.md): panduan impor SIPP
- [.github/pull_request_template.md](.github/pull_request_template.md): checklist PR

## Lisensi

Kode: [GNU AGPL-3.0](LICENSE). Data kasus: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.id).
