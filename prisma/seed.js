/**
 * Idempotent seed. Never deletes data.
 *
 *  - Always: ensures the base categories exist.
 *  - SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD: creates that super admin if no
 *    super admin exists yet (password must be >= 12 characters).
 *  - SEED_DEMO=true: inserts the demo cases, only when the cases table is empty.
 */
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { slugify } = require('../src/lib/slug');

const prisma = new PrismaClient();

const CATEGORIES = [
  { slug: 'korupsi', name: 'Korupsi & Pencucian Uang', color: '#b42318', icon: 'landmark' },
  { slug: 'pidana-umum', name: 'Pidana Umum', color: '#1d4ed8', icon: 'gavel' },
  { slug: 'perdata', name: 'Perdata & Gugatan Warga', color: '#b45309', icon: 'scale' },
  { slug: 'lingkungan', name: 'Lingkungan & Agraria', color: '#15803d', icon: 'trees' },
  { slug: 'ham', name: 'Hak Asasi Manusia', color: '#7e22ce', icon: 'shield' },
];

const d = (s) => new Date(`${s}T00:00:00+07:00`);

const DEMO_CASES = [
  {
    category: 'korupsi',
    caseNumber: '27/Pid.Sus-TPK/2021/PN.Jkt.Pus',
    title: 'Korupsi Pengadaan Bantuan Sosial Penanganan Covid-19 di Kementerian Sosial',
    summary: 'Suap fee paket bansos sembako Covid-19 yang menjerat Menteri Sosial saat itu.',
    description:
      'Perkara tindak pidana korupsi berupa penerimaan fee dari perusahaan rekanan penyedia bantuan sosial sembako penanganan dampak pandemi Covid-19 di Kementerian Sosial RI, wilayah Jabodetabek tahun 2020.',
    institution: 'KPK',
    court: 'Pengadilan Tipikor Jakarta Pusat',
    region: 'DKI Jakarta',
    defendants: [
      { name: 'Juliari P. Batubara', role: 'Terpidana — Menteri Sosial 2019–2020' },
      { name: 'Adi Wahyono', role: 'Terpidana — Kuasa Pengguna Anggaran Kemensos' },
    ],
    stages: [
      ['PELAPORAN', '2020-12-05', '2020-12-06', 'Operasi tangkap tangan KPK', 'KPK melakukan operasi tangkap tangan terhadap pejabat Kemensos dan mengamankan uang tunai miliaran rupiah. Setelah ditetapkan sebagai tersangka, Juliari P. Batubara menyerahkan diri ke Gedung Merah Putih KPK pada 6 Desember 2020 dini hari.'],
      ['PENYIDIKAN', '2020-12-07', '2021-04-15', 'Pemeriksaan saksi dan penelusuran aliran dana', 'Penyidik KPK memeriksa puluhan saksi dari unsur birokrat Kemensos dan vendor, serta menelusuri dugaan fee Rp10.000 per paket bansos yang mengalir kepada pejabat kementerian.'],
      ['PENUNTUTAN', '2021-04-16', '2021-04-20', 'Pelimpahan berkas ke jaksa', 'Berkas penyidikan dinyatakan lengkap dan dilimpahkan kepada Jaksa Penuntut Umum KPK untuk disusun surat dakwaan.'],
      ['PERSIDANGAN', '2021-04-21', '2021-08-22', 'Persidangan di Pengadilan Tipikor', 'Jaksa mendakwa Juliari menerima suap sekitar Rp32,4 miliar dari para vendor. Sidang menghadirkan puluhan saksi, termasuk pejabat Kemensos dan rekanan penyedia bansos.'],
      ['PUTUSAN', '2021-08-23', null, 'Vonis 12 tahun penjara', 'Majelis hakim menjatuhkan pidana 12 tahun penjara, denda Rp500 juta, uang pengganti sekitar Rp14,5 miliar, serta pencabutan hak dipilih dalam jabatan publik selama 4 tahun setelah menjalani pidana pokok.'],
    ],
  },
  {
    category: 'pidana-umum',
    caseNumber: '796/Pid.B/2022/PN.Jkt.Sel',
    title: 'Pembunuhan Berencana Brigadir Nofriansyah Yosua Hutabarat',
    summary: 'Pembunuhan di rumah dinas Kadiv Propam Polri, Duren Tiga, beserta upaya merintangi penyidikan.',
    description:
      'Perkara pembunuhan berencana di rumah dinas Kepala Divisi Profesi dan Pengamanan Polri di Duren Tiga, Jakarta Selatan, pada 8 Juli 2022, yang semula dilaporkan sebagai insiden baku tembak.',
    institution: 'Polri / Kejaksaan Agung',
    court: 'Pengadilan Negeri Jakarta Selatan',
    region: 'DKI Jakarta',
    defendants: [
      { name: 'Ferdy Sambo', role: 'Terpidana — mantan Kadiv Propam Polri' },
      { name: 'Putri Candrawathi', role: 'Terpidana' },
      { name: 'Richard Eliezer Pudihang Lumiu', role: 'Terpidana — justice collaborator' },
    ],
    stages: [
      ['PELAPORAN', '2022-07-08', '2022-08-08', 'Laporan awal “baku tembak” dan kejanggalan', 'Peristiwa awalnya disampaikan sebagai baku tembak antarajudan. Keluarga korban menemukan kejanggalan pada luka jenazah dan mendesak autopsi ulang.'],
      ['PENYIDIKAN', '2022-08-09', '2022-09-30', 'Penetapan tersangka dan pengungkapan rekayasa', 'Kapolri mengumumkan penetapan Ferdy Sambo sebagai tersangka setelah Richard Eliezer memberikan keterangan bahwa penembakan dilakukan atas perintah atasannya.'],
      ['PENUNTUTAN', '2022-10-01', '2022-10-12', 'Berkas dinyatakan lengkap (P-21)', 'Kejaksaan Agung menyatakan berkas pembunuhan berencana dan perintangan penyidikan lengkap untuk disidangkan.'],
      ['PERSIDANGAN', '2022-10-17', '2023-02-12', 'Persidangan di PN Jakarta Selatan', 'Jaksa membuktikan dakwaan Pasal 340 KUHP tentang pembunuhan berencana, didukung rekaman CCTV yang sempat diupayakan untuk dihilangkan.'],
      ['PUTUSAN', '2023-02-13', null, 'Vonis hingga kasasi Mahkamah Agung', 'PN Jakarta Selatan menjatuhkan pidana mati kepada Ferdy Sambo. Pada tingkat kasasi, Mahkamah Agung mengubahnya menjadi penjara seumur hidup, sedangkan pidana Putri Candrawathi dikurangi menjadi 10 tahun penjara.'],
    ],
  },
  {
    category: 'korupsi',
    caseNumber: '82/Pid.Sus-TPK/2024/PN.Jkt.Pus',
    title: 'Korupsi Tata Niaga Komoditas Timah di Wilayah IUP PT Timah Tbk',
    summary: 'Kerja sama pengolahan timah 2015–2022 dengan kerugian negara yang dihitung sekitar Rp300 triliun.',
    description:
      'Perkara dugaan korupsi tata niaga komoditas timah di wilayah izin usaha pertambangan PT Timah Tbk, Bangka Belitung, periode 2015–2022. Penghitungan kerugian negara mencakup kerugian keuangan dan kerusakan lingkungan.',
    institution: 'Kejaksaan Agung',
    court: 'Pengadilan Tipikor Jakarta Pusat',
    region: 'Bangka Belitung',
    defendants: [
      { name: 'Harvey Moeis', role: 'Terpidana — perpanjangan tangan PT Refined Bangka Tin' },
      { name: 'Helena Lim', role: 'Terpidana — pemilik PT Quantum Skyline Exchange' },
    ],
    stages: [
      ['PELAPORAN', '2023-11-15', '2023-12-20', 'Penyelidikan awal Kejaksaan Agung', 'Kejaksaan Agung mulai menyelidiki kerja sama sewa peralatan peleburan antara PT Timah Tbk dan sejumlah smelter swasta.'],
      ['PENYIDIKAN', '2023-12-21', '2024-07-15', 'Penetapan tersangka dan penyitaan aset', 'Penyidik Jampidsus menetapkan belasan tersangka, termasuk Harvey Moeis dan Helena Lim, serta menyita rekening, kendaraan mewah, dan aset lain.'],
      ['PENUNTUTAN', '2024-07-16', '2024-08-10', 'Pelimpahan berkas dan dakwaan', 'Berkas dilimpahkan ke Pengadilan Tipikor Jakarta Pusat dengan dakwaan korupsi dan tindak pidana pencucian uang.'],
      ['PERSIDANGAN', '2024-08-14', '2024-12-22', 'Persidangan dan pembuktian', 'Ahli memaparkan penghitungan kerugian negara, termasuk kerusakan lingkungan akibat penambangan tanpa reklamasi. Jaksa mendakwa adanya aliran dana berkedok CSR.'],
      ['PUTUSAN', '2024-12-23', null, 'Vonis tingkat pertama dan banding', 'Pengadilan Tipikor Jakarta Pusat memvonis Harvey Moeis 6 tahun 6 bulan penjara. Pada tingkat banding, Pengadilan Tinggi DKI Jakarta memperberat hukumannya menjadi 20 tahun penjara.'],
    ],
  },
  {
    category: 'lingkungan',
    caseNumber: '454/Pid.B/2024/PN.Bdg',
    title: 'Pemalsuan Dokumen Klaim Tanah Dago Elos, Bandung',
    summary: 'Penggunaan dokumen eigendom verponding palsu untuk mengklaim permukiman warga Dago Elos.',
    description:
      'Perkara pidana pemalsuan dokumen yang dipakai untuk mengklaim kepemilikan lahan permukiman Dago Elos, Bandung, dan mengancam ratusan kepala keluarga dengan pengosongan.',
    institution: 'Polda Jawa Barat',
    court: 'Pengadilan Negeri Bandung',
    region: 'Jawa Barat',
    defendants: [
      { name: 'Heri Hermawan Muller', role: 'Terpidana' },
      { name: 'Dodi Rustandi Muller', role: 'Terpidana' },
    ],
    stages: [
      ['PELAPORAN', '2023-08-15', '2023-11-20', 'Laporan warga ke Polda Jawa Barat', 'Warga Dago Elos melaporkan dugaan pemalsuan asal-usul tanah setelah menerima perintah pengosongan permukiman.'],
      ['PENYIDIKAN', '2023-11-21', '2024-04-10', 'Penetapan tersangka', 'Penyidik menetapkan dua bersaudara Muller sebagai tersangka setelah uji laboratorium forensik meragukan keaslian dokumen.'],
      ['PENUNTUTAN', '2024-04-11', '2024-05-15', 'Pelimpahan ke Kejaksaan', 'Kejaksaan menerima pelimpahan tersangka dan barang bukti untuk persidangan.'],
      ['PERSIDANGAN', '2024-05-16', '2024-10-13', 'Pembuktian di PN Bandung', 'Persidangan dikawal warga. Ahli menyatakan dokumen yang diajukan tidak tercatat dalam arsip pertanahan.'],
      ['PUTUSAN', '2024-10-14', null, 'Vonis 3 tahun 6 bulan penjara', 'Majelis hakim PN Bandung menyatakan kedua terdakwa bersalah menggunakan akta palsu dan menjatuhkan pidana 3 tahun 6 bulan penjara.'],
    ],
  },
  {
    category: 'perdata',
    caseNumber: '374/Pdt.G/LH/2019/PN.Jkt.Pus',
    title: 'Gugatan Warga Negara atas Polusi Udara Jakarta',
    summary: 'Citizen lawsuit 32 warga yang menuntut pemerintah memenuhi hak atas udara bersih.',
    description:
      'Gugatan warga negara (citizen lawsuit) yang diajukan 32 warga terhadap Presiden, sejumlah menteri, serta Gubernur DKI Jakarta, Banten, dan Jawa Barat atas kelalaian memenuhi hak atas udara bersih.',
    institution: 'Koalisi Ibukota',
    court: 'Pengadilan Negeri Jakarta Pusat',
    region: 'DKI Jakarta',
    defendants: [
      { name: 'Presiden RI dan para menteri terkait', role: 'Tergugat' },
      { name: 'Gubernur DKI Jakarta', role: 'Tergugat' },
      { name: 'Gubernur Banten dan Gubernur Jawa Barat', role: 'Turut tergugat' },
    ],
    stages: [
      ['PELAPORAN', '2019-07-04', '2019-08-30', 'Pendaftaran gugatan', 'Koalisi warga mendaftarkan gugatan karena kualitas udara Jakarta dinilai membahayakan kesehatan.'],
      ['PERSIDANGAN', '2019-09-01', '2021-09-15', 'Persidangan dan pembuktian', 'Sidang berulang kali tertunda selama pandemi. Penggugat mengajukan data PM2.5 yang melampaui baku mutu.'],
      ['PUTUSAN', '2021-09-16', null, 'Gugatan dikabulkan sebagian', 'PN Jakarta Pusat menyatakan para tergugat lalai dan menghukum mereka memperbaiki kebijakan pengendalian kualitas udara. Putusan ini kemudian dikuatkan di tingkat banding dan kasasi.'],
    ],
  },
];

async function ensureCategories() {
  for (const c of CATEGORIES) {
    await prisma.category.upsert({ where: { slug: c.slug }, create: c, update: {} });
  }
}

async function ensureAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  const existing = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } });
  if (existing) return existing;
  if (!email || !password) {
    console.warn('Belum ada SUPER_ADMIN. Set SEED_ADMIN_EMAIL dan SEED_ADMIN_PASSWORD lalu jalankan seed lagi.');
    return null;
  }
  if (password.length < 12) throw new Error('SEED_ADMIN_PASSWORD minimal 12 karakter.');
  const admin = await prisma.user.upsert({
    where: { email },
    create: { email, name: process.env.SEED_ADMIN_NAME || 'Redaksi', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash(password, 12) },
    update: { role: 'SUPER_ADMIN' },
  });
  console.log(`SUPER_ADMIN siap: ${email}`);
  return admin;
}

async function seedDemo(admin) {
  if ((await prisma.case.count()) > 0) {
    console.log('Tabel kasus sudah berisi data, demo dilewati.');
    return;
  }
  if (!admin) throw new Error('SEED_DEMO butuh SUPER_ADMIN (set SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD).');
  const cats = Object.fromEntries((await prisma.category.findMany()).map((c) => [c.slug, c.id]));

  for (const demo of DEMO_CASES) {
    const last = demo.stages[demo.stages.length - 1];
    await prisma.$transaction(async (tx) => {
      const lastActivity = d(last[1]);
      const c = await tx.case.create({
        data: {
          slug: slugify(demo.title),
          caseNumber: demo.caseNumber,
          title: demo.title,
          summary: demo.summary,
          description: demo.description,
          categoryId: cats[demo.category],
          currentStatus: last[0],
          institution: demo.institution,
          court: demo.court,
          region: demo.region,
          filedAt: d(demo.stages[0][1]),
          lastActivityAt: lastActivity,
          createdAt: d(demo.stages[0][1]),
          defendants: { create: demo.defendants },
        },
      });
      for (const [i, [stageType, start, end, title, content]] of demo.stages.entries()) {
        const isLast = i === demo.stages.length - 1;
        const stage = await tx.caseStage.create({
          data: {
            caseId: c.id,
            stageType,
            status: isLast ? 'AKTIF' : 'SELESAI',
            title,
            startedAt: d(start),
            endedAt: end ? d(end) : null,
            createdById: admin.id,
          },
        });
        await tx.article.create({
          data: { title, content, stageId: stage.id, authorId: admin.id, publishedAt: d(start) },
        });
        await tx.caseRevision.create({
          data: {
            caseId: c.id,
            userId: admin.id,
            action: i === 0 ? 'CASE_CREATED' : 'STATUS_CHANGED',
            summary: i === 0 ? `Kasus mulai dipantau pada tahap ${title}` : `Memasuki tahap: ${title}`,
            createdAt: d(start),
          },
        });
      }
    });
    console.log(`Demo: ${demo.title}`);
  }
}

async function main() {
  await ensureCategories();
  const admin = await ensureAdmin();
  if (process.env.SEED_DEMO === 'true') await seedDemo(admin);
  console.log('Seed selesai.');
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
