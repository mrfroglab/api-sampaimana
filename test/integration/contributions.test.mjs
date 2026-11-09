import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import helpers from './helpers.js';

const { api, prisma, resetDb, makeUser, makeCase, flush } = helpers;

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PDF = Buffer.from('%PDF-1.7\n%test\n');

describe('contributions', () => {
  let editor;
  let contributor;
  let theCase;

  beforeEach(async () => {
    await resetDb();
    editor = await makeUser('EDITOR');
    contributor = await makeUser();
    theCase = await makeCase(editor.token);
  });
  afterAll(() => prisma.$disconnect());

  const submit = (token, fields = {}, files = []) => {
    let req = api().post('/api/me/contributions').set('Authorization', `Bearer ${token}`);
    const data = {
      caseId: theCase.slug,
      description: 'Sidang perdana dijadwalkan pekan depan menurut rilis resmi pengadilan.',
      proofLinks: JSON.stringify(['https://pn.example.go.id/rilis']),
      ...fields,
    };
    Object.entries(data).forEach(([k, v]) => {
      req = req.field(k, v);
    });
    files.forEach(([buf, name]) => {
      req = req.attach('proofFiles', buf, name);
    });
    return req;
  };

  it('rejects a file whose bytes do not match an allowed type, whatever its name', async () => {
    const res = await submit(contributor.token, {}, [[Buffer.from('MZ\x90\x00 fake exe'), 'bukti.pdf']]);
    expect(res.status).toBe(400);
    expect(await prisma.caseContribution.count()).toBe(0);
  });

  it('requires at least one proof', async () => {
    const res = await submit(contributor.token, { proofLinks: '[]' });
    expect(res.status).toBe(400);
  });

  it('stores valid files privately and lets only staff download them', async () => {
    const res = await submit(contributor.token, {}, [[PNG, 'foto.png'], [PDF, 'surat.pdf']]);
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body.data.proofFiles)).not.toContain('/tmp');

    const queue = await api().get('/api/admin/contributions').set('Authorization', `Bearer ${editor.token}`).expect(200);
    const item = queue.body.data[0];
    expect(item.proofFiles.map((f) => f.mimeType)).toEqual(['image/png', 'application/pdf']);
    expect(item.user.reputation).toMatchObject({ pending: 1, approved: 0 });

    const file = await api()
      .get(`/api/admin/contributions/${item.id}/files/1`)
      .set('Authorization', `Bearer ${editor.token}`)
      .expect(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    await api().get(`/api/admin/contributions/${item.id}/files/1`).set('Authorization', `Bearer ${contributor.token}`).expect(403);
  });

  it('limits new accounts to one pending contribution', async () => {
    const fresh = await makeUser('CONTRIBUTOR', { createdAt: new Date() });
    await submit(fresh.token).expect(201);
    const second = await submit(fresh.token);
    expect(second.status).toBe(429);
  });

  it('approving with "apply" creates a stage, imports sources and notifies the contributor', async () => {
    await submit(contributor.token, { proposedStage: 'PERSIDANGAN' }).expect(201);
    const id = (await prisma.caseContribution.findFirst()).id;

    await api()
      .post(`/api/admin/contributions/${id}/review`)
      .set('Authorization', `Bearer ${editor.token}`)
      .send({ decision: 'APPROVED', apply: { stageType: 'PERSIDANGAN', title: 'Sidang perdana' }, importLinks: true, verifyLinks: true })
      .expect(200);
    await flush();

    const detail = (await api().get(`/api/cases/${theCase.slug}`)).body.data;
    expect(detail.currentStatus).toBe('PERSIDANGAN');
    const stage = detail.stages.find((s) => s.title === 'Sidang perdana');
    expect(stage.sources[0]).toMatchObject({ url: 'https://pn.example.go.id/rilis', isVerified: true });

    const notes = await api().get('/api/me/notifications').set('Authorization', `Bearer ${contributor.token}`);
    expect(notes.body.data[0].type).toBe('CONTRIBUTION_REVIEWED');

    // A second review of the same item must fail.
    await api()
      .post(`/api/admin/contributions/${id}/review`)
      .set('Authorization', `Bearer ${editor.token}`)
      .send({ decision: 'REJECTED', rejectionReason: 'dobel' })
      .expect(409);
  });

  it('rejection requires a reason', async () => {
    await submit(contributor.token).expect(201);
    const id = (await prisma.caseContribution.findFirst()).id;
    await api()
      .post(`/api/admin/contributions/${id}/review`)
      .set('Authorization', `Bearer ${editor.token}`)
      .send({ decision: 'REJECTED' })
      .expect(400);
  });
});
