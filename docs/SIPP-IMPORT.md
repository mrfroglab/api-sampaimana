# Impor dari SIPP

Panduan untuk EDITOR dan SUPER_ADMIN: mengisi tahapan persidangan dan putusan dari halaman SIPP pengadilan negeri
(`sipp.pn-*.go.id`). Kode: `src/lib/sipp.js` (parser dan usulan tahapan), `src/modules/sipp.js` (endpoint), dialog di repo web
`app/components/admin/SippImport.tsx`.

## Kenapa ditempel, bukan diambil otomatis

SIPP dilindungi reCAPTCHA. Sampai Mana **tidak** mengambil, men-*scrape*, atau mem-*bypass* halaman SIPP. Redaksi membuka halaman
di browser sendiri lalu menempelkan isinya, dan API hanya membaca teks yang ditempel.

## Langkah

1. Di meja redaksi, buka kasusnya (`/redaksi/kasus/:id`) lalu klik **Impor dari SIPP**.
2. Di tab lain, buka halaman **Detil Perkara** perkara itu di SIPP pengadilan yang bersangkutan.
3. Salin isinya: `Ctrl`+`A` lalu `Ctrl`+`C`. Bisa juga menyalin sumber HTML (*view-source*) atau menyimpan halaman. Keduanya
   terbaca.
4. Tempel ke kolom **Isi halaman SIPP**. Isi juga **Tautan halaman SIPP** (alamat di address bar), lalu klik **Baca halaman**.
5. Periksa bagian **Isi halaman yang terbaca**: nomor perkara, pengadilan, klasifikasi, tanggal pendaftaran, status, pihak, jadwal
   sidang, tanggal dan amar putusan. Baca juga **peringatan** bila ada.
6. Di **Usulan tahapan**, centang yang benar, lalu terapkan.
7. **Verifikasi sumbernya.** Setiap tahapan hasil impor otomatis mendapat sumber bertipe `COURT` yang menunjuk ke tautan SIPP,
   tetapi sumber itu **belum terverifikasi**. Buka tautannya, cocokkan isinya, lalu tandai terverifikasi di pengelola sumber. Tanpa
   langkah ini tahapan tidak ikut dihitung di `/tren` (lihat [METHODOLOGY.md](METHODOLOGY.md)).

Pratinjau (**Baca halaman**) tidak menyimpan apa pun. Data baru tertulis saat usulan diterapkan.

## Tahapan apa yang diusulkan

| Kondisi di SIPP | Usulan |
| --- | --- |
| Perkara terdaftar | Tahapan **PERSIDANGAN** "Perkara terdaftar di …", mulai tanggal pendaftaran. Aktif bila belum diputus, dengan jadwal sidang berikutnya sebagai tenggat. |
| Sudah ada tahapan PERSIDANGAN aktif, dan ada jadwal sidang baru | Tahapan PERSIDANGAN "Sidang: [agenda]" dengan tenggat tanggal sidang itu |
| Ada tanggal putusan | Tahapan **PUTUSAN**, mulai tanggal putusan, dengan ringkasan amar bila terbaca |

Aturan yang mencegah data ganda:

- Usulan dibuang bila sudah ada tahapan dengan **jenis sama dan hari mulai sama** (WIB).
- Jadwal sidang yang tanggalnya sudah menjadi tenggat tahapan PERSIDANGAN tidak diusulkan lagi.
- Usulan tidak dijadikan AKTIF bila kasus sudah punya tahapan yang lebih lanjut.
- Saat diterapkan, server membaca ulang teks dan membandingkannya dengan data **saat itu**, sehingga pratinjau yang sudah basi tidak
  bisa membuat duplikat.

Usulan yang diterapkan lewat jalur yang sama dengan "tambah tahapan" manual: status kasus ikut bergeser, revisi publik tercatat
dengan aksi `SIPP_IMPORT`, dan pengikut kasus mendapat notifikasi. Tautan SIPP disimpan di kasus (`sippUrl`).

## Bila hasilnya kurang tepat

- **"Tidak ada data SIPP yang dikenali"**: yang ditempel kemungkinan bukan halaman *Detil Perkara*, atau halamannya belum selesai
  dimuat saat disalin.
- **Tanggal tidak bisa dibaca**: peringatan menampilkan teks aslinya. Tambahkan tahapan itu secara manual.
- **"Nama pengadilan diambil dari singkatan pada nomor perkara"**: periksa ejaan nama pengadilan di data kasus.
- Parser membaca **label** seperti "Nomor Perkara" dan "Tanggal Pendaftaran", bukan susunan HTML, jadi tahan terhadap perubahan
  tampilan SIPP. Bila SIPP mengganti nama labelnya, parser perlu diperbarui. Tambahkan contoh halaman baru ke `test/fixtures/sipp`
  beserta test-nya.

## Batasan

- Teks maksimal 2 MB per tempelan.
- Hanya untuk format SIPP pengadilan negeri. Pengadilan tinggi dan Mahkamah Agung (banding, kasasi) belum didukung. Tambahkan
  tahapannya secara manual.
- Hanya EDITOR dan SUPER_ADMIN yang bisa memakai fitur ini.
