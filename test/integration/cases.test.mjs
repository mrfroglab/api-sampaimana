import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import helpers from './helpers.js';

const { api, prisma, resetDb, makeUser, makeCase, flush } = helpers;

describe('cases & timeline', () => {
  let editor;
  beforeEach(async () => {
    await resetDb();
    editor = await makeUser('EDITOR');
  });
  afterAll(() => prisma.$disconnect());

  it('creates a case with a slug, a first active stage and a public revision', async () => {
    const c = await makeCase(editor.token);
    expect(c.slug).toBe('kasus-uji-coba-pengadaan-barang');
    const res = await api().get(`/api/cases/${c.slug}`).expect(200);
    expect(res.body.data.stages).toHaveLength(1);
    expect(res.body.data.stages[0]).toMatchObject({ stageType: 'PENYIDIKAN', status: 'AKTIF' });
    expect(res.body.data.revisions[0].action).toBe('CASE_CREATED');
    expect(res.body.data.isActive).toBeUndefined();
  });

  it('caps page size and rejects unknown sort fields instead of passing them to the ORM', async () => {
    await makeCase(editor.token);
    const big = await api().get('/api/cases?limit=100000');
    expect(big.status).toBe(400);
    const sort = await api().get('/api/cases?sort=passwordHash');
    expect(sort.status).toBe(400);
    const okRes = await api().get('/api/cases?limit=50&sort=title').expect(200);
    expect(okRes.body.meta).toMatchObject({ total: 1, limit: 50 });
  });

  it('searches defendants and filters by several statuses', async () => {
    await makeCase(editor.token, { title: 'Kasus Alpha Satu', defendants: [{ name: 'Budi Santoso', role: 'Tersangka' }] });
    await makeCase(editor.token, { title: 'Kasus Beta Dua', currentStatus: 'PUTUSAN' });
    const byName = await api().get('/api/cases?q=santoso').expect(200);
    expect(byName.body.data.map((c) => c.title)).toEqual(['Kasus Alpha Satu']);
    const both = await api().get('/api/cases?status=PENYIDIKAN,PUTUSAN').expect(200);
    expect(both.body.meta.total).toBe(2);
  });

  it('adding an active stage closes the previous one, moves the case status and notifies followers', async () => {
    const c = await makeCase(editor.token);
    const follower = await makeUser();
    await api().post(`/api/cases/${c.slug}/follow`).set('Authorization', `Bearer ${follower.token}`).expect(200);

    await api()
      .post(`/api/admin/cases/${c.id}/stages`)
      .set('Authorization', `Bearer ${editor.token}`)
      .send({ stageType: 'PENUNTUTAN', status: 'AKTIF', title: 'Berkas P-21', dueAt: '2099-02-10' })
      .expect(201);
    await flush();

    const detail = (await api().get(`/api/cases/${c.slug}`)).body.data;
    expect(detail.currentStatus).toBe('PENUNTUTAN');
    expect(detail.stages.map((s) => s.status)).toEqual(['SELESAI', 'AKTIF']);
    expect(detail.stages[0].endedAt).toBeTruthy();
    expect(detail.revisions.map((r) => r.action)).toContain('STATUS_CHANGED');

    const notes = await api().get('/api/me/notifications').set('Authorization', `Bearer ${follower.token}`).expect(200);
    expect(notes.body.meta.unread).toBe(1);
    expect(notes.body.data[0]).toMatchObject({ type: 'STATUS_CHANGE', link: `/kasus/${c.slug}` });
  });

  it('requires a reason when the status is changed directly', async () => {
    const c = await makeCase(editor.token);
    const full = (await api().get(`/api/admin/cases/${c.id}`).set('Authorization', `Bearer ${editor.token}`)).body.data;
    const payload = {
      caseNumber: full.caseNumber,
      title: full.title,
      description: full.description,
      categoryId: full.categoryId,
      currentStatus: 'PUTUSAN',
      defendants: full.defendants.map(({ name, role }) => ({ name, role })),
    };
    const noReason = await api().put(`/api/admin/cases/${c.id}`).set('Authorization', `Bearer ${editor.token}`).send(payload);
    expect(noReason.status).toBe(400);
    await api()
      .put(`/api/admin/cases/${c.id}`)
      .set('Authorization', `Bearer ${editor.token}`)
      .send({ ...payload, reason: 'Putusan dibacakan 1 Mei' })
      .expect(200);
    const revs = (await api().get(`/api/cases/${c.slug}/revisions`)).body.data;
    expect(revs[0]).toMatchObject({ action: 'STATUS_CHANGED', reason: 'Putusan dibacakan 1 Mei' });
  });

  it('archived cases disappear from public endpoints and exports', async () => {
    const c = await makeCase(editor.token);
    await api().delete(`/api/admin/cases/${c.id}`).set('Authorization', `Bearer ${editor.token}`).expect(200);
    await api().get(`/api/cases/${c.slug}`).expect(404);
    const csv = await api().get('/api/cases/export.csv').expect(200);
    expect(csv.text).not.toContain(c.slug);
  });

  it('neutralises spreadsheet formulas in the CSV export', async () => {
    await makeCase(editor.token, { title: '=HYPERLINK("http://evil")' });
    const csv = await api().get('/api/cases/export.csv').expect(200);
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });

  it('accepts public corrections with validation and a honeypot', async () => {
    const c = await makeCase(editor.token);
    const body = { name: 'Kuasa Hukum', email: 'kh@test.local', relation: 'KUASA_HUKUM', message: 'Klien kami belum berstatus terdakwa, mohon dikoreksi.' };
    await api().post(`/api/cases/${c.slug}/corrections`).send({ ...body, website: 'spam' }).expect(400);
    await api().post(`/api/cases/${c.slug}/corrections`).send(body).expect(201);

    const list = await api().get('/api/admin/corrections').set('Authorization', `Bearer ${editor.token}`).expect(200);
    const id = list.body.data[0].id;
    await api()
      .post(`/api/admin/corrections/${id}/resolve`)
      .set('Authorization', `Bearer ${editor.token}`)
      .send({ status: 'RESOLVED', response: 'Status pihak diperbaiki.', publicNote: 'Status pihak diperbarui atas permintaan kuasa hukum.' })
      .expect(200);
    const revs = (await api().get(`/api/cases/${c.slug}/revisions`)).body.data;
    expect(revs[0].action).toBe('CORRECTION');
  });

  it('enforces roles: contributors and viewers cannot write admin data', async () => {
    const contributor = await makeUser();
    const viewer = await makeUser('VIEWER');
    await api().get('/api/admin/overview').set('Authorization', `Bearer ${contributor.token}`).expect(403);
    await api().get('/api/admin/overview').set('Authorization', `Bearer ${viewer.token}`).expect(200);
    await api().post('/api/admin/categories').set('Authorization', `Bearer ${viewer.token}`).send({ name: 'Baru' }).expect(403);
    await api().get('/api/admin/users').set('Authorization', `Bearer ${editor.token}`).expect(403);
  });

  it('public stats aggregate durations', async () => {
    await makeCase(editor.token);
    const res = await api().get('/api/stats').expect(200);
    expect(res.body.data.totals.cases).toBe(1);
    expect(res.body.data.stageDurations).toHaveLength(5);
  });
});
