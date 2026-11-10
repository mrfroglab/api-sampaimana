import { describe, it, expect, vi } from 'vitest';
import attention from '../../src/lib/attention.js';
import digest from '../../src/jobs/digest.js';
import scheduler from '../../src/jobs/scheduler.js';
import dates from '../../src/lib/dates.js';

const { buildAttention, describeDigest, countsOf, isEmpty } = attention;
const { runEditorialDigest } = digest;
const { tick } = scheduler;
const { jakartaDay, jakartaHour, wholeDaysBetween } = dates;

const NOW = new Date('2025-06-10T03:00:00Z');
const day = (n) => new Date(NOW.getTime() + n * 86400000);
const kase = (id, extra = {}) => ({ id, slug: `kasus-${id}`, title: `Kasus ${id}`, caseNumber: `NO/${id}`, currentStatus: 'PERSIDANGAN', ...extra });
const stage = (id, dueAt, c) => ({ id: `s${id}`, stageType: 'PERSIDANGAN', startedAt: day(-60), dueAt, case: c });

describe('buildAttention', () => {
  const data = {
    stages: [
      stage(1, day(-2.5), kase(1)), // overdue 2 days
      stage(2, day(-10), kase(2)), // overdue 10 days
      stage(3, day(3.5), kase(3)), // 3 days left
      stage(4, day(1.2), kase(4)), // 1 day left
      stage(5, day(7.5), kase(5)), // beyond a week: ignored
      stage(6, null, kase(6)), // no deadline: ignored
    ],
    cases: [
      { ...kase(7), lastActivityAt: day(-45), stages: [] },
      { ...kase(8), lastActivityAt: day(-90), stages: [{ id: 's8', stageType: 'PENYIDIKAN', startedAt: day(-100), dueAt: null }] },
      { ...kase(9), lastActivityAt: day(-10), stages: [] }, // recent
      { ...kase(10, { currentStatus: 'PUTUSAN' }), lastActivityAt: day(-400), stages: [] }, // decided
    ],
  };
  const result = buildAttention(data, NOW, 30);

  it('splits overdue, due soon and stale with whole-day counts', () => {
    expect(result.overdue.map((i) => [i.case.id, i.days])).toEqual([[2, 10], [1, 2]]);
    expect(result.dueSoon.map((i) => [i.case.id, i.days])).toEqual([[4, 1], [3, 3]]);
    expect(result.stale.map((i) => [i.case.id, i.days])).toEqual([[8, 90], [7, 45]]);
  });

  it('has the documented item shape', () => {
    expect(result.overdue[0]).toEqual({
      case: { id: 2, slug: 'kasus-2', title: 'Kasus 2', caseNumber: 'NO/2', currentStatus: 'PERSIDANGAN' },
      stage: { id: 's2', stageType: 'PERSIDANGAN', startedAt: day(-60), dueAt: day(-10) },
      days: 10,
    });
    expect(result.stale[1].stage).toBeNull();
    expect(result.stale[0].stage).toMatchObject({ id: 's8', stageType: 'PENYIDIKAN' });
  });

  it('honours the stale threshold', () => {
    expect(buildAttention(data, NOW, 60).stale.map((i) => i.case.id)).toEqual([8]);
    expect(buildAttention(data, NOW, 365).stale).toEqual([]);
  });

  it('reports emptiness and counts', () => {
    const empty = buildAttention({ stages: [], cases: [] }, NOW, 30);
    expect(isEmpty(empty)).toBe(true);
    expect(countsOf(result)).toEqual({ overdue: 2, dueSoon: 2, stale: 2 });
  });
});

describe('describeDigest', () => {
  it('summarises counts and names the most urgent cases', () => {
    const a = buildAttention({ stages: [stage(1, day(-3), kase(1))], cases: [{ ...kase(7), lastActivityAt: day(-45), stages: [] }] }, NOW, 30);
    const { title, body } = describeDigest(a, 30);
    expect(title).toBe('Pengingat redaksi: 2 hal perlu perhatian');
    expect(body).toContain('1 tahapan lewat tenggat');
    expect(body).toContain('1 kasus tanpa pembaruan lebih dari 30 hari');
    expect(body).toContain('Kasus 1; Kasus 7');
    expect(body).not.toContain('jatuh tempo');
  });
});

describe('runEditorialDigest (fake db)', () => {
  const fakeDb = ({ stages = [], cases = [], users = [] } = {}) => ({
    caseStage: { findMany: vi.fn().mockResolvedValue(stages) },
    case: { findMany: vi.fn().mockResolvedValue(cases) },
    user: { findMany: vi.fn().mockResolvedValue(users) },
    notification: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
  });

  it('sends nothing when all three lists are empty', async () => {
    const db = fakeDb({ users: [{ id: 'u1', email: 'e@x', emailNotifications: true }] });
    const out = await runEditorialDigest(NOW, { db, staleDays: 30 });
    expect(out).toMatchObject({ sent: 0, skipped: true, counts: { overdue: 0, dueSoon: 0, stale: 0 } });
    expect(db.notification.createMany).not.toHaveBeenCalled();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('notifies each recipient with an EDITORIAL_REMINDER linking to /redaksi', async () => {
    const db = fakeDb({
      stages: [stage(1, day(-3), kase(1))],
      users: [{ id: 'u1', email: 'a@x', emailNotifications: true }, { id: 'u2', email: 'b@x', emailNotifications: false }],
    });
    const out = await runEditorialDigest(NOW, { db, staleDays: 30 });
    expect(out).toMatchObject({ sent: 2, skipped: false, counts: { overdue: 1, dueSoon: 0, stale: 0 } });
    const { data } = db.notification.createMany.mock.calls[0][0];
    expect(data.map((n) => n.userId)).toEqual(['u1', 'u2']);
    expect(data[0]).toMatchObject({ type: 'EDITORIAL_REMINDER', link: '/redaksi' });
    expect(db.user.findMany.mock.calls[0][0].where).toEqual({ role: { in: ['EDITOR', 'SUPER_ADMIN'] }, bannedAt: null });
  });
});

describe('scheduler tick', () => {
  it('waits until 07:00 Asia/Jakarta', async () => {
    const digestFn = vi.fn();
    expect(await tick(new Date('2025-06-09T23:30:00Z'), { digest: digestFn })).toBe('too-early'); // 06:30 WIB
    expect(digestFn).not.toHaveBeenCalled();
  });
});

describe('date helpers', () => {
  it('computes Jakarta day and hour across the UTC boundary', () => {
    expect(jakartaDay(new Date('2025-06-09T20:00:00Z'))).toBe('2025-06-10');
    expect(jakartaHour(new Date('2025-06-09T23:59:00Z'))).toBe(6);
    expect(jakartaHour(new Date('2025-06-10T00:00:00Z'))).toBe(7);
    expect(wholeDaysBetween(day(-2.5), NOW)).toBe(2);
  });
});
