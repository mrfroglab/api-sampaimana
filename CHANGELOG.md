# Changelog

<!-- Dibuat otomatis oleh scripts/changelog.mjs dari commit feat/fix/perf/security. Jangan diedit manual: jalankan `pnpm changelog`. -->

Perubahan yang terasa bagi pengguna, dikelompokkan per tanggal (WIB). Detail teknis ada di riwayat commit.

## 2026-11-10

### Fitur

- **auth:** account lockout, two-factor sign-in, session list, breached-password and disposable-email checks
- **stats:** trends from verified stages only, with sample counts, coverage and method
- **jobs:** log the editorial digest outcome, including when SMTP is not configured
- **admin:** flag cases that need checking in the admin list and filter with ?attention=check
- **sipp:** record the SIPP page as a court source on every imported stage
- **public:** trends, people, institutions and sitemap data
- **jobs:** daily editorial digest with advisory lock and per-day idempotency
- **admin:** SIPP import, editorial attention list, sippUrl and defendant slugs
- **stats:** pure duration and trend math
- **sipp:** label-driven parser and stage proposals for pasted SIPP pages
- **db:** add sippUrl, defendant slug, job_runs and EDITORIAL_REMINDER
- rebuild API v2 with hardened auth, timeline sync and moderation

### Perbaikan

- per-visitor rate limits behind the proxy and quiet anonymous refresh
