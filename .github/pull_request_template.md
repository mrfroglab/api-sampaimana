## Ringkasan

<!-- Apa yang berubah dan kenapa. Tautkan PR pasangan di repo web bila ada. -->

## Checklist

- [ ] Dokumen terdampak sudah diperbarui di PR ini (lihat `CLAUDE.md` dan peta dokumentasi di repo web)
- [ ] Rute baru/berubah tercantum di `src/docs/openapi.js`; env baru tercantum di `.env.example`
- [ ] Migrasi aditif, dan tidak mengedit migrasi yang sudah ada di `main`
- [ ] Data pribadi baru atau pihak ketiga baru? → PR pasangan memperbarui `docs/legal/PRIVACY.md` di repo web
- [ ] Env yang harus diisi di server? → PR pasangan memperbarui `deploy/docker-compose.yml` + `deploy/OPS.md` di repo web
- [ ] `pnpm changelog` dijalankan setelah rebase terakhir
- [ ] `pnpm run check && pnpm test:unit && pnpm docs:check` lulus; `pnpm test:integration` bila menyentuh DB
