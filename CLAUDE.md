# CLAUDE.md — Sampai Mana API

Instruksi untuk agen AI (Claude Code dan sejenisnya) yang mengerjakan repo ini. Pasangan repo ini adalah `mrfroglab/sampaimana`
(web), yang memegang peta dokumentasi kedua repo.

## Konteks cepat

- Express 5 + Prisma 6 + PostgreSQL 16, CommonJS. Rute di `src/modules`, logika murni di `src/lib`, skema di
  `prisma/schema.prisma`, OpenAPI di `src/docs/openapi.js`, env di `src/config/env.js`.
- Hal khusus API: [CONTRIBUTING.md](CONTRIBUTING.md). Alur kerja umum: CONTRIBUTING.md repo web.
- **Merge/push ke `main` = deploy ke produksi**, termasuk migrasi database. Jangan push ke `main` atau merge PR tanpa persetujuan
  eksplisit pengelola.
- `PRD.md` (dokumen kebutuhan produk) ada di root checkout utama **repo web**, di-*gitignore*. Baca bila ada.

## Dokumentasi harus tetap sinkron

Peta semua dokumen ada di `docs/README.md` repo web
(https://github.com/mrfroglab/sampaimana/blob/main/docs/README.md). Aturannya:

1. **Setiap perubahan kode memperbarui dokumennya di commit/PR yang sama.** Di repo ini:
   - rute baru/berubah → `src/docs/openapi.js` (dicek otomatis)
   - env baru/berubah → `.env.example` (dicek otomatis)
   - rumus tren/durasi/"perlu dicek" → [docs/METHODOLOGY.md](docs/METHODOLOGY.md)
   - parser atau aturan usulan SIPP → [docs/SIPP-IMPORT.md](docs/SIPP-IMPORT.md)
   - fitur atau perilaku keamanan → [README.md](README.md)
2. **Perubahan yang berdampak ke repo web** juga harus diperbarui di sana, dalam PR pasangan yang saling menautkan:
   data pribadi atau pihak ketiga baru → `docs/legal/PRIVACY.md`; env yang harus diisi di server → `deploy/docker-compose.yml` dan
   `deploy/OPS.md`; endpoint publik → `app/routes/data.tsx`; rumus tren → `app/routes/trends.tsx`.
3. **Satu fakta, satu tempat.** Tautkan, jangan menyalin. Dokumen baru wajib dicantumkan di bagian "Dokumentasi" README (dicek
   otomatis) dan di peta repo web.
4. **Jangan menulis angka yang cepat basi** di dokumen, seperti jumlah test.
5. **Jangan mengedit `CHANGELOG.md` manual.** Jalankan `pnpm changelog` dan commit sebagai `docs(changelog): update`, sebagai commit
   terakhir sebelum membuka PR dan setelah setiap rebase. Bila rebase konflik di file itu, jalankan ulang skripnya.
6. Sebelum selesai: `pnpm run check && pnpm test:unit && pnpm docs:check`, plus `pnpm test:integration` bila menyentuh DB.

`scripts/changelog.mjs` identik di kedua repo. Bila diubah, ubah keduanya.

## Aturan lain

- Commit memakai Conventional Commits. Pesan commit dalam bahasa Inggris, pesan error dan dokumen dalam bahasa Indonesia.
- Jangan menambahkan trailer atribusi AI (`Co-Authored-By: Claude` dan sejenisnya) ke commit atau PR.
- Migrasi: aditif, jangan edit migrasi lama, jangan `db push`, jangan `migrate reset` di mana pun selain DB test sementara.
- QA: jangan memakai kredensial produksi. Pakai Postgres lokal sementara dan pengguna QA dari seed, lalu bersihkan.
- SIPP tidak boleh di-*scrape* atau di-*bypass* (reCAPTCHA). Impor hanya dari teks yang ditempel redaksi.
