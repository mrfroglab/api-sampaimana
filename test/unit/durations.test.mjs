import { describe, it, expect } from 'vitest';
import durations from '../../src/lib/durations.js';

const { MIN_SAMPLES, median, average, investigationToVerdictDays, stageDurations, summarize, buildTrends } = durations;
const d = (s) => new Date(`${s}T00:00:00Z`);

/** A decided case; every stage verified unless overridden. */
const decidedCase = (over = {}) => ({
  institution: 'KPK',
  currentStatus: 'PUTUSAN',
  category: { name: 'Korupsi', slug: 'korupsi' },
  stages: [
    { stageType: 'PENYIDIKAN', startedAt: d('2024-01-01'), endedAt: d('2024-01-31'), verified: true },
    { stageType: 'PENUNTUTAN', startedAt: d('2024-01-31'), endedAt: null, verified: true },
    { stageType: 'PERSIDANGAN', startedAt: d('2024-03-01'), endedAt: d('2024-04-10'), verified: true },
    { stageType: 'PUTUSAN', startedAt: d('2024-04-10'), endedAt: null, verified: true },
  ],
  ...over,
});
const invToVerdict = (from, to, extra = {}) =>
  decidedCase({
    stages: [
      { stageType: 'PENYIDIKAN', startedAt: d(from), verified: true },
      { stageType: 'PUTUSAN', startedAt: d(to), verified: true },
    ],
    ...extra,
  });

describe('median / average', () => {
  it('handles odd, even and empty lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(average([1, 2, 4])).toBe(2.3);
    expect(average([])).toBeNull();
  });
});

describe('investigationToVerdictDays', () => {
  it('measures the verified PENYIDIKAN start to the verified PUTUSAN start', () => {
    expect(investigationToVerdictDays(decidedCase())).toBe(100);
  });
  it('ignores unverified stages: both ends must be verified', () => {
    const c = decidedCase();
    c.stages[3].verified = false;
    expect(investigationToVerdictDays(c)).toBeNull();
    const c2 = decidedCase();
    c2.stages[0].verified = false;
    expect(investigationToVerdictDays(c2)).toBeNull();
  });
  it('uses the earliest verified stage of each type, skipping an earlier unverified one', () => {
    const c = decidedCase({
      stages: [
        { stageType: 'PENYIDIKAN', startedAt: d('2023-12-01'), verified: false },
        { stageType: 'PENYIDIKAN', startedAt: d('2024-01-01'), verified: true },
        { stageType: 'PUTUSAN', startedAt: d('2024-01-11'), verified: true },
      ],
    });
    expect(investigationToVerdictDays(c)).toBe(10);
  });
  it('is null when there is no PENYIDIKAN (e.g. civil suits), no verdict, or an impossible order', () => {
    expect(investigationToVerdictDays({ stages: [{ stageType: 'PERSIDANGAN', startedAt: d('2024-01-01'), verified: true }, { stageType: 'PUTUSAN', startedAt: d('2024-02-01'), verified: true }] })).toBeNull();
    expect(investigationToVerdictDays(decidedCase({ stages: decidedCase().stages.slice(0, 3) }))).toBeNull();
    expect(investigationToVerdictDays(invToVerdict('2024-05-01', '2024-01-01'))).toBeNull();
    expect(investigationToVerdictDays({ stages: [] })).toBeNull();
  });
});

describe('stageDurations', () => {
  it('uses endedAt, else the next stage start, and skips the open last stage', () => {
    expect(stageDurations(decidedCase().stages)).toEqual([
      { stageType: 'PENYIDIKAN', days: 30 },
      { stageType: 'PENUNTUTAN', days: 30 },
      { stageType: 'PERSIDANGAN', days: 40 },
    ]);
  });
  it('verifiedOnly reports only verified stages but still ends them at the next (unverified) stage', () => {
    const stages = decidedCase().stages;
    stages[1].verified = false;
    stages[0].endedAt = null; // PENYIDIKAN now ends at the next stage start even though that stage is unverified
    expect(stageDurations(stages, { verifiedOnly: true })).toEqual([
      { stageType: 'PENYIDIKAN', days: 30 },
      { stageType: 'PERSIDANGAN', days: 40 },
    ]);
  });
  it('ignores negative spans and sorts unordered input', () => {
    const stages = [
      { stageType: 'PERSIDANGAN', startedAt: d('2024-03-01'), endedAt: null },
      { stageType: 'PENYIDIKAN', startedAt: d('2024-01-01'), endedAt: d('2023-12-01') },
    ];
    expect(stageDurations(stages)).toEqual([]);
  });
});

describe('summarize', () => {
  it('reports samples, spread and per-stage medians from verified data only', () => {
    const unverified = decidedCase();
    unverified.stages.forEach((s) => (s.verified = false));
    const s = summarize([decidedCase(), invToVerdict('2024-01-01', '2024-03-01'), invToVerdict('2024-01-01', '2024-01-11'), unverified, decidedCase({ currentStatus: 'PERSIDANGAN' })]);
    expect(s).toMatchObject({ cases: 5, decided: 4, ongoing: 1, samples: 4, lowSample: false, medianDays: 80, minDays: 10, maxDays: 100 });
    expect(s.avgDays).toBe(67.5); // (100 + 60 + 10 + 100) / 4
    expect(s.verifiedStages).toBe(2 + 2 + 4 + 4);
    expect(s.stages).toBe(4 + 2 + 2 + 4 + 4);
    expect(s.medianDaysPerStage.PENYIDIKAN).toBe(30);
    expect(s.medianDaysPerStage.PUTUSAN).toBeNull();
    expect(Object.keys(s.medianDaysPerStage)).toEqual(['PELAPORAN', 'PENYIDIKAN', 'PENUNTUTAN', 'PERSIDANGAN', 'PUTUSAN']);
  });
  it('flags thin samples', () => {
    expect(summarize([decidedCase(), decidedCase()]).lowSample).toBe(true);
    expect(summarize(Array.from({ length: MIN_SAMPLES }, () => decidedCase())).lowSample).toBe(false);
    expect(summarize([]).medianDays).toBeNull();
  });
});

describe('buildTrends', () => {
  const many = (n, over) => Array.from({ length: n }, () => decidedCase(over));
  const cases = [
    ...many(3, { institution: 'KPK' }), // 100 days, 3 samples
    ...Array.from({ length: 3 }, () => invToVerdict('2024-01-01', '2024-01-11', { institution: 'Kejaksaan Agung' })), // 10 days
    invToVerdict('2024-01-01', '2025-01-01', { institution: 'Polri' }), // 1 sample, very slow: must not outrank
    decidedCase({ institution: 'Polda', stages: [{ stageType: 'PENYIDIKAN', startedAt: d('2024-01-01'), verified: false }] }), // none measured
    decidedCase({ institution: 'kpk ' }), // merges into KPK
    decidedCase({ institution: null }),
  ];

  it('ranks groups with enough samples slowest-first, then thin samples, then unmeasured; merges by slug', () => {
    const { groups } = buildTrends(cases, 'institution');
    expect(groups.map((g) => [g.slug, g.cases, g.samples, g.medianDays])).toEqual([
      ['kpk', 4, 4, 100],
      ['kejaksaan-agung', 3, 3, 10],
      ['polri', 1, 1, 366],
      ['polda', 1, 0, null],
    ]);
    expect(groups[0]).toMatchObject({ key: 'KPK', label: 'KPK', lowSample: false });
    expect(groups[2].lowSample).toBe(true);
  });

  it('reports coverage and the sample threshold', () => {
    const t = buildTrends(cases, 'institution');
    expect(t.minSamples).toBe(MIN_SAMPLES);
    // 10 cases; only Polda's has nothing measured. Stages: 4 KPK-style cases x4, 3 Kejagung x2, Polri 2, Polda 1 (unverified), the null-institution case x4.
    expect(t.coverage).toEqual({ cases: 10, measuredCases: 9, verifiedStages: 16 + 6 + 2 + 0 + 4, stages: 16 + 6 + 2 + 1 + 4 });
  });

  it('supports court, region and category', () => {
    expect(buildTrends(cases, 'category').groups[0]).toMatchObject({ slug: 'korupsi', label: 'Korupsi', cases: 10 });
    expect(buildTrends(cases, 'court').groups).toEqual([]);
  });

  it('rejects an unknown grouping', () => {
    expect(() => buildTrends(cases, 'bogus')).toThrow();
  });
});
