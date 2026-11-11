# Metodologi angka

Cara API menghitung angka yang tampil di `/statistik`, `/tren`, dan daftar "perlu dicek" di meja redaksi. Kalau rumus atau ambang
di kode berubah, ubah dokumen ini dan teks metodologi di halaman `/tren` (repo web, `app/routes/trends.tsx`) di PR yang sama.

## Istilah

- **Tahapan**: satu baris `case_stages` dengan `stageType` (PELAPORAN, PENYIDIKAN, PENUNTUTAN, PERSIDANGAN, PUTUSAN), `startedAt`,
  dan bila sudah selesai `endedAt`.
- **Tahapan terverifikasi**: tahapan yang punya minimal satu sumber berstatus terverifikasi (`sources.isVerified`). Hanya redaksi
  yang bisa memverifikasi sumber. Lihat standar verifikasi di panduan redaksi (`docs/EDITORIAL.md` repo web).
- Semua durasi dalam **hari**, dibulatkan satu angka di belakang koma. Kasus yang diarsipkan tidak dihitung.

## Statistik umum (`GET /api/stats`, halaman `/statistik`)

Durasi rata-rata dan median per jenis tahapan = `endedAt − startedAt`, dari **semua** tahapan yang sudah selesai (punya `endedAt`
yang tidak lebih awal dari `startedAt`). Angka ini **tidak** memakai filter terverifikasi. Gunanya memberi gambaran isi basis data,
bukan klaim tentang kinerja lembaga.

## Tren (`GET /api/stats/trends`, halaman `/tren`)

Kode: `src/lib/durations.js` (fungsi murni, diuji di `test/unit`).

Karena tren membandingkan lembaga, **hanya tahapan terverifikasi** yang dihitung.

### Ukuran utama: penyidikan → putusan

Per kasus: jumlah hari dari tahapan PENYIDIKAN terverifikasi **paling awal** sampai tahapan PUTUSAN terverifikasi **paling awal**.
Kasus tidak terukur bila salah satunya tidak ada, atau bila putusan tercatat lebih awal dari penyidikan.

### Durasi per tahapan

`startedAt → endedAt`. Bila `endedAt` kosong, akhirnya adalah awal tahapan berikutnya. Tahapan berikutnya diambil dari **semua**
tahapan, termasuk yang belum terverifikasi, karena tahapan itu tetap menandai berakhirnya tahapan sebelumnya. Tahapan yang masih
berjalan dan belum punya tahapan berikutnya tidak dihitung. Yang dilaporkan hanya durasi tahapan terverifikasi.

### Pengelompokan

`groupBy` = `institution` (lembaga), `court` (pengadilan), `region` (wilayah), atau `category` (kategori). Nama yang ditulis sedikit
berbeda tetapi menghasilkan *slug* yang sama digabung menjadi satu kelompok.

Per kelompok dilaporkan: jumlah kasus, berjalan/diputus, jumlah sampel (kasus yang terukur), median, rata-rata, minimum, maksimum,
dan median per tahapan.

### Ambang sampel dan peringkat

- **Sampel minimal = 3** (`MIN_SAMPLES`). Kelompok dengan sampel kurang dari 3 tetap ditampilkan tetapi ditandai `lowSample` dan
  tidak ikut diperingkat bersama kelompok yang cukup sampelnya.
- Urutan: kelompok dengan sampel cukup, dari median **paling lambat**; lalu kelompok bersampel tipis; lalu kelompok yang belum bisa
  diukur sama sekali.
- `coverage` di respons menunjukkan berapa kasus yang terukur dan berapa tahapan yang terverifikasi dari seluruh data. Tampilkan
  angka ini bersama peringkat agar pembaca tahu seberapa kuat dasarnya.

Hasil di-*cache* di memori selama 5 menit dan dibersihkan setiap ada perubahan dari admin.

## Perlu dicek (`GET /api/admin/attention`, ringkasan redaksi harian)

Kode: `src/lib/attention.js`. Hanya kasus aktif (tidak diarsipkan).

| Daftar | Aturan |
| --- | --- |
| Lewat tenggat (`OVERDUE`) | Tahapan berstatus AKTIF dengan `dueAt` sebelum sekarang |
| Jatuh tempo (`DUE_SOON`) | Tahapan AKTIF dengan `dueAt` dalam 7 hari ke depan |
| Menggantung (`STALE`) | Kasus yang belum berstatus PUTUSAN dan `lastActivityAt`-nya lebih lama dari `STALE_DAYS` hari (default 30) |

Hari dihitung sebagai hari penuh (dibulatkan ke bawah). Tiap daftar dibatasi 200 baris. Ringkasan harian dikirim setelah 07:00 WIB
hanya bila minimal satu daftar berisi. Penjadwalannya dijelaskan di README, bagian fitur "Perhatian redaksi dan pengingat harian".
