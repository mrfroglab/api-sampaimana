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
pnpm test:unit          # 62 unit test, tanpa database (juga jalan di pre-commit)
pnpm test:coverage      # unit test + laporan coverage
pnpm test:integration   # 23 test HTTP + Postgres sungguhan, butuh TEST_DATABASE_URL
```

- **Unit** (`test/unit`) menguji validasi env, slug, deteksi file dari *magic bytes*, pengaman path traversal, pemetaan error, paginasi, RBAC, token JWT, penyamaran log audit, escape CSV, filter pencarian, dan bypass rate limit internal.
- **Integration** (`test/integration`) menguji alur auth dan rotasi token, RBAC, sinkronisasi tahapan dan status, notifikasi, unggahan, moderasi, koreksi, dan ekspor. Test ini memakai DB yang namanya harus mengandung `test`; migrasi diterapkan dengan `migrate deploy` dan data dibersihkan dengan `TRUNCATE`.

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
