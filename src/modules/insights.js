/** Public aggregate and SEO endpoints: trends, people, institutions, sitemap data. */
const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { ok, parse, notFound } = require('../lib/http');
const { slugify } = require('../lib/slug');
const { cached } = require('../lib/cache');
const { buildTrends, summarize, GROUP_BY } = require('../lib/durations');
const { listInclude, toListItem } = require('./cases');

const router = express.Router();

const TRENDS_TTL_MS = 5 * 60 * 1000;
const MAX_CASES = 100;

const trendsSchema = z.object({ groupBy: z.enum(GROUP_BY).default('institution') });

const durationRows = () =>
  prisma.case.findMany({
    where: { isActive: true },
    select: {
      institution: true,
      court: true,
      region: true,
      currentStatus: true,
      filedAt: true,
      category: { select: { name: true, slug: true } },
      stages: { select: { stageType: true, startedAt: true, endedAt: true } },
    },
  });

router.get('/stats/trends', async (req, res) => {
  const { groupBy } = parse(trendsSchema, req.query);
  const groups = await cached(`trends:${groupBy}`, TRENDS_TTL_MS, async () => buildTrends(await durationRows(), groupBy));
  return ok(res, { groupBy, groups });
});

/* ---------- institutions ---------- */

/** Distinct institution names of active cases, merged by slug: [{ name, slug, cases, names[] }]. */
const institutionIndex = async () => {
  const rows = await prisma.case.groupBy({
    by: ['institution'],
    where: { isActive: true, institution: { not: null } },
    _count: { _all: true },
  });
  const bySlug = new Map();
  rows.forEach((r) => {
    const name = r.institution?.trim();
    const slug = name ? slugify(name) : '';
    if (!slug) return;
    const entry = bySlug.get(slug) ?? { name, slug, cases: 0, names: [], best: 0 };
    entry.cases += r._count._all;
    entry.names.push(r.institution);
    if (r._count._all > entry.best) {
      entry.best = r._count._all;
      entry.name = name;
    }
    bySlug.set(slug, entry);
  });
  return [...bySlug.values()].sort((a, b) => b.cases - a.cases || a.name.localeCompare(b.name, 'id'));
};

router.get('/institutions', async (req, res) => {
  const list = await institutionIndex();
  return ok(res, list.map(({ name, slug, cases }) => ({ name, slug, cases })));
});

router.get('/institutions/:slug', async (req, res) => {
  const entry = (await institutionIndex()).find((i) => i.slug === req.params.slug);
  if (!entry) throw notFound('Lembaga tidak ditemukan.');
  const where = { isActive: true, institution: { in: entry.names } };
  const [cases, forStats] = await Promise.all([
    prisma.case.findMany({ where, include: listInclude, orderBy: { lastActivityAt: 'desc' }, take: MAX_CASES }),
    prisma.case.findMany({
      where,
      select: { currentStatus: true, filedAt: true, stages: { select: { stageType: true, startedAt: true, endedAt: true } } },
    }),
  ]);
  const { cases: total, decided, ongoing, medianDaysToDecision } = summarize(forStats);
  return ok(res, {
    name: entry.name,
    slug: entry.slug,
    stats: { cases: total, decided, ongoing, medianDaysToDecision },
    cases: cases.map(toListItem),
  });
});

/* ---------- people ---------- */

router.get('/people/:slug', async (req, res) => {
  const slug = slugify(req.params.slug) === req.params.slug ? req.params.slug : null;
  if (!slug) throw notFound('Pihak tidak ditemukan.');
  const where = { isActive: true, defendants: { some: { slug } } };
  const cases = await prisma.case.findMany({ where, include: listInclude, orderBy: { lastActivityAt: 'desc' }, take: MAX_CASES });
  if (!cases.length) throw notFound('Pihak tidak ditemukan.');

  const matches = cases.flatMap((c) => c.defendants.filter((d) => d.slug === slug));
  // Display name: the most common spelling; ties go to the properly capitalised one.
  const nameCount = new Map();
  matches.forEach((d) => {
    const clean = d.name.replace(/\s+/g, ' ').trim();
    nameCount.set(clean, (nameCount.get(clean) ?? 0) + 1);
  });
  const titleCased = (n) => n.split(' ').every((w) => /^[^a-z]/.test(w));
  const name = [...nameCount.entries()].sort((a, b) => b[1] - a[1] || titleCased(b[0]) - titleCased(a[0]) || a[0].localeCompare(b[0]))[0][0];
  const roles = [...new Set(matches.map((d) => d.role))];
  return ok(res, { name, slug, roles, cases: cases.map(toListItem) });
});

/* ---------- sitemap ---------- */

router.get('/sitemap-data', async (req, res) => {
  const [cases, people, institutions] = await Promise.all([
    prisma.case.findMany({ where: { isActive: true }, select: { slug: true, updatedAt: true }, orderBy: { updatedAt: 'desc' } }),
    prisma.defendant.findMany({ where: { case: { isActive: true } }, distinct: ['slug'], select: { slug: true }, orderBy: { slug: 'asc' } }),
    institutionIndex(),
  ]);
  return ok(res, {
    cases,
    people: people.filter((p) => p.slug),
    institutions: institutions.map(({ slug }) => ({ slug })),
  });
});

module.exports = router;
