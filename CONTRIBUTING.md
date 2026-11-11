# Berkontribusi ke API Sampai Mana

Alur kerja umum (branch, format commit, PR, changelog, perubahan lintas repo, aturan QA) berlaku untuk kedua repo dan ditulis di
**[CONTRIBUTING.md repo web](https://github.com/mrfroglab/sampaimana/blob/main/CONTRIBUTING.md)**. Dokumen ini hanya berisi hal
khusus API.

## Sebelum push

```bash
pnpm run check                     # sintaks
pnpm test:unit                     # juga jalan otomatis di pre-commit, bersama docs:check
pnpm test:integration              # butuh TEST_DATABASE_URL (nama DB harus mengandung "test")
pnpm docs:check --no-changelog
pnpm changelog                     # commit terakhir sebelum PR dan setelah setiap rebase: docs(changelog): update
```

Postgres sementara untuk integration test:

```bash
docker run -d --rm --name sm-testdb -e POSTGRES_USER=sm -e POSTGRES_PASSWORD=sm -e POSTGRES_DB=sampaimana_test \
  -p 127.0.0.1:55433:5432 postgres:16-alpine
TEST_DATABASE_URL=postgresql://sm:sm@127.0.0.1:55433/sampaimana_test pnpm test:integration
docker stop sm-testdb              # hapus setelah selesai
```

## Migrasi database

- Ubah `prisma/schema.prisma`, lalu `pnpm migrate:dev --name <nama_singkat>`. **Jangan pakai `db push`.**
- **Jangan mengedit migrasi yang sudah masuk `main`.** Migrasi itu sudah diterapkan di produksi. Buat migrasi baru.
- **Buat migrasi yang aditif.** Kolom baru harus *nullable* atau punya default; jangan menghapus atau mengganti nama kolom dalam satu
  langkah. Migrasi berjalan otomatis saat container start, dan web versi lama tetap jalan selama jeda antara deploy API dan web.
  Rollback image juga tidak membatalkan migrasi.
- Menghapus kolom dilakukan dua tahap: berhenti memakainya (deploy), lalu hapus di PR berikutnya.
- Data pribadi baru di skema? Perbarui `docs/legal/PRIVACY.md` di repo web (lihat tabel lintas repo di peta dokumentasi).

## Endpoint baru

1. Tambahkan rute di `src/modules/*.js` dengan validasi Zod.
2. Tambahkan entri di `src/docs/openapi.js`. `pnpm docs:check` gagal bila ada rute yang tidak tercantum.
3. Tambahkan integration test di `test/integration`.
4. Endpoint publik? Perbarui daftar endpoint di halaman `/data` repo web (`app/routes/data.tsx`).
5. Perubahan bentuk respons yang merusak klien lama ditandai `feat!:` / `fix!:`.

## Env baru

1. Tambahkan ke skema di `src/config/env.js` dengan default yang aman.
2. Tambahkan ke `.env.example` beserta komentar artinya. `pnpm docs:check` gagal bila keduanya tidak cocok.
3. Perlu diisi di server? Teruskan di `deploy/docker-compose.yml` repo web, lalu catat di `deploy/OPS.md`.

## Rumus statistik

Perubahan di `src/lib/durations.js` atau `src/lib/attention.js` ikut memperbarui [docs/METHODOLOGY.md](docs/METHODOLOGY.md) dan
teks metodologi di halaman `/tren` repo web.

## Lisensi

Dengan berkontribusi, Anda setuju kontribusi kode Anda dirilis dengan lisensi [AGPL-3.0](LICENSE).
