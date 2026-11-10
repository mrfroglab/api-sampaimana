const env = require('../config/env');
const { DAY_MS } = require('./dates');

const SOON_DAYS = 7;
const MAX_PER_LIST = 200;

const caseRef = (c) => ({ id: c.id, slug: c.slug, title: c.title, caseNumber: c.caseNumber, currentStatus: c.currentStatus });
const stageRef = (s) => (s ? { id: s.id, stageType: s.stageType, startedAt: s.startedAt, dueAt: s.dueAt } : null);
const wholeDays = (ms) => Math.max(0, Math.floor(ms / DAY_MS));

/**
 * Pure classification of editorial attention items.
 *  - `stages`: active (AKTIF) stages with a dueAt, each carrying its `case`
 *  - `cases`: active, undecided cases each with `stages` (their active stage, if any)
 */
const buildAttention = ({ stages, cases }, now = new Date(), staleDays = 30) => {
  const t = now.getTime();
  const overdue = [];
  const dueSoon = [];
  stages.forEach((s) => {
    if (!s.dueAt) return;
    const diff = new Date(s.dueAt).getTime() - t;
    if (diff < 0) overdue.push({ case: caseRef(s.case), stage: stageRef(s), days: wholeDays(-diff) });
    else if (diff <= SOON_DAYS * DAY_MS) dueSoon.push({ case: caseRef(s.case), stage: stageRef(s), days: wholeDays(diff) });
  });
  const cutoff = t - staleDays * DAY_MS;
  const stale = cases
    .filter((c) => c.currentStatus !== 'PUTUSAN' && new Date(c.lastActivityAt).getTime() < cutoff)
    .map((c) => ({ case: caseRef(c), stage: stageRef(c.stages?.[0]), days: wholeDays(t - new Date(c.lastActivityAt).getTime()) }));

  return {
    overdue: overdue.sort((a, b) => b.days - a.days).slice(0, MAX_PER_LIST),
    dueSoon: dueSoon.sort((a, b) => a.days - b.days || new Date(a.stage.dueAt) - new Date(b.stage.dueAt)).slice(0, MAX_PER_LIST),
    stale: stale.sort((a, b) => b.days - a.days).slice(0, MAX_PER_LIST),
  };
};

const caseSelect = { id: true, slug: true, title: true, caseNumber: true, currentStatus: true };

/** Loads the data for buildAttention from the database. */
const loadAttention = async (db, now = new Date(), staleDays = env.STALE_DAYS) => {
  const soonLimit = new Date(now.getTime() + SOON_DAYS * DAY_MS);
  const staleCutoff = new Date(now.getTime() - staleDays * DAY_MS);
  const [stages, cases] = await Promise.all([
    db.caseStage.findMany({
      where: { status: 'AKTIF', dueAt: { not: null, lte: soonLimit }, case: { isActive: true } },
      select: { id: true, stageType: true, startedAt: true, dueAt: true, case: { select: caseSelect } },
    }),
    db.case.findMany({
      where: { isActive: true, currentStatus: { not: 'PUTUSAN' }, lastActivityAt: { lt: staleCutoff } },
      select: {
        ...caseSelect,
        lastActivityAt: true,
        stages: { where: { status: 'AKTIF' }, orderBy: { startedAt: 'desc' }, take: 1, select: { id: true, stageType: true, startedAt: true, dueAt: true } },
      },
    }),
  ]);
  return buildAttention({ stages, cases }, now, staleDays);
};

const countsOf = (a) => ({ overdue: a.overdue.length, dueSoon: a.dueSoon.length, stale: a.stale.length });
const isEmpty = (a) => a.overdue.length + a.dueSoon.length + a.stale.length === 0;

/** Human summary used by the in-app notification and the email. */
const describeDigest = (a, staleDays = 30) => {
  const parts = [];
  if (a.overdue.length) parts.push(`${a.overdue.length} tahapan lewat tenggat`);
  if (a.dueSoon.length) parts.push(`${a.dueSoon.length} tahapan jatuh tempo dalam ${SOON_DAYS} hari`);
  if (a.stale.length) parts.push(`${a.stale.length} kasus tanpa pembaruan lebih dari ${staleDays} hari`);
  const top = [...a.overdue, ...a.dueSoon, ...a.stale].slice(0, 3).map((i) => i.case.title);
  return {
    title: `Pengingat redaksi: ${a.overdue.length + a.dueSoon.length + a.stale.length} hal perlu perhatian`,
    body: `${parts.join(', ')}.${top.length ? ` Antara lain: ${top.join('; ')}.` : ''}`,
  };
};

module.exports = { buildAttention, loadAttention, countsOf, isEmpty, describeDigest, SOON_DAYS };
