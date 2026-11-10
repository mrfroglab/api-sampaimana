import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import helpers from './helpers.js';

const { api, prisma, resetDb, makeUser, makeCase, flush } = helpers;
const fixture = (name) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/sipp', name), 'utf8');

describe('SIPP import', () => {
  let editor;
  let c;
  const auth = (u = editor) => ({ Authorization: `Bearer ${u.token}` });
  const preview = (input, u = editor, id = c.id) => api().post(`/api/admin/cases/${id}/sipp/preview`).set(auth(u)).send({ input });
  const apply = (body, u = editor, id = c.id) => api().post(`/api/admin/cases/${id}/sipp/apply`).set(auth(u)).send(body);

  beforeEach(async () => {
    await resetDb();
    editor = await makeUser('EDITOR');
    c = await makeCase(editor.token, { currentStatus: 'PENUNTUTAN' });
  });
  afterAll(() => prisma.$disconnect());

  it('previews parsed data and proposals without writing anything', async () => {
    const res = await preview(fixture('pidana-putusan.html')).expect(200);
    const { parsed, proposals, warnings } = res.body.data;
    expect(parsed).toMatchObject({ caseNumber: '412/Pid.B/2024/PN Bdg', court: 'PN Bandung', verdictDate: '2024-12-12' });
    expect(proposals.map((p) => p.stageType)).toEqual(['PERSIDANGAN', 'PUTUSAN']);
    expect(warnings).toEqual([]);
    expect(await prisma.caseStage.count({ where: { caseId: c.id } })).toBe(1);
    expect(await prisma.caseRevision.count({ where: { caseId: c.id, action: 'SIPP_IMPORT' } })).toBe(0);
  });

  it('applies only the selected proposals through the normal stage path', async () => {
    const follower = await makeUser();
    await api().post(`/api/cases/${c.slug}/follow`).set(auth(follower)).expect(200);
    const text = fixture('pidana-putusan.html');
    const { proposals } = (await preview(text)).body.data;
    const putusan = proposals.find((p) => p.stageType === 'PUTUSAN');

    const sippUrl = 'https://sipp.pn-bandung.go.id/index.php/detil_perkara/abc123';
    const res = await apply({ input: text, keys: [putusan.key], sippUrl }).expect(200);
    await flush();

    expect(res.body.data.created).toHaveLength(1);
    expect(res.body.data.created[0]).toMatchObject({ stageType: 'PUTUSAN', status: 'AKTIF', caseId: c.id });
    expect(res.body.data.case).toEqual({ id: c.id, slug: c.slug, currentStatus: 'PUTUSAN' });

    const detail = (await api().get(`/api/cases/${c.slug}`)).body.data;
    expect(detail.sippUrl).toBe(sippUrl);
    expect(detail.currentStatus).toBe('PUTUSAN');
    // Timeline is ordered by date: the verdict (2024) precedes the placeholder stage created "today".
    expect(detail.stages.map((s) => [s.stageType, s.status])).toEqual([['PUTUSAN', 'AKTIF'], ['PENUNTUTAN', 'SELESAI']]);
    expect(detail.revisions.map((r) => r.action)).toEqual(expect.arrayContaining(['SIPP_IMPORT', 'STAGE_ADDED', 'STATUS_CHANGED']));

    const notes = await api().get('/api/me/notifications').set(auth(follower)).expect(200);
    expect(notes.body.data[0]).toMatchObject({ type: 'STATUS_CHANGE', link: `/kasus/${c.slug}` });
  });

  it('applies several proposals in order and keeps status/active-stage in sync', async () => {
    const text = fixture('pidana-putusan.html');
    const { proposals } = (await preview(text)).body.data;
    const res = await apply({ input: text, keys: proposals.map((p) => p.key) }).expect(200);
    expect(res.body.data.created.map((s) => s.stageType)).toEqual(['PERSIDANGAN', 'PUTUSAN']);
    const stages = await prisma.caseStage.findMany({ where: { caseId: c.id }, orderBy: { startedAt: 'asc' } });
    expect(stages.filter((s) => s.status === 'AKTIF').map((s) => s.stageType)).toEqual(['PUTUSAN']);
    expect((await prisma.case.findUnique({ where: { id: c.id } })).currentStatus).toBe('PUTUSAN');
  });

  it('sets dueAt on the active PERSIDANGAN stage from the next hearing', async () => {
    const text = fixture('perdata-ptun.html');
    const { proposals } = (await preview(text)).body.data;
    expect(proposals).toHaveLength(1);
    const res = await apply({ input: text, keys: [proposals[0].key] }).expect(200);
    expect(res.body.data.created[0]).toMatchObject({ stageType: 'PERSIDANGAN', status: 'AKTIF' });
    expect(new Date(res.body.data.created[0].dueAt).toISOString()).toBe('2099-12-02T17:00:00.000Z');
    expect(res.body.data.case.currentStatus).toBe('PERSIDANGAN');
  });

  it('does not propose duplicates after an import and rejects stale keys', async () => {
    const text = fixture('perdata-ptun.html');
    const { proposals } = (await preview(text)).body.data;
    await apply({ input: text, keys: [proposals[0].key] }).expect(200);
    const again = (await preview(text)).body.data;
    expect(again.proposals).toEqual([]);
    const stale = await apply({ input: text, keys: [proposals[0].key] });
    expect(stale.status).toBe(400);
    expect(stale.body.message).toMatch(/tidak berlaku/);
    expect(await prisma.caseStage.count({ where: { caseId: c.id } })).toBe(2);
  });

  it('can save just the SIPP link, and rejects unknown keys', async () => {
    const text = fixture('pidana-tab.txt');
    const res = await apply({ input: text, keys: [], sippUrl: 'https://sipp.pn-jakartaselatan.go.id/x' }).expect(200);
    expect(res.body.data.created).toEqual([]);
    expect((await prisma.case.findUnique({ where: { id: c.id } })).sippUrl).toBe('https://sipp.pn-jakartaselatan.go.id/x');
    await apply({ input: text, keys: ['nope'] }).expect(400);
    await apply({ input: text, keys: [], sippUrl: 'javascript:alert(1)' }).expect(400);
  });

  it('validates input and the case id', async () => {
    await preview('').expect(400);
    await api().post(`/api/admin/cases/${c.id}/sipp/preview`).set(auth()).send({}).expect(400);
    await preview('Nomor Perkara\tx', editor, '00000000-0000-4000-8000-000000000000').expect(404);
    const unrecognised = await preview('bukan halaman sipp').expect(200);
    expect(unrecognised.body.data.proposals).toEqual([]);
    expect(unrecognised.body.data.warnings.join()).toMatch(/Tidak ada data SIPP/);
  });

  it('accepts pasted pages above the default 200kb body limit, up to 2MB, and rejects more', async () => {
    const big = `${fixture('pidana-tab.txt')}\n${'x '.repeat(300_000)}`; // ~600kB
    await preview(big).expect(200);
    const tooBig = `Nomor Perkara\t1\n${'x'.repeat(2 * 1024 * 1024 + 10)}`;
    const res = await preview(tooBig);
    expect(res.status).toBe(400);
  });

  it('is editors only', async () => {
    const viewer = await makeUser('VIEWER');
    const contributor = await makeUser();
    const text = fixture('pidana-tab.txt');
    await preview(text, viewer).expect(403);
    await apply({ input: text, keys: [] }, viewer).expect(403);
    await preview(text, contributor).expect(403);
    await apply({ input: text, keys: [] }, contributor).expect(403);
    await api().post(`/api/admin/cases/${c.id}/sipp/preview`).send({ input: text }).expect(401);
  });

  it('exposes sippUrl on admin create/update and keeps it when omitted', async () => {
    const created = await makeCase(editor.token, { sippUrl: 'https://sipp.pn-bandung.go.id/a' });
    expect(created.sippUrl).toBe('https://sipp.pn-bandung.go.id/a');
    const full = (await api().get(`/api/admin/cases/${created.id}`).set(auth())).body.data;
    const payload = { caseNumber: full.caseNumber, title: full.title, description: full.description, categoryId: full.categoryId, currentStatus: full.currentStatus, defendants: [] };
    const kept = await api().put(`/api/admin/cases/${created.id}`).set(auth()).send(payload).expect(200);
    expect(kept.body.data.sippUrl).toBe('https://sipp.pn-bandung.go.id/a');
    const changed = await api().put(`/api/admin/cases/${created.id}`).set(auth()).send({ ...payload, sippUrl: 'https://sipp.pn-bandung.go.id/b' }).expect(200);
    expect(changed.body.data.sippUrl).toBe('https://sipp.pn-bandung.go.id/b');
    const cleared = await api().put(`/api/admin/cases/${created.id}`).set(auth()).send({ ...payload, sippUrl: '' }).expect(200);
    expect(cleared.body.data.sippUrl).toBeNull();
    await api().put(`/api/admin/cases/${created.id}`).set(auth()).send({ ...payload, sippUrl: 'ftp://x' }).expect(400);
  });
});
