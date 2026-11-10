const { STATUS_ORDER } = require('./labels');
const { slugify } = require('./slug');
const { DAY_MS } = require('./dates');

/**
 * Duration math for the public trends. Everything here is pure.
 *
 * Only VERIFIED stages count: a stage is verified when at least one source attached to it
 * was marked verified by the editors. Rows are expected to carry `stages[].verified` (boolean).
 * The headline measure is "penyidikan → putusan": days from the earliest verified PENYIDIKAN
 * stage to the earliest verified PUTUSAN stage of the same case.
 */

// Groups with fewer measured cases than this are shown but never ranked.
const MIN_SAMPLES = 3;

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

const earliestVerified = (stages, type) => (stages || []).filter((s) => s.verified && s.stageType === type).sort(byStart)[0];

/** Days from the earliest verified PENYIDIKAN to the earliest verified PUTUSAN; null if either is missing or out of order. */
const investigationToVerdictDays = (c) => {
  const from = earliestVerified(c.stages, 'PENYIDIKAN');
  const to = earliestVerified(c.stages, 'PUTUSAN');
  if (!from || !to) return null;
  const days = daysBetween(from.startedAt, to.startedAt);
  return days >= 0 ? days : null;
};

/**
 * Per stage: startedAt to endedAt, or to the next stage's start when endedAt is missing (the next stage is taken
 * from ALL stages so an unverified stage in between still ends the previous one). Stages that are still open and
 * have no successor are skipped. With `verifiedOnly` only verified stages are reported.
 */
const stageDurations = (stages, { verifiedOnly = false } = {}) => {
  const sorted = [...(stages || [])].sort(byStart);
  const out = [];
  sorted.forEach((s, i) => {
    if (verifiedOnly && !s.verified) return;
    const end = s.endedAt ?? sorted[i + 1]?.startedAt;
    if (!end) return;
    const days = daysBetween(s.startedAt, end);
    if (days >= 0) out.push({ stageType: s.stageType, days });
  });
  return out;
};

/** Aggregate numbers for a set of cases. */
const summarize = (cases) => {
  const days = cases.map(investigationToVerdictDays).filter((d) => d !== null);
  const perStage = Object.fromEntries(STATUS_ORDER.map((t) => [t, []]));
  cases.forEach((c) =>
    stageDurations(c.stages, { verifiedOnly: true }).forEach(({ stageType, days: d }) => {
      if (perStage[stageType]) perStage[stageType].push(d);
    }),
  );
  const stages = cases.flatMap((c) => c.stages || []);
  const decided = cases.filter((c) => c.currentStatus === 'PUTUSAN').length;
  return {
    cases: cases.length,
    decided,
    ongoing: cases.length - decided,
    samples: days.length,
    lowSample: days.length < MIN_SAMPLES,
    medianDays: median(days),
    avgDays: average(days),
    minDays: days.length ? round1(Math.min(...days)) : null,
    maxDays: days.length ? round1(Math.max(...days)) : null,
    medianDaysPerStage: Object.fromEntries(STATUS_ORDER.map((t) => [t, median(perStage[t])])),
    verifiedStages: stages.filter((s) => s.verified).length,
    stages: stages.length,
  };
};

const GROUPERS = {
  institution: (c) => (c.institution ? { label: c.institution.trim(), slug: slugify(c.institution) } : null),
  court: (c) => (c.court ? { label: c.court.trim(), slug: slugify(c.court) } : null),
  region: (c) => (c.region ? { label: c.region.trim(), slug: slugify(c.region) } : null),
  category: (c) => (c.category ? { label: c.category.name, slug: c.category.slug } : null),
};
const GROUP_BY = Object.keys(GROUPERS);

/** Ranking: enough samples first (slowest first), then thin samples, then groups with nothing measured. */
const rank = (a, b) => {
  const tier = (g) => (g.samples >= MIN_SAMPLES ? 0 : g.samples > 0 ? 1 : 2);
  if (tier(a) !== tier(b)) return tier(a) - tier(b);
  if (tier(a) < 2 && a.medianDays !== b.medianDays) return b.medianDays - a.medianDays;
  return b.samples - a.samples || b.cases - a.cases || a.label.localeCompare(b.label, 'id');
};

/** Groups cases by key (merging keys that share a slug), summarises each group, and reports overall coverage. */
const buildTrends = (cases, groupBy) => {
  const grouper = GROUPERS[groupBy];
  if (!grouper) throw new Error(`groupBy tidak dikenal: ${groupBy}`);
  const groups = new Map();
  cases.forEach((c) => {
    const key = grouper(c);
    if (!key?.label || !key.slug) return;
    if (!groups.has(key.slug)) groups.set(key.slug, { key: key.label, slug: key.slug, label: key.label, items: [] });
    groups.get(key.slug).items.push(c);
  });
  const rows = [...groups.values()].map(({ items, ...g }) => ({ ...g, ...summarize(items) })).sort(rank);
  const overall = summarize(cases);
  return {
    minSamples: MIN_SAMPLES,
    coverage: {
      cases: overall.cases,
      measuredCases: overall.samples,
      verifiedStages: overall.verifiedStages,
      stages: overall.stages,
    },
    groups: rows,
  };
};

module.exports = { MIN_SAMPLES, median, average, investigationToVerdictDays, stageDurations, summarize, buildTrends, GROUP_BY };
