const express = require('express');
const prisma = require('../lib/prisma');
const { ok } = require('../lib/http');
const { STATUS_ORDER } = require('../lib/labels');

const router = express.Router();

router.get('/health', async (req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  return ok(res, { status: 'ok', time: new Date().toISOString() });
});

router.get('/categories', async (req, res) => {
  const categories = await prisma.category.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { cases: { where: { isActive: true } } } } },
  });
  return ok(
    res,
    categories.map(({ _count, ...c }) => ({ ...c, caseCount: _count.cases })),
  );
});

/** Public statistics for the homepage and /statistik. */
router.get('/stats', async (req, res) => {
  const [total, byStatusRaw, byCategory, durations, longestActive, recentUpdates, sourceCounts, followers] =
    await Promise.all([
      prisma.case.count({ where: { isActive: true } }),
      prisma.case.groupBy({ by: ['currentStatus'], where: { isActive: true }, _count: { _all: true } }),
      prisma.category.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          slug: true,
          color: true,
          _count: { select: { cases: { where: { isActive: true } } } },
        },
      }),
      prisma.$queryRaw`
        SELECT s."stageType" AS "stageType",
               ROUND(AVG(EXTRACT(EPOCH FROM (s."endedAt" - s."startedAt")) / 86400)::numeric, 1)::float AS "avgDays",
               ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (s."endedAt" - s."startedAt")) / 86400)::numeric, 1)::float AS "medianDays",
               COUNT(*)::int AS "count"
        FROM case_stages s
        JOIN cases c ON c.id = s."caseId"
        WHERE c."isActive" AND s."endedAt" IS NOT NULL AND s."endedAt" >= s."startedAt"
        GROUP BY s."stageType"`,
      prisma.caseStage.findMany({
        where: { status: 'AKTIF', case: { isActive: true, currentStatus: { not: 'PUTUSAN' } } },
        orderBy: { startedAt: 'asc' },
        take: 5,
        select: {
          stageType: true,
          startedAt: true,
          dueAt: true,
          case: { select: { slug: true, title: true, caseNumber: true } },
        },
      }),
      prisma.caseRevision.findMany({
        where: { case: { isActive: true } },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          id: true,
          action: true,
          summary: true,
          createdAt: true,
          case: { select: { slug: true, title: true, currentStatus: true } },
        },
      }),
      prisma.source.groupBy({ by: ['isVerified'], where: { case: { isActive: true } }, _count: { _all: true } }),
      prisma.follow.count(),
    ]);

  const byStatus = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  byStatusRaw.forEach((r) => {
    byStatus[r.currentStatus] = r._count._all;
  });
  const verifiedSources = sourceCounts.find((s) => s.isVerified)?._count._all ?? 0;
  const totalSources = sourceCounts.reduce((a, s) => a + s._count._all, 0);

  return ok(res, {
    totals: {
      cases: total,
      ongoing: total - byStatus.PUTUSAN,
      decided: byStatus.PUTUSAN,
      sources: totalSources,
      verifiedSources,
      followers,
    },
    byStatus,
    byCategory: byCategory.map(({ _count, ...c }) => ({ ...c, count: _count.cases })),
    stageDurations: STATUS_ORDER.map(
      (stageType) => durations.find((d) => d.stageType === stageType) ?? { stageType, avgDays: null, medianDays: null, count: 0 },
    ),
    longestActive: longestActive.map((s) => ({
      ...s,
      daysRunning: Math.floor((Date.now() - s.startedAt.getTime()) / 86400000),
    })),
    recentUpdates,
  });
});

module.exports = router;
