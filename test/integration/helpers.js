const bcrypt = require('bcryptjs');
const request = require('supertest');
const app = require('../../src/app');
const prisma = require('../../src/lib/prisma');

const api = () => request(app);

const TABLES = [
  'notifications', 'follows', 'correction_requests', 'case_revisions', 'sources', 'articles',
  'case_contributions', 'case_stages', 'defendants', 'cases', 'categories', 'refresh_tokens',
  'activity_logs', 'job_runs', 'users',
];

const resetDb = () => prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);

let counter = 0;
const makeUser = async (role = 'CONTRIBUTOR', extra = {}) => {
  counter += 1;
  const password = 'password-123';
  const user = await prisma.user.create({
    data: {
      email: `user${counter}-${Date.now()}@test.local`,
      name: `User ${counter}`,
      role,
      passwordHash: await bcrypt.hash(password, 4),
      createdAt: new Date(Date.now() - 7 * 24 * 3600 * 1000),
      ...extra,
    },
  });
  const res = await api().post('/api/auth/login').send({ email: user.email, password });
  return { user, token: res.body.data.accessToken, cookie: res.headers['set-cookie'], password };
};

const makeCategory = () =>
  prisma.category.create({ data: { name: 'Korupsi', slug: `korupsi-${Date.now()}-${counter++}` } });

const makeCase = async (editorToken, overrides = {}) => {
  const category = await makeCategory();
  const res = await api()
    .post('/api/admin/cases')
    .set('Authorization', `Bearer ${editorToken}`)
    .send({
      caseNumber: `NO/${Date.now()}/${counter++}`,
      title: 'Kasus Uji Coba Pengadaan Barang',
      description: 'Deskripsi kasus uji coba yang cukup panjang untuk validasi.',
      categoryId: category.id,
      currentStatus: 'PENYIDIKAN',
      defendants: [{ name: 'Tersangka A', role: 'Tersangka' }],
      ...overrides,
    });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.data;
};

/** Waits for setImmediate-based notifications to flush. */
const flush = () => new Promise((r) => setTimeout(r, 150));

module.exports = { api, prisma, resetDb, makeUser, makeCategory, makeCase, flush };
