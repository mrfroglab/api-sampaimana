import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import helpers from './helpers.js';
import digestMod from '../../src/jobs/digest.js';
import schedulerMod from '../../src/jobs/scheduler.js';

const { api, prisma, resetDb, makeUser, makeCase, flush } = helpers;
const { runEditorialDigest } = digestMod;
const { runOncePerDay, tick } = schedulerMod;

const DAY = 86400000;
const ago = (n) => new Date(Date.now() - n * DAY);

describe('editorial attention', () => {
  let editor;
  const auth = (u = editor) => ({ Authorization: `Bearer ${u.token}` });

  /** A case whose active stage has the given dueAt and whose lastActivityAt is set. */
  const seedCase = async (title, { dueAt = null, lastActivityAt = new Date(), currentStatus = 'PERSIDANGAN' } = {}) => {
    const c = await makeCase(editor.token, { title, currentStatus });
    await prisma.caseStage.updateMany({ where: { caseId: c.id, status: 'AKTIF' }, data: { dueAt } });
    await prisma.case.update({ where: { id: c.id }, data: { lastActivityAt } });
    return c;
  };

  beforeEach(async () => {
    await resetDb();
    editor = await makeUser('EDITOR');
  });
  afterAll(() => prisma.$disconnect());

  it('lists overdue, due soon and stale items, most urgent first', async () => {
    const late = await seedCase('Kasus Terlambat Sepuluh Hari', { dueAt: ago(10) });
    await seedCase('Kasus Terlambat Dua Hari', { dueAt: ago(2) });
    const soon = await seedCase('Kasus Segera Tiga Hari', { dueAt: new Date(Date.now() + 3.5 * DAY) });
    await seedCase('Kasus Masih Jauh', { dueAt: new Date(Date.now() + 20 * DAY) });
    const stale = await seedCase('Kasus Menggantung', { lastActivityAt: ago(45) });
    await seedCase('Kasus Putusan Lama', { lastActivityAt: ago(400), currentStatus: 'PUTUSAN' });
    const archived = await seedCase('Kasus Arsip Terlambat', { dueAt: ago(5) });
    await api().delete(`/api/admin/cases/${archived.id}`).set(auth()).send({}).expect(200);

    const res = await api().get('/api/admin/attention').set(auth()).expect(200);
    const { overdue, dueSoon, stale: staleList } = res.body.data;
    expect(overdue.map((i) => [i.case.title, i.days])).toEqual([['Kasus Terlambat Sepuluh Hari', 10], ['Kasus Terlambat Dua Hari', 2]]);
    expect(overdue[0]).toMatchObject({
      case: { id: late.id, slug: late.slug, caseNumber: late.caseNumber, currentStatus: 'PERSIDANGAN' },
      stage: { stageType: 'PERSIDANGAN' },
    });
    expect(overdue[0].stage).toHaveProperty('id');
    expect(overdue[0].stage).toHaveProperty('startedAt');
    expect(overdue[0].stage).toHaveProperty('dueAt');
    expect(dueSoon.map((i) => [i.case.id, i.days])).toEqual([[soon.id, 3]]);
    expect(staleList.map((i) => [i.case.id, i.days])).toEqual([[stale.id, 45]]);
    expect(staleList[0].stage).toMatchObject({ stageType: 'PERSIDANGAN' });
  });

  it('is open to staff but not to contributors or anonymous visitors', async () => {
    const viewer = await makeUser('VIEWER');
    const contributor = await makeUser();
    await api().get('/api/admin/attention').set(auth(viewer)).expect(200);
    await api().get('/api/admin/attention').set(auth(contributor)).expect(403);
    await api().get('/api/admin/attention').expect(401);
  });

  describe('daily digest', () => {
    it('does nothing when there is nothing to report', async () => {
      const out = await runEditorialDigest(new Date());
      expect(out).toMatchObject({ sent: 0, skipped: true });
      expect(await prisma.notification.count()).toBe(0);
    });

    it('notifies editors and super admins (not viewers, contributors or banned users) once', async () => {
      const admin = await makeUser('SUPER_ADMIN');
      const viewer = await makeUser('VIEWER');
      const contributor = await makeUser();
      const banned = await makeUser('EDITOR');
      await prisma.user.update({ where: { id: banned.user.id }, data: { bannedAt: new Date() } });
      await seedCase('Kasus Terlambat Satu', { dueAt: ago(3) });
      await seedCase('Kasus Menggantung Dua', { lastActivityAt: ago(60) });

      const out = await runEditorialDigest(new Date());
      expect(out).toMatchObject({ sent: 2, skipped: false, counts: { overdue: 1, dueSoon: 0, stale: 1 } });

      const rows = await prisma.notification.findMany({ where: { type: 'EDITORIAL_REMINDER' } });
      expect(rows.map((r) => r.userId).sort()).toEqual([editor.user.id, admin.user.id].sort());
      expect(rows[0]).toMatchObject({ link: '/redaksi', caseId: null });
      expect(rows[0].body).toMatch(/1 tahapan lewat tenggat, 1 kasus tanpa pembaruan/);
      expect(rows.some((r) => [viewer.user.id, contributor.user.id].includes(r.userId))).toBe(false);

      const mine = await api().get('/api/me/notifications').set(auth()).expect(200);
      expect(mine.body.data[0]).toMatchObject({ type: 'EDITORIAL_REMINDER', link: '/redaksi' });
    });
  });

  describe('job guard', () => {
    it('runs a job once per day and skips later attempts', async () => {
      let runs = 0;
      const job = async () => { runs += 1; };
      expect(await runOncePerDay('editorial-digest', '2025-06-10', job)).toBe('ran');
      expect(await runOncePerDay('editorial-digest', '2025-06-10', job)).toBe('already-ran');
      expect(await runOncePerDay('editorial-digest', '2025-06-11', job)).toBe('ran');
      expect(runs).toBe(2);
      expect(await prisma.jobRun.count()).toBe(2);
    });

    it('two instances racing never double-run', async () => {
      let runs = 0;
      const job = async () => {
        runs += 1;
        await new Promise((r) => setTimeout(r, 300));
      };
      const results = await Promise.all([
        runOncePerDay('editorial-digest', '2025-07-01', job),
        runOncePerDay('editorial-digest', '2025-07-01', job),
        runOncePerDay('editorial-digest', '2025-07-01', job),
      ]);
      expect(runs).toBe(1);
      expect(results.filter((r) => r === 'ran')).toHaveLength(1);
      expect(results.filter((r) => r !== 'ran').every((r) => ['locked', 'already-ran'].includes(r))).toBe(true);
    });

    it('releases the claim when the job fails so the next tick retries', async () => {
      await expect(runOncePerDay('editorial-digest', '2025-08-01', async () => { throw new Error('smtp down'); })).rejects.toThrow('smtp down');
      expect(await prisma.jobRun.count()).toBe(0);
      expect(await runOncePerDay('editorial-digest', '2025-08-01', async () => {})).toBe('ran');
    });

    it('tick sends the digest after 07:00 Jakarta and only once that day', async () => {
      await seedCase('Kasus Terlambat Tick', { dueAt: ago(3) });
      const early = new Date('2099-01-05T23:30:00Z'); // 06:30 WIB on the 6th
      const later = new Date('2099-01-06T01:00:00Z'); // 08:00 WIB on the 6th
      expect(await tick(early)).toBe('too-early');
      expect(await tick(later)).toBe('ran');
      expect(await tick(new Date('2099-01-06T09:00:00Z'))).toBe('already-ran');
      await flush();
      expect(await prisma.notification.count({ where: { type: 'EDITORIAL_REMINDER' } })).toBe(1);
      expect((await prisma.jobRun.findMany()).map((r) => [r.name, r.runDate])).toEqual([['editorial-digest', '2099-01-06']]);
    });
  });
});
