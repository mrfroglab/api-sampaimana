/**
 * OpenAPI 3.1 description of the API. Kept by hand next to the routes so it
 * stays readable; every route in src/modules is listed here.
 */
const statuses = ['PELAPORAN', 'PENYIDIKAN', 'PENUNTUTAN', 'PERSIDANGAN', 'PUTUSAN'];

const json = (schema, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } },
});
const envelope = (data) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data },
});
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const body = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const pathParam = (name, description) => ({ name, in: 'path', required: true, schema: { type: 'string' }, description });
const query = (name, schema, description) => ({ name, in: 'query', schema, description });
const pageParams = [query('page', { type: 'integer', minimum: 1 }), query('limit', { type: 'integer', minimum: 1, maximum: 50 })];
const secured = [{ bearerAuth: [] }];

const op = (tag, summary, extra = {}) => ({
  tags: [tag],
  summary,
  responses: { 200: json(envelope({})), ...(extra.responses || {}) },
  ...extra,
});

module.exports = {
  openapi: '3.1.0',
  info: {
    title: 'Sampai Mana API',
    version: '2.0.0',
    description:
      'API publik dan redaksi untuk Sampai Mana, pelacak perkembangan kasus hukum di Indonesia.\n\n' +
      'Endpoint publik (kasus, statistik, ekspor data terbuka) tidak memerlukan autentikasi. ' +
      'Token akses berumur pendek dikirim lewat header `Authorization: Bearer`. Refresh token disimpan ' +
      'di cookie httpOnly `sm_rt` dan dirotasi setiap dipakai.\n\n' +
      'Data terbuka dilisensikan CC BY 4.0: cantumkan Sampai Mana sebagai sumber.',
  },
  servers: [{ url: '/', description: 'Server ini' }],
  tags: [
    { name: 'Publik', description: 'Data kasus yang bisa diakses siapa saja' },
    { name: 'Data terbuka', description: 'Ekspor untuk peneliti dan jurnalis' },
    { name: 'Autentikasi' },
    { name: 'Akun', description: 'Ikuti kasus, notifikasi, kontribusi' },
    { name: 'Redaksi', description: 'Butuh peran SUPER_ADMIN, EDITOR (tulis) atau VIEWER (baca)' },
  ],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      CaseStatus: { type: 'string', enum: statuses },
      Category: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' }, color: { type: 'string' }, caseCount: { type: 'integer' } },
      },
      Source: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          publisher: { type: 'string' },
          type: { type: 'string', enum: ['OFFICIAL', 'COURT', 'MEDIA', 'OTHER'] },
          isVerified: { type: 'boolean' },
          publishedAt: { type: 'string', format: 'date-time' },
        },
      },
      Stage: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          stageType: ref('CaseStatus'),
          status: { type: 'string', enum: ['PENDING', 'AKTIF', 'SELESAI'] },
          title: { type: 'string' },
          summary: { type: 'string' },
          startedAt: { type: 'string', format: 'date-time' },
          endedAt: { type: 'string', format: 'date-time' },
          dueAt: { type: 'string', format: 'date-time' },
          sources: { type: 'array', items: ref('Source') },
        },
      },
      CaseSummary: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          slug: { type: 'string' },
          caseNumber: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          currentStatus: ref('CaseStatus'),
          institution: { type: 'string' },
          lastActivityAt: { type: 'string', format: 'date-time' },
          category: ref('Category'),
          activeStage: ref('Stage'),
          followerCount: { type: 'integer' },
        },
      },
      CaseListItem: {
        allOf: [
          ref('CaseSummary'),
          {
            type: 'object',
            properties: {
              court: { type: ['string', 'null'] },
              region: { type: ['string', 'null'] },
              defendants: {
                type: 'array',
                items: { type: 'object', properties: { name: { type: 'string' }, slug: { type: 'string' }, role: { type: 'string' } } },
              },
              sourceCount: { type: 'integer' },
              stageCount: { type: 'integer' },
            },
          },
        ],
      },
      SippParsed: {
        type: 'object',
        description: 'Hasil pembacaan halaman SIPP. Semua field bisa null/kosong bila tidak ditemukan.',
        properties: {
          caseNumber: { type: ['string', 'null'] },
          court: { type: ['string', 'null'], example: 'PN Jakarta Pusat' },
          classification: { type: ['string', 'null'] },
          registeredAt: { type: ['string', 'null'], format: 'date' },
          statusText: { type: ['string', 'null'], example: 'Persidangan' },
          parties: { type: 'array', items: { type: 'object', properties: { role: { type: 'string', example: 'Terdakwa' }, name: { type: 'string' } } } },
          schedule: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date: { type: 'string', format: 'date' },
                time: { type: ['string', 'null'], example: '09:30' },
                agenda: { type: ['string', 'null'] },
                room: { type: ['string', 'null'] },
              },
            },
          },
          verdictDate: { type: ['string', 'null'], format: 'date' },
          verdictSummary: { type: ['string', 'null'] },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      SippProposal: {
        type: 'object',
        properties: {
          stageType: ref('CaseStatus'),
          status: { type: 'string', enum: ['PENDING', 'AKTIF', 'SELESAI'] },
          title: { type: 'string' },
          summary: { type: 'string' },
          startedAt: { type: 'string', format: 'date-time' },
          dueAt: { type: ['string', 'null'], format: 'date-time' },
          key: { type: 'string', description: 'Hash stabil (tipe + hari mulai + hari tenggat) untuk memilih usulan.' },
        },
      },
      AttentionItem: {
        type: 'object',
        properties: {
          case: {
            type: 'object',
            properties: { id: { type: 'string' }, slug: { type: 'string' }, title: { type: 'string' }, caseNumber: { type: 'string' }, currentStatus: ref('CaseStatus') },
          },
          stage: {
            type: ['object', 'null'],
            properties: { id: { type: 'string' }, stageType: ref('CaseStatus'), startedAt: { type: 'string', format: 'date-time' }, dueAt: { type: ['string', 'null'], format: 'date-time' } },
          },
          days: { type: 'integer', description: 'overdue: hari terlambat; dueSoon: hari tersisa; stale: hari sejak aktivitas terakhir.' },
        },
      },
      TrendGroup: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          slug: { type: 'string' },
          label: { type: 'string' },
          cases: { type: 'integer' },
          decided: { type: 'integer' },
          ongoing: { type: 'integer' },
          medianDaysToDecision: { type: ['number', 'null'] },
          avgDaysToDecision: { type: ['number', 'null'] },
          medianDaysPerStage: { type: 'object', additionalProperties: { type: ['number', 'null'] }, description: 'Kunci: PELAPORAN … PUTUSAN.' },
          longestOpenDays: { type: ['integer', 'null'] },
        },
      },
      Revision: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { type: 'string' },
          summary: { type: 'string' },
          reason: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  paths: {
    '/api/health': { get: op('Publik', 'Cek kesehatan API dan database') },
    '/api/categories': { get: op('Publik', 'Daftar kategori beserta jumlah kasus') },
    '/api/stats': { get: op('Publik', 'Statistik publik: status, kategori, durasi tahapan, pembaruan terbaru') },
    '/api/stats/trends': {
      get: op('Publik', 'Tren dan durasi per lembaga/pengadilan/wilayah/kategori (cache 5 menit)', {
        parameters: [query('groupBy', { type: 'string', enum: ['institution', 'court', 'region', 'category'], default: 'institution' })],
        description:
          'Hari menuju putusan = tahapan pertama (atau filedAt) → tahapan PUTUSAN pertama. Durasi per tahapan = startedAt → endedAt (atau awal tahapan berikutnya). Diurutkan menurut median hari menuju putusan (terbesar dulu, null terakhir); hanya kelompok yang tidak kosong.',
        responses: { 200: json(envelope({ type: 'object', properties: { groupBy: { type: 'string' }, groups: { type: 'array', items: ref('TrendGroup') } } })) },
      }),
    },
    '/api/people/{slug}': {
      get: op('Publik', 'Halaman pihak: semua kasus aktif yang memuat pihak bernama sama', {
        parameters: [pathParam('slug', 'slug dari nama pihak, mis. budi-santoso')],
        responses: {
          200: json(envelope({ type: 'object', properties: { name: { type: 'string' }, slug: { type: 'string' }, roles: { type: 'array', items: { type: 'string' } }, cases: { type: 'array', items: ref('CaseListItem') } } })),
          404: json({ type: 'object' }, 'Tidak ada kasus aktif untuk slug ini'),
        },
      }),
    },
    '/api/institutions': {
      get: op('Publik', 'Daftar lembaga (Case.institution) beserta jumlah kasus aktif', {
        responses: { 200: json(envelope({ type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, slug: { type: 'string' }, cases: { type: 'integer' } } } })) },
      }),
    },
    '/api/institutions/{slug}': {
      get: op('Publik', 'Halaman lembaga: statistik dan kasus aktif', {
        parameters: [pathParam('slug')],
        responses: {
          200: json(
            envelope({
              type: 'object',
              properties: {
                name: { type: 'string' },
                slug: { type: 'string' },
                stats: { type: 'object', properties: { cases: { type: 'integer' }, decided: { type: 'integer' }, ongoing: { type: 'integer' }, medianDaysToDecision: { type: ['number', 'null'] } } },
                cases: { type: 'array', items: ref('CaseListItem') },
              },
            }),
          ),
          404: json({ type: 'object' }, 'Lembaga tidak ditemukan'),
        },
      }),
    },
    '/api/sitemap-data': {
      get: op('Publik', 'Slug untuk sitemap situs web', {
        responses: {
          200: json(
            envelope({
              type: 'object',
              properties: {
                cases: { type: 'array', items: { type: 'object', properties: { slug: { type: 'string' }, updatedAt: { type: 'string', format: 'date-time' } } } },
                people: { type: 'array', items: { type: 'object', properties: { slug: { type: 'string' } } } },
                institutions: { type: 'array', items: { type: 'object', properties: { slug: { type: 'string' } } } },
              },
            }),
          ),
        },
      }),
    },
    '/api/cases': {
      get: op('Publik', 'Cari dan saring kasus', {
        parameters: [
          query('q', { type: 'string' }, 'Cari judul, nomor perkara, lembaga, nama pihak'),
          query('status', { type: 'string' }, 'Satu atau beberapa status, dipisah koma'),
          query('category', { type: 'string' }, 'Slug kategori'),
          query('sort', { type: 'string', enum: ['updated', 'newest', 'oldest', 'title'] }),
          ...pageParams,
        ],
        responses: { 200: json(envelope({ type: 'array', items: ref('CaseListItem') })) },
      }),
    },
    '/api/cases/export.csv': { get: op('Data terbuka', 'Unduh seluruh kasus aktif sebagai CSV') },
    '/api/cases/export.json': { get: op('Data terbuka', 'Unduh seluruh kasus aktif, tahapan, dan sumber sebagai JSON') },
    '/api/cases/{key}': {
      get: op('Publik', 'Detail kasus (key = slug atau id); memuat `sippUrl` dan `defendants[].slug`', { parameters: [pathParam('key', 'Slug atau UUID kasus')] }),
    },
    '/api/cases/{key}/revisions': {
      get: op('Publik', 'Riwayat perubahan publik', { parameters: [pathParam('key'), ...pageParams] }),
    },
    '/api/cases/{key}/stages/{stageId}': {
      get: op('Publik', 'Tahapan beserta artikel penjelasan dan sumber', { parameters: [pathParam('key'), pathParam('stageId')] }),
    },
    '/api/cases/{key}/follow': {
      post: op('Akun', 'Ikuti kasus', { security: secured, parameters: [pathParam('key')] }),
      delete: op('Akun', 'Berhenti mengikuti', { security: secured, parameters: [pathParam('key')] }),
    },
    '/api/cases/{key}/corrections': {
      post: op('Publik', 'Ajukan koreksi atau hak jawab (tanpa login, dibatasi 10/jam)', {
        parameters: [pathParam('key')],
        requestBody: body({
          type: 'object',
          required: ['name', 'email', 'relation', 'message'],
          properties: {
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            relation: { type: 'string', enum: ['PIHAK_TERKAIT', 'KUASA_HUKUM', 'JURNALIS', 'PUBLIK'] },
            message: { type: 'string', minLength: 20 },
          },
        }),
      }),
    },
    '/api/auth/register': {
      post: op('Autentikasi', 'Daftar sebagai kontributor', {
        requestBody: body({ type: 'object', required: ['name', 'email', 'password'], properties: { name: { type: 'string' }, email: { type: 'string' }, password: { type: 'string', minLength: 8 } } }),
      }),
    },
    '/api/auth/login': {
      post: op('Autentikasi', 'Masuk; mengembalikan accessToken dan memasang cookie refresh', {
        requestBody: body({ type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } }),
      }),
    },
    '/api/auth/refresh': { post: op('Autentikasi', 'Tukar cookie refresh dengan accessToken baru (rotasi)') },
    '/api/auth/logout': { post: op('Autentikasi', 'Cabut refresh token dan hapus cookie') },
    '/api/auth/me': {
      get: op('Autentikasi', 'Profil pengguna saat ini', { security: secured }),
      patch: op('Autentikasi', 'Ubah nama / preferensi notifikasi email', { security: secured }),
    },
    '/api/auth/password': { post: op('Autentikasi', 'Ganti kata sandi (mengeluarkan perangkat lain)', { security: secured }) },
    '/api/me/follows': { get: op('Akun', 'Kasus yang diikuti', { security: secured }) },
    '/api/me/notifications': { get: op('Akun', 'Notifikasi', { security: secured, parameters: pageParams }) },
    '/api/me/notifications/read': { post: op('Akun', 'Tandai notifikasi dibaca (semua bila ids kosong)', { security: secured }) },
    '/api/me/contributions': {
      get: op('Akun', 'Riwayat kontribusi dan statistik penerimaan', { security: secured }),
      post: op('Akun', 'Kirim kontribusi perkembangan kasus (multipart, maks 5 file × 10 MB)', {
        security: secured,
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['caseId', 'description'],
                properties: {
                  caseId: { type: 'string', description: 'Slug atau UUID kasus' },
                  description: { type: 'string', minLength: 30 },
                  proposedStage: ref('CaseStatus'),
                  proofLinks: { type: 'string', description: 'Array JSON berisi URL' },
                  proofFiles: { type: 'array', items: { type: 'string', format: 'binary' } },
                },
              },
            },
          },
        },
      }),
    },
    '/api/admin/overview': { get: op('Redaksi', 'Ringkasan antrean moderasi, koreksi, dan tenggat terlewat', { security: secured }) },
    '/api/admin/attention': {
      get: op('Redaksi', 'Yang perlu perhatian redaksi: tahapan lewat tenggat, jatuh tempo ≤ 7 hari, dan kasus menggantung (STALE_DAYS)', {
        security: secured,
        responses: {
          200: json(
            envelope({
              type: 'object',
              properties: { overdue: { type: 'array', items: ref('AttentionItem') }, dueSoon: { type: 'array', items: ref('AttentionItem') }, stale: { type: 'array', items: ref('AttentionItem') } },
            }),
          ),
        },
      }),
    },
    '/api/admin/cases/{id}/sipp/preview': {
      post: op('Redaksi', 'Impor SIPP: baca teks/HTML halaman "Detil Perkara" yang ditempel dan usulkan tahapan (tanpa menulis data)', {
        security: secured,
        parameters: [pathParam('id')],
        description:
          'Hanya EDITOR/SUPER_ADMIN, dibatasi rate limit tulis. SIPP dilindungi reCAPTCHA sehingga server tidak mengambil halaman: redaksi menempelkan HTML (simpan halaman / view-source) atau teks hasil salin.',
        requestBody: body({ type: 'object', required: ['input'], properties: { input: { type: 'string', maxLength: 2097152, description: 'HTML atau teks halaman SIPP (maks 2 MB).' } } }),
        responses: {
          200: json(envelope({ type: 'object', properties: { parsed: ref('SippParsed'), proposals: { type: 'array', items: ref('SippProposal') }, warnings: { type: 'array', items: { type: 'string' } } } })),
        },
      }),
    },
    '/api/admin/cases/{id}/sipp/apply': {
      post: op('Redaksi', 'Impor SIPP: buat tahapan terpilih (lewat jalur "tambah tahapan" yang sama) dan simpan tautan SIPP', {
        security: secured,
        parameters: [pathParam('id')],
        description:
          'Server membaca ulang `input` dan hanya membuat usulan yang `key`-nya ada di `keys`. Sinkronisasi tahapan aktif/status, revisi (`STAGE_ADDED`, `STATUS_CHANGED`, dan `SIPP_IMPORT`) serta notifikasi pengikut berjalan seperti biasa. Key yang tidak lagi berlaku (mis. sudah diimpor) → 400.',
        requestBody: body({
          type: 'object',
          required: ['input', 'keys'],
          properties: { input: { type: 'string', maxLength: 2097152 }, keys: { type: 'array', items: { type: 'string' } }, sippUrl: { type: 'string', format: 'uri' } },
        }),
        responses: {
          200: json(
            envelope({
              type: 'object',
              properties: {
                created: { type: 'array', items: ref('Stage') },
                case: { type: 'object', properties: { id: { type: 'string' }, slug: { type: 'string' }, currentStatus: ref('CaseStatus') } },
              },
            }),
          ),
          400: json({ type: 'object' }, 'Input/keys/sippUrl tidak valid'),
        },
      }),
    },
    '/api/admin/cases': {
      get: op('Redaksi', 'Daftar kasus (termasuk arsip)', { security: secured }),
      post: op('Redaksi', 'Buat kasus (opsional `sippUrl`, http/https)', { security: secured }),
    },
    '/api/admin/cases/{id}': {
      get: op('Redaksi', 'Detail kasus untuk penyuntingan', { security: secured, parameters: [pathParam('id')] }),
      put: op('Redaksi', 'Perbarui kasus (perubahan status wajib disertai alasan; `sippUrl` dikosongkan dengan "" atau null, dipertahankan bila tidak dikirim)', { security: secured, parameters: [pathParam('id')] }),
      delete: op('Redaksi', 'Arsipkan kasus', { security: secured, parameters: [pathParam('id')] }),
    },
    '/api/admin/cases/{id}/restore': { post: op('Redaksi', 'Pulihkan kasus dari arsip', { security: secured, parameters: [pathParam('id')] }) },
    '/api/admin/cases/{id}/stages': { post: op('Redaksi', 'Tambah tahapan; tahapan AKTIF menggeser status kasus', { security: secured, parameters: [pathParam('id')] }) },
    '/api/admin/cases/{id}/sources': { post: op('Redaksi', 'Tambah sumber', { security: secured, parameters: [pathParam('id')] }) },
    '/api/admin/stages/{id}': {
      put: op('Redaksi', 'Perbarui tahapan', { security: secured, parameters: [pathParam('id')] }),
      delete: op('Redaksi', 'Hapus tahapan', { security: secured, parameters: [pathParam('id')] }),
    },
    '/api/admin/stages/{id}/article': {
      put: op('Redaksi', 'Terbitkan / perbarui artikel penjelasan tahapan', { security: secured, parameters: [pathParam('id')] }),
      delete: op('Redaksi', 'Tarik artikel penjelasan', { security: secured, parameters: [pathParam('id')] }),
    },
    '/api/admin/sources/{id}': {
      patch: op('Redaksi', 'Ubah / verifikasi sumber', { security: secured, parameters: [pathParam('id')] }),
      delete: op('Redaksi', 'Hapus sumber', { security: secured, parameters: [pathParam('id')] }),
    },
    '/api/admin/contributions': { get: op('Redaksi', 'Antrean moderasi beserta reputasi kontributor', { security: secured }) },
    '/api/admin/contributions/{id}/files/{index}': { get: op('Redaksi', 'Unduh file bukti (privat)', { security: secured, parameters: [pathParam('id'), pathParam('index')] }) },
    '/api/admin/contributions/{id}/review': { post: op('Redaksi', 'Terima/tolak; opsional jadikan tahapan dan impor tautan sebagai sumber', { security: secured, parameters: [pathParam('id')] }) },
    '/api/admin/corrections': { get: op('Redaksi', 'Daftar permintaan koreksi / hak jawab', { security: secured }) },
    '/api/admin/corrections/{id}/resolve': { post: op('Redaksi', 'Tangani permintaan koreksi; catatan publik masuk riwayat kasus', { security: secured, parameters: [pathParam('id')] }) },
    '/api/admin/categories': { post: op('Redaksi', 'Buat kategori', { security: secured }) },
    '/api/admin/categories/{id}': {
      patch: op('Redaksi', 'Ubah kategori', { security: secured, parameters: [pathParam('id')] }),
      delete: op('Redaksi', 'Hapus kategori yang tidak dipakai', { security: secured, parameters: [pathParam('id')] }),
    },
    '/api/admin/users': { get: op('Redaksi', 'Daftar pengguna (SUPER_ADMIN)', { security: secured }) },
    '/api/admin/users/{id}': { patch: op('Redaksi', 'Ubah peran atau blokir pengguna (SUPER_ADMIN)', { security: secured, parameters: [pathParam('id')] }) },
    '/api/admin/activity-logs': { get: op('Redaksi', 'Log audit internal', { security: secured, parameters: pageParams }) },
  },
};
