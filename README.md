# Sampai Mana — API

Backend untuk **Sampai Mana**, pelacak perkembangan kasus hukum publik di Indonesia: dari pelaporan, penyidikan, penuntutan, persidangan, sampai putusan.

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
- **Impor semi-otomatis dari SIPP.** SIPP (`sipp.pn-*.go.id`) dilindungi reCAPTCHA, jadi API **tidak** mengambil atau mem-bypass halamannya. Redaksi membuka halaman *Detil Perkara* di browser sendiri, menyalin HTML (simpan halaman / view-source) atau teks (select all), lalu menempelkannya di panel admin. Parser berbasis label (`src/lib/sipp.js`, toleran terhadap perubahan tata letak) membaca nomor perkara, pengadilan, klasifikasi, tanggal pendaftaran, status, pihak, tabel *Jadwal Sidang*, dan tanggal/amar putusan, lalu mengusulkan tahapan: pendaftaran → tahapan PERSIDANGAN aktif (jadwal sidang berikutnya menjadi `dueAt`) dan putusan → tahapan PUTUSAN. Usulan yang menduplikasi tahapan yang ada (jenis sama, hari mulai sama) dibuang. `POST /api/admin/cases/:id/sipp/preview` tidak menulis apa pun; `.../sipp/apply` membuat usulan terpilih lewat jalur "tambah tahapan" yang sama (sinkronisasi status, revisi `SIPP_IMPORT`, notifikasi pengikut) dan menyimpan `sippUrl`. Hanya EDITOR/SUPER_ADMIN; teks maksimal 2 MB.
- **Perhatian redaksi dan pengingat harian.** `GET /api/admin/attention` menampilkan tahapan aktif yang lewat tenggat, yang jatuh tempo dalam 7 hari, dan kasus aktif tanpa aktivitas lebih dari `STALE_DAYS` hari. Pekerjaan harian di proses API (`src/jobs/scheduler.js`, dijalankan setelah 07:00 WIB) mengirim ringkasan ke setiap EDITOR dan SUPER_ADMIN sebagai notifikasi (`EDITORIAL_REMINDER`, tautan `/redaksi`) dan email bila SMTP aktif; tidak mengirim bila ketiga daftar kosong. Aman dijalankan di banyak instance: `pg_try_advisory_lock` plus tabel `job_runs` (unik per nama dan tanggal) menjamin hanya satu pengiriman per hari. Diatur oleh `REMINDERS_ENABLED`.
- **Tren dan durasi.** `GET /api/stats/trends?groupBy=institution|court|region|category` mengukur hari dari penyidikan sampai putusan per kelompok, **hanya dari tahapan terverifikasi** (tahapan yang punya sumber berstatus terverifikasi). Setiap kelompok membawa jumlah sampel; kelompok dengan sampel kurang dari 3 ditandai `lowSample` dan tidak diperingkat. Respons juga memuat `coverage` (berapa kasus/tahapan yang terukur) dan `method`. Cache memori 5 menit, dibersihkan saat ada perubahan dari admin. Hitungan ada di `src/lib/durations.js`.
- **Halaman pihak dan lembaga (SEO).** `GET /api/people/:slug`, `GET /api/institutions`, `GET /api/institutions/:slug`, dan `GET /api/sitemap-data` untuk sitemap situs web. Tiap pihak punya `slug` (bukan unik: orang yang sama bisa muncul di beberapa kasus) yang tampil di `defendants[].slug` pada detail kasus.

## Keamanan

- Server menolak start bila `JWT_SECRET` kurang dari 32 karakter, atau bila `CORS_ORIGIN` kosong atau `*` di production.
- Access token JWT berumur 15 menit dan disimpan di memori klien. Refresh token *opaque* disimpan di cookie `httpOnly; Secure; SameSite=Strict; Path=/api/auth`, dirotasi setiap dipakai, dan hanya hash-nya yang tersimpan di DB. Pemakaian ulang token lama mencabut seluruh keluarga sesi.
- `helmet`, rate limit (umum, login/daftar, dan endpoint tulis publik), batas ukuran body, dan bcrypt cost 12.
- `sort` dan `limit` di-*whitelist* (maks 50). Pengguna yang diblokir langsung kehilangan akses.
- Log audit internal menyamarkan field sensitif.

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

Untuk perubahan skema, ubah `prisma/schema.prisma` lalu jalankan `pnpm migrate:dev --name <nama>`. Jangan pakai `db push`.

Seed bersifat idempoten dan **tidak pernah menghapus data**. Seed memastikan kategori dasar ada, membuat SUPER_ADMIN dari env bila belum ada, dan mengisi kasus demo hanya bila `SEED_DEMO=true` dan tabel kasus masih kosong.

## Test

```bash
pnpm test:unit          # 119 unit test, tanpa database (juga jalan di pre-commit)
pnpm test:coverage      # unit test + laporan coverage
pnpm test:integration   # 50 test HTTP + Postgres sungguhan, butuh TEST_DATABASE_URL
```

- **Unit** (`test/unit`) menguji parser SIPP (fixture HTML dan teks di `test/fixtures/sipp`), usulan tahapan, hitungan durasi, seleksi pengingat harian, validasi env, slug, deteksi file dari *magic bytes*, pengaman path traversal, pemetaan error, paginasi, RBAC, token JWT, penyamaran log audit, escape CSV, filter pencarian, dan bypass rate limit internal.
- **Integration** (`test/integration`) menguji alur auth dan rotasi token, RBAC, sinkronisasi tahapan dan status, notifikasi, unggahan, moderasi, koreksi, ekspor, impor SIPP, perhatian redaksi dan pengingat harian, tren, serta halaman pihak dan lembaga. Test ini memakai DB yang namanya harus mengandung `test`; migrasi diterapkan dengan `migrate deploy` dan data dibersihkan dengan `TRUNCATE`.

## Konfigurasi opsional

| Env | Default | Fungsi |
| --- | --- | --- |
| `REMINDERS_ENABLED` | `true` di production, selain itu `false` | Menyalakan pengingat redaksi harian di proses API. |
| `STALE_DAYS` | `30` | Kasus aktif tanpa aktivitas selama ini dianggap menggantung. |
| `SMTP_URL` | kosong | Bila diisi, pengingat dan notifikasi juga dikirim lewat email. |

Daftar lengkap ada di `.env.example`.

## CI/CD

`.github/workflows/deploy.yml` berjalan di setiap push ke `main`:

1. Unit dan integration test di GitHub Actions dengan service container Postgres.
2. Build image, lalu push ke `ghcr.io/mrfroglab/api-sampaimana` (`latest` dan sha).
3. Deploy oleh runner self-hosted di server: `docker compose pull api && up -d --no-deps api`, lalu cek health. Migrasi berjalan otomatis saat container start.

Pull request hanya menjalankan test.

## Dokumentasi API

Swagger UI ada di `/api/docs`, dan spesifikasi mentahnya di `/api/openapi.json`.

## Deploy

Image Docker menjalankan `prisma migrate deploy` lalu seed (idempoten) sebelum start. Upload disimpan di `/data/uploads`, jadi pasang volume. Setup awal stack di server ada di `deploy/` pada repo web; update berikutnya lewat CI/CD.
