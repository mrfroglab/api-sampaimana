import { describe, it, expect } from 'vitest';
import durations from '../../src/lib/durations.js';

const { median, average, daysToDecision, stageDurations, openDays, summarize, buildTrends } = durations;
const d = (s) => new Date(`${s}T00:00:00Z`);

const decidedCase = (over = {}) => ({
  institution: 'KPK',
  currentStatus: 'PUTUSAN',
  filedAt: null,
  category: { name: 'Korupsi', slug: 'korupsi' },
  stages: [
    { stageType: 'PENYIDIKAN', startedAt: d('2024-01-01'), endedAt: d('2024-01-31') },
    { stageType: 'PENUNTUTAN', startedAt: d('2024-01-31'), endedAt: null },
    { stageType: 'PERSIDANGAN', startedAt: d('2024-03-01'), endedAt: d('2024-04-10') },
    { stageType: 'PUTUSAN', startedAt: d('2024-04-10'), endedAt: null },
  ],
  ...over,
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

describe('daysToDecision', () => {
  it('measures the first stage start to the first PUTUSAN start', () => {
    expect(daysToDecision(decidedCase())).toBe(100);
  });
  it('is null for undecided cases and for impossible orderings', () => {
    expect(daysToDecision(decidedCase({ stages: decidedCase().stages.slice(0, 3) }))).toBeNull();
    expect(daysToDecision({ stages: [] })).toBeNull();
  });
  it('falls back to filedAt when the first stage is missing', () => {
    expect(daysToDecision({ filedAt: d('2024-01-01'), stages: [] })).toBeNull();
    expect(daysToDecision({ filedAt: d('2023-12-01'), stages: [{ stageType: 'PUTUSAN', startedAt: d('2024-01-01') }] })).toBe(0);
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
  it('ignores negative spans and sorts unordered input', () => {
    const stages = [
      { stageType: 'PERSIDANGAN', startedAt: d('2024-03-01'), endedAt: null },
      { stageType: 'PENYIDIKAN', startedAt: d('2024-01-01'), endedAt: d('2023-12-01') },
    ];
    expect(stageDurations(stages)).toEqual([]);
  });
});

describe('openDays / summarize', () => {
  const now = d('2024-06-01');
  it('counts open days only for undecided cases', () => {
    expect(openDays(decidedCase(), now)).toBeNull();
    expect(openDays(decidedCase({ currentStatus: 'PERSIDANGAN' }), now)).toBe(152);
  });

  it('summarises a group', () => {
    const s = summarize(
      [
        decidedCase(),
        decidedCase({ stages: [{ stageType: 'PENYIDIKAN', startedAt: d('2024-01-01') }, { stageType: 'PUTUSAN', startedAt: d('2024-03-01') }] }),
        decidedCase({ currentStatus: 'PERSIDANGAN', stages: [{ stageType: 'PENYIDIKAN', startedAt: d('2024-02-01') }] }),
      ],
      now,
    );
    expect(s).toMatchObject({ cases: 3, decided: 2, ongoing: 1, medianDaysToDecision: 80, avgDaysToDecision: 80, longestOpenDays: 121 });
    expect(s.medianDaysPerStage.PENYIDIKAN).toBe(45);
    expect(s.medianDaysPerStage.PUTUSAN).toBeNull();
    expect(Object.keys(s.medianDaysPerStage)).toEqual(['PELAPORAN', 'PENYIDIKAN', 'PENUNTUTAN', 'PERSIDANGAN', 'PUTUSAN']);
  });
});

describe('buildTrends', () => {
  const now = d('2024-06-01');
  const cases = [
    decidedCase({ institution: 'KPK' }),
    decidedCase({ institution: 'Kejaksaan Agung', stages: [{ stageType: 'PENYIDIKAN', startedAt: d('2024-01-01') }, { stageType: 'PUTUSAN', startedAt: d('2024-01-11') }] }),
    decidedCase({ institution: 'Polri', currentStatus: 'PENYIDIKAN', stages: [{ stageType: 'PENYIDIKAN', startedAt: d('2024-01-01') }] }),
    decidedCase({ institution: 'kpk ' }),
    decidedCase({ institution: null }),
  ];

  it('groups by slug, skips empty keys and sorts by median days to decision (nulls last)', () => {
    const groups = buildTrends(cases, 'institution', now);
    expect(groups.map((g) => [g.slug, g.cases, g.medianDaysToDecision])).toEqual([
      ['kpk', 2, 100],
      ['kejaksaan-agung', 1, 10],
      ['polri', 1, null],
    ]);
    expect(groups[0]).toMatchObject({ key: 'KPK', label: 'KPK', decided: 2, ongoing: 0 });
    expect(groups[2]).toMatchObject({ longestOpenDays: 152, ongoing: 1 });
  });

  it('supports court, region and category', () => {
    expect(buildTrends(cases, 'category', now)).toHaveLength(1);
    expect(buildTrends(cases, 'category', now)[0]).toMatchObject({ slug: 'korupsi', label: 'Korupsi', cases: 5 });
    expect(buildTrends(cases, 'court', now)).toEqual([]);
  });

  it('rejects an unknown grouping', () => {
    expect(() => buildTrends(cases, 'bogus')).toThrow();
  });
});
