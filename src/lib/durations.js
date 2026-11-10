const { STATUS_ORDER } = require('./labels');
const { slugify } = require('./slug');
const { DAY_MS } = require('./dates');

const round1 = (n) => Math.round(n * 10) / 10;
const daysBetween = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / DAY_MS;

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return round1(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
};

const average = (values) => (values.length ? round1(values.reduce((a, b) => a + b, 0) / values.length) : null);

const byStart = (a, b) => new Date(a.startedAt) - new Date(b.startedAt);

/** When the case started being tracked: first stage start, else filedAt. */
const caseStart = (c) => {
  const first = [...(c.stages || [])].sort(byStart)[0];
  return first?.startedAt ?? c.filedAt ?? null;
};

/** Days from the case start to the first PUTUSAN stage; null when undecided or inconsistent. */
const daysToDecision = (c) => {
  const start = caseStart(c);
  const verdict = (c.stages || []).filter((s) => s.stageType === 'PUTUSAN').sort(byStart)[0];
  if (!start || !verdict) return null;
  const days = daysBetween(start, verdict.startedAt);
  return days >= 0 ? days : null;
};

/**
 * Per stage: startedAt to endedAt, or to the next stage's start when endedAt is missing.
 * Stages that are still open and have no successor are skipped.
 */
const stageDurations = (stages) => {
  const sorted = [...(stages || [])].sort(byStart);
  const out = [];
  sorted.forEach((s, i) => {
    const end = s.endedAt ?? sorted[i + 1]?.startedAt;
    if (!end) return;
    const days = daysBetween(s.startedAt, end);
    if (days >= 0) out.push({ stageType: s.stageType, days });
  });
  return out;
};

/** Days a not-yet-decided case has been open. */
const openDays = (c, now) => {
  if (c.currentStatus === 'PUTUSAN') return null;
  const start = caseStart(c);
  if (!start) return null;
  return Math.max(0, daysBetween(start, now));
};

/** Aggregate numbers for a set of cases. Pure. */
const summarize = (cases, now = new Date()) => {
  const toDecision = cases.map(daysToDecision).filter((d) => d !== null);
  const perStage = Object.fromEntries(STATUS_ORDER.map((t) => [t, []]));
  cases.forEach((c) =>
    stageDurations(c.stages).forEach(({ stageType, days }) => {
      if (perStage[stageType]) perStage[stageType].push(days);
    }),
  );
  const open = cases.map((c) => openDays(c, now)).filter((d) => d !== null);
  const decided = cases.filter((c) => c.currentStatus === 'PUTUSAN').length;
  return {
    cases: cases.length,
    decided,
    ongoing: cases.length - decided,
    medianDaysToDecision: median(toDecision),
    avgDaysToDecision: average(toDecision),
    medianDaysPerStage: Object.fromEntries(STATUS_ORDER.map((t) => [t, median(perStage[t])])),
    longestOpenDays: open.length ? Math.floor(Math.max(...open)) : null,
  };
};

const GROUPERS = {
  institution: (c) => (c.institution ? { label: c.institution.trim(), slug: slugify(c.institution) } : null),
  court: (c) => (c.court ? { label: c.court.trim(), slug: slugify(c.court) } : null),
  region: (c) => (c.region ? { label: c.region.trim(), slug: slugify(c.region) } : null),
  category: (c) => (c.category ? { label: c.category.name, slug: c.category.slug } : null),
};
const GROUP_BY = Object.keys(GROUPERS);

/** Groups cases by key (merging keys that share a slug), then summarises each group. */
const buildTrends = (cases, groupBy, now = new Date()) => {
  const grouper = GROUPERS[groupBy];
  if (!grouper) throw new Error(`groupBy tidak dikenal: ${groupBy}`);
  const groups = new Map();
  cases.forEach((c) => {
    const key = grouper(c);
    if (!key?.label || !key.slug) return;
    if (!groups.has(key.slug)) groups.set(key.slug, { key: key.label, slug: key.slug, label: key.label, items: [] });
    groups.get(key.slug).items.push(c);
  });
  return [...groups.values()]
    .map(({ items, ...g }) => ({ ...g, ...summarize(items, now) }))
    .sort((a, b) => {
      const am = a.medianDaysToDecision;
      const bm = b.medianDaysToDecision;
      if (am === null && bm !== null) return 1;
      if (bm === null && am !== null) return -1;
      if (am !== bm) return bm - am;
      return b.cases - a.cases || a.label.localeCompare(b.label, 'id');
    });
};

module.exports = { median, average, caseStart, daysToDecision, stageDurations, openDays, summarize, buildTrends, GROUP_BY };
