import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import helpers from './helpers.js';
import cacheMod from '../../src/lib/cache.js';

const { api, prisma, resetDb, makeUser, makeCase } = helpers;
const { clearInsightsCache } = cacheMod;

const d = (s) => new Date(`${s}T00:00:00Z`);

describe('trends, people and institutions', () => {
  let editor;
  const auth = () => ({ Authorization: `Bearer ${editor.token}` });

  /** Makes a case and rewrites its timeline: [[stageType, 'YYYY-MM-DD'], ...]. */
  const seed = async (overrides, timeline) => {
    const c = await makeCase(editor.token, overrides);
    if (timeline) {
      await prisma.caseStage.deleteMany({ where: { caseId: c.id } });
      await prisma.caseStage.createMany({
        data: timeline.map(([stageType, start, end], i) => ({
          caseId: c.id,
          stageType,
          status: i === timeline.length - 1 ? 'AKTIF' : 'SELESAI',
          startedAt: d(start),
          endedAt: end ? d(end) : null,
          createdById: editor.user.id,
        })),
      });
      await prisma.case.update({ where: { id: c.id }, data: { currentStatus: timeline.at(-1)[0] } });
    }
    clearInsightsCache();
    return c;
  };

  beforeEach(async () => {
    await resetDb();
    clearInsightsCache();
    editor = await makeUser('EDITOR');
  });
  afterAll(() => prisma.$disconnect());

  describe('GET /api/stats/trends', () => {
    it('groups by institution with durations, sorted by median days to decision', async () => {
      await seed({ title: 'Kasus KPK Satu', institution: 'KPK' }, [['PENYIDIKAN', '2024-01-01'], ['PENUNTUTAN', '2024-02-01'], ['PERSIDANGAN', '2024-03-01'], ['PUTUSAN', '2024-04-10']]);
      await seed({ title: 'Kasus KPK Dua', institution: 'KPK' }, [['PENYIDIKAN', '2024-01-01'], ['PUTUSAN', '2024-03-01']]);
      await seed({ title: 'Kasus Kejagung Satu', institution: 'Kejaksaan Agung' }, [['PENYIDIKAN', '2024-01-01'], ['PUTUSAN', '2024-01-11']]);
      await seed({ title: 'Kasus Polri Berjalan', institution: 'Polri' }, [['PENYIDIKAN', '2024-01-01']]);
      await seed({ title: 'Kasus Tanpa Lembaga', institution: undefined });

      const res = await api().get('/api/stats/trends').expect(200);
      expect(res.body.data.groupBy).toBe('institution');
      const groups = res.body.data.groups;
      expect(groups.map((g) => [g.slug, g.cases, g.decided, g.ongoing, g.medianDaysToDecision])).toEqual([
        ['kpk', 2, 2, 0, 80], // (100 + 60) / 2
        ['kejaksaan-agung', 1, 1, 0, 10],
        ['polri', 1, 0, 1, null],
      ]);
      expect(groups[0]).toMatchObject({ key: 'KPK', label: 'KPK', avgDaysToDecision: 80, longestOpenDays: null });
      expect(groups[0].medianDaysPerStage).toEqual({ PELAPORAN: null, PENYIDIKAN: 45.5, PENUNTUTAN: 29, PERSIDANGAN: 40, PUTUSAN: null });
      expect(groups[2].longestOpenDays).toBeGreaterThan(365);
    });

    it('supports court, region and category and validates groupBy', async () => {
      await seed({ title: 'Kasus Pengadilan A', court: 'PN Jakarta Pusat', region: 'DKI Jakarta' });
      await seed({ title: 'Kasus Pengadilan B', court: 'PN Bandung', region: 'Jawa Barat' });
      for (const [by, n] of [['court', 2], ['region', 2], ['category', 2]]) {
        const res = await api().get(`/api/stats/trends?groupBy=${by}`).expect(200);
        expect(res.body.data.groupBy).toBe(by);
        expect(res.body.data.groups.length).toBe(n);
      }
      await api().get('/api/stats/trends?groupBy=password').expect(400);
    });

    it('caches for five minutes and is busted by admin writes', async () => {
      await seed({ title: 'Kasus Cache Satu', institution: 'KPK' });
      const first = await api().get('/api/stats/trends').expect(200);
      expect(first.body.data.groups[0].cases).toBe(1);
      await prisma.case.updateMany({ data: { isActive: false } });
      const cached = await api().get('/api/stats/trends').expect(200);
      expect(cached.body.data.groups[0].cases).toBe(1); // stale on purpose
      await api().post('/api/admin/categories').set(auth()).send({ name: 'Kategori Baru' }).expect(201);
      const fresh = await api().get('/api/stats/trends').expect(200);
      expect(fresh.body.data.groups).toEqual([]);
    });
  });

  describe('people', () => {
    it('lists a person across cases with the list-item shape, only active cases', async () => {
      const a = await seed({ title: 'Kasus Budi Satu', defendants: [{ name: 'Budi Santoso', role: 'Terdakwa' }, { name: 'Rina', role: 'Saksi' }] });
      await seed({ title: 'Kasus Budi Dua', defendants: [{ name: 'budi  SANTOSO', role: 'Tersangka' }] });
      const hidden = await seed({ title: 'Kasus Budi Arsip', defendants: [{ name: 'Budi Santoso', role: 'Terdakwa' }] });
      await api().delete(`/api/admin/cases/${hidden.id}`).set(auth()).send({}).expect(200);

      const res = await api().get('/api/people/budi-santoso').expect(200);
      expect(res.body.data).toMatchObject({ name: 'Budi Santoso', slug: 'budi-santoso' });
      expect(res.body.data.roles.sort()).toEqual(['Terdakwa', 'Tersangka']);
      expect(res.body.data.cases.map((c) => c.title).sort()).toEqual(['Kasus Budi Dua', 'Kasus Budi Satu']);
      const item = res.body.data.cases.find((c) => c.id === a.id);
      expect(item).toMatchObject({ slug: a.slug, currentStatus: 'PENYIDIKAN', followerCount: 0, sourceCount: 0, stageCount: 1 });
      expect(item.category).toBeTruthy();
      expect(item.activeStage).toMatchObject({ stageType: 'PENYIDIKAN' });
      expect(item.defendants.find((x) => x.name === 'Budi Santoso')).toMatchObject({ slug: 'budi-santoso', role: 'Terdakwa' });
    });

    it('404s for unknown people, archived-only people and odd slugs', async () => {
      await api().get('/api/people/tidak-ada').expect(404);
      await api().get('/api/people/Tidak%20Ada').expect(404);
      const c = await seed({ title: 'Kasus Arsip Saja', defendants: [{ name: 'Orang Arsip', role: 'Terdakwa' }] });
      await api().delete(`/api/admin/cases/${c.id}`).set(auth()).send({}).expect(200);
      await api().get('/api/people/orang-arsip').expect(404);
    });

    it('keeps the defendant slug in sync when names are edited, and shows it in case detail', async () => {
      const c = await seed({ title: 'Kasus Ganti Nama', defendants: [{ name: 'Siti Aminah', role: 'Terdakwa' }] });
      const detail = (await api().get(`/api/cases/${c.slug}`).expect(200)).body.data;
      expect(detail.defendants[0].slug).toBe('siti-aminah');

      const full = (await api().get(`/api/admin/cases/${c.id}`).set(auth())).body.data;
      await api()
        .put(`/api/admin/cases/${c.id}`)
        .set(auth())
        .send({ caseNumber: full.caseNumber, title: full.title, description: full.description, categoryId: full.categoryId, currentStatus: full.currentStatus, defendants: [{ name: 'Siti Aminah Putri', role: 'Terdakwa' }] })
        .expect(200);
      expect((await api().get(`/api/cases/${c.slug}`)).body.data.defendants[0].slug).toBe('siti-aminah-putri');
      await api().get('/api/people/siti-aminah').expect(404);
      await api().get('/api/people/siti-aminah-putri').expect(200);
    });
  });

  describe('institutions', () => {
    it('lists distinct institutions and merges spelling variants that share a slug', async () => {
      await seed({ title: 'Kasus Inst Satu', institution: 'Kejaksaan Agung' });
      await seed({ title: 'Kasus Inst Dua', institution: 'Kejaksaan Agung' });
      await seed({ title: 'Kasus Inst Tiga', institution: 'kejaksaan  agung ' });
      await seed({ title: 'Kasus Inst Empat', institution: 'KPK' });
      await seed({ title: 'Kasus Inst Tanpa', institution: undefined });
      const res = await api().get('/api/institutions').expect(200);
      expect(res.body.data).toEqual([
        { name: 'Kejaksaan Agung', slug: 'kejaksaan-agung', cases: 3 },
        { name: 'KPK', slug: 'kpk', cases: 1 },
      ]);
    });

    it('returns stats and cases for one institution', async () => {
      await seed({ title: 'Kasus KPK Putus', institution: 'KPK' }, [['PENYIDIKAN', '2024-01-01'], ['PUTUSAN', '2024-03-01']]);
      await seed({ title: 'Kasus KPK Jalan', institution: 'KPK' }, [['PENYIDIKAN', '2024-01-01']]);
      await seed({ title: 'Kasus Polri Lain', institution: 'Polri' });
      const res = await api().get('/api/institutions/kpk').expect(200);
      expect(res.body.data).toMatchObject({ name: 'KPK', slug: 'kpk', stats: { cases: 2, decided: 1, ongoing: 1, medianDaysToDecision: 60 } });
      expect(res.body.data.cases.map((c) => c.title).sort()).toEqual(['Kasus KPK Jalan', 'Kasus KPK Putus']);
      expect(res.body.data.cases[0]).toHaveProperty('activeStage');
      await api().get('/api/institutions/tidak-ada').expect(404);
    });
  });

  describe('sitemap data', () => {
    it('returns slugs for active cases, people and institutions', async () => {
      const a = await seed({ title: 'Kasus Peta Situs', institution: 'KPK', defendants: [{ name: 'Budi Santoso', role: 'Terdakwa' }, { name: 'Rina Wati', role: 'Terdakwa' }] });
      const b = await seed({ title: 'Kasus Peta Kedua', institution: 'KPK', defendants: [{ name: 'Budi Santoso', role: 'Terdakwa' }] });
      const gone = await seed({ title: 'Kasus Peta Arsip', institution: 'Polri', defendants: [{ name: 'Orang Hilang', role: 'Terdakwa' }] });
      await api().delete(`/api/admin/cases/${gone.id}`).set(auth()).send({}).expect(200);

      const res = await api().get('/api/sitemap-data').expect(200);
      const { cases, people, institutions } = res.body.data;
      expect(cases.map((c) => c.slug).sort()).toEqual([a.slug, b.slug].sort());
      expect(cases[0]).toHaveProperty('updatedAt');
      expect(people).toEqual([{ slug: 'budi-santoso' }, { slug: 'rina-wati' }]);
      expect(institutions).toEqual([{ slug: 'kpk' }]);
    });
  });
});
