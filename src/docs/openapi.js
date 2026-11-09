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
    '/api/cases': {
      get: op('Publik', 'Cari dan saring kasus', {
        parameters: [
          query('q', { type: 'string' }, 'Cari judul, nomor perkara, lembaga, nama pihak'),
          query('status', { type: 'string' }, 'Satu atau beberapa status, dipisah koma'),
          query('category', { type: 'string' }, 'Slug kategori'),
          query('sort', { type: 'string', enum: ['updated', 'newest', 'oldest', 'title'] }),
          ...pageParams,
        ],
        responses: { 200: json(envelope({ type: 'array', items: ref('CaseSummary') })) },
      }),
    },
    '/api/cases/export.csv': { get: op('Data terbuka', 'Unduh seluruh kasus aktif sebagai CSV') },
    '/api/cases/export.json': { get: op('Data terbuka', 'Unduh seluruh kasus aktif, tahapan, dan sumber sebagai JSON') },
    '/api/cases/{key}': {
      get: op('Publik', 'Detail kasus (key = slug atau id)', { parameters: [pathParam('key', 'Slug atau UUID kasus')] }),
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
    '/api/admin/cases': {
      get: op('Redaksi', 'Daftar kasus (termasuk arsip)', { security: secured }),
      post: op('Redaksi', 'Buat kasus', { security: secured }),
    },
    '/api/admin/cases/{id}': {
      get: op('Redaksi', 'Detail kasus untuk penyuntingan', { security: secured, parameters: [pathParam('id')] }),
      put: op('Redaksi', 'Perbarui kasus (perubahan status wajib disertai alasan)', { security: secured, parameters: [pathParam('id')] }),
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
