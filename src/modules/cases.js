const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { ok, created, parse, notFound, pagination, pageMeta } = require('../lib/http');
const { isUuid } = require('../lib/slug');
const { STATUS_ORDER, STATUS_LABEL } = require('../lib/labels');
const { authenticate, optionalAuth } = require('../middlewares/auth');
const { writeLimiter } = require('../middlewares/rateLimit');

const router = express.Router();

const statusEnum = z.enum(STATUS_ORDER);

const listSchema = pagination.extend({
  q: z.string().trim().max(120).optional(),
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : []))
    .pipe(z.array(statusEnum)),
  category: z.string().trim().max(80).optional(),
  sort: z.enum(['updated', 'newest', 'oldest', 'title']).default('updated'),
});

const SORTS = {
  updated: [{ lastActivityAt: 'desc' }],
  newest: [{ createdAt: 'desc' }],
  oldest: [{ filedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
  title: [{ title: 'asc' }],
};

const buildWhere = ({ q, status, category }) => {
  const where = { isActive: true };
  if (q) {
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { caseNumber: { contains: q, mode: 'insensitive' } },
      { summary: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
      { institution: { contains: q, mode: 'insensitive' } },
      { defendants: { some: { name: { contains: q, mode: 'insensitive' } } } },
    ];
  }
  if (status?.length) where.currentStatus = { in: status };
  if (category) where.category = { slug: category };
  return where;
};

const listInclude = {
  category: { select: { id: true, name: true, slug: true, color: true } },
  defendants: { select: { name: true, role: true }, orderBy: { createdAt: 'asc' } },
  stages: {
    where: { status: 'AKTIF' },
    orderBy: { startedAt: 'desc' },
    take: 1,
    select: { stageType: true, startedAt: true, dueAt: true, title: true },
  },
  _count: { select: { follows: true, sources: true, stages: true } },
};

const toListItem = ({ stages, _count, ...c }) => ({
  ...c,
  activeStage: stages[0] ?? null,
  followerCount: _count.follows,
  sourceCount: _count.sources,
  stageCount: _count.stages,
});

/** Finds an active case by slug or id. */
const findCaseKey = async (key, select = { id: true, slug: true, title: true }) => {
  const found = await prisma.case.findFirst({
    where: { isActive: true, ...(isUuid(key) ? { id: key } : { slug: key }) },
    select,
  });
  if (!found) throw notFound('Kasus tidak ditemukan.');
  return found;
};

router.get('/', async (req, res) => {
  const query = parse(listSchema, req.query);
  const where = buildWhere(query);
  const [total, cases] = await Promise.all([
    prisma.case.count({ where }),
    prisma.case.findMany({
      where,
      include: listInclude,
      orderBy: SORTS[query.sort],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
  ]);
  return ok(res, cases.map(toListItem), { meta: pageMeta(total, query.page, query.limit) });
});

/* ---------- Open data exports ---------- */

const csvCell = (value) => {
  if (value == null) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const exportRows = () =>
  prisma.case.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
    include: {
      category: { select: { name: true, slug: true } },
      defendants: { select: { name: true, role: true } },
      stages: {
        orderBy: { startedAt: 'asc' },
        select: { stageType: true, status: true, title: true, startedAt: true, endedAt: true, dueAt: true },
      },
      sources: {
        select: { title: true, url: true, publisher: true, type: true, isVerified: true, publishedAt: true },
      },
    },
  });

router.get('/export.csv', async (req, res) => {
  const rows = await exportRows();
  const header = [
    'slug', 'nomor_perkara', 'judul', 'kategori', 'status', 'lembaga', 'pengadilan', 'wilayah',
    'tanggal_mulai', 'pihak', 'jumlah_tahapan', 'jumlah_sumber', 'pembaruan_terakhir',
  ];
  const lines = rows.map((c) =>
    [
      c.slug, c.caseNumber, c.title, c.category.name, STATUS_LABEL[c.currentStatus], c.institution, c.court, c.region,
      c.filedAt, c.defendants.map((d) => `${d.name} (${d.role})`).join('; '), c.stages.length, c.sources.length,
      c.lastActivityAt,
    ]
      .map(csvCell)
      .join(','),
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sampaimana-kasus.csv"');
  return res.send(`﻿${header.join(',')}\n${lines.join('\n')}\n`);
});

router.get('/export.json', async (req, res) => {
  const rows = await exportRows();
  res.setHeader('Content-Disposition', 'attachment; filename="sampaimana-kasus.json"');
  return res.json({
    generatedAt: new Date().toISOString(),
    license: 'CC BY 4.0 — cantumkan Sampai Mana sebagai sumber',
    count: rows.length,
    cases: rows.map(({ id, categoryId, isActive, ...c }) => c),
  });
});

/* ---------- Detail ---------- */

router.get('/:key', optionalAuth, async (req, res) => {
  const { id } = await findCaseKey(req.params.key);
  const [detail, following] = await Promise.all([
    prisma.case.findUnique({
      where: { id },
      include: {
        category: true,
        defendants: { orderBy: { createdAt: 'asc' } },
        stages: {
          orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }],
          include: {
            article: { select: { id: true, title: true, publishedAt: true, updatedAt: true } },
            sources: { orderBy: { createdAt: 'asc' } },
          },
        },
        sources: { where: { stageId: null }, orderBy: { createdAt: 'asc' } },
        revisions: {
          orderBy: { createdAt: 'desc' },
          take: 30,
          select: { id: true, action: true, summary: true, reason: true, createdAt: true, user: { select: { name: true } } },
        },
        _count: { select: { follows: true } },
      },
    }),
    req.user
      ? prisma.follow.findUnique({ where: { userId_caseId: { userId: req.user.id, caseId: id } } })
      : null,
  ]);
  const { _count, categoryId, isActive, ...rest } = detail;
  return ok(res, { ...rest, followerCount: _count.follows, following: Boolean(following) });
});

router.get('/:key/revisions', async (req, res) => {
  const { id } = await findCaseKey(req.params.key);
  const { page, limit } = parse(pagination, req.query);
  const where = { caseId: id };
  const [total, revisions] = await Promise.all([
    prisma.caseRevision.count({ where }),
    prisma.caseRevision.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: { id: true, action: true, summary: true, reason: true, changes: true, createdAt: true, user: { select: { name: true } } },
    }),
  ]);
  return ok(res, revisions, { meta: pageMeta(total, page, limit) });
});

router.get('/:key/stages/:stageId', async (req, res) => {
  const { id } = await findCaseKey(req.params.key);
  const stage = await prisma.caseStage.findFirst({
    where: { id: req.params.stageId, caseId: id },
    include: {
      article: { include: { author: { select: { name: true } } } },
      sources: { orderBy: { createdAt: 'asc' } },
      case: { select: { title: true, slug: true, caseNumber: true } },
    },
  });
  if (!stage) throw notFound('Tahapan tidak ditemukan.');
  return ok(res, stage);
});

/* ---------- Follow ---------- */

router.post('/:key/follow', authenticate, async (req, res) => {
  const { id } = await findCaseKey(req.params.key);
  await prisma.follow.upsert({
    where: { userId_caseId: { userId: req.user.id, caseId: id } },
    create: { userId: req.user.id, caseId: id },
    update: {},
  });
  const followerCount = await prisma.follow.count({ where: { caseId: id } });
  return ok(res, { following: true, followerCount });
});

router.delete('/:key/follow', authenticate, async (req, res) => {
  const { id } = await findCaseKey(req.params.key);
  await prisma.follow.deleteMany({ where: { userId: req.user.id, caseId: id } });
  const followerCount = await prisma.follow.count({ where: { caseId: id } });
  return ok(res, { following: false, followerCount });
});

/* ---------- Hak jawab / koreksi ---------- */

const correctionSchema = z.object({
  name: z.string().trim().min(2, 'Nama minimal 2 karakter.').max(100),
  email: z.string().trim().toLowerCase().email('Format email tidak valid.').max(160),
  relation: z.enum(['PIHAK_TERKAIT', 'KUASA_HUKUM', 'JURNALIS', 'PUBLIK'], {
    error: 'Pilih hubungan Anda dengan kasus.',
  }),
  message: z.string().trim().min(20, 'Uraikan koreksi minimal 20 karakter.').max(5000),
  // Honeypot: must stay empty.
  website: z.string().max(0).optional(),
});

router.post('/:key/corrections', writeLimiter, async (req, res) => {
  const { id } = await findCaseKey(req.params.key);
  const { website, ...data } = parse(correctionSchema, req.body);
  const correction = await prisma.correctionRequest.create({ data: { ...data, caseId: id } });
  return created(
    res,
    { id: correction.id, status: correction.status },
    'Permintaan koreksi diterima. Redaksi akan meninjau dalam 3×24 jam.',
  );
});

module.exports = router;
module.exports.findCaseKey = findCaseKey;
