const express = require('express');
const fs = require('fs');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { ok, created, parse, notFound, badRequest, conflict, forbidden, pagination, pageMeta } = require('../lib/http');
const { uniqueSlug } = require('../lib/slug');
const { audit, recordRevision } = require('../lib/audit');
const { notifyFollowers, notifyUser } = require('../lib/notify');
const { getCase, createStageTx, announceStage, touch } = require('../lib/stages');
const { slugify } = require('../lib/slug');
const { loadAttention } = require('../lib/attention');
const { clearInsightsCache } = require('../lib/cache');
const { revokeAllForUser } = require('../lib/tokens');
const { STATUS_ORDER, STATUS_LABEL, STAGE_STATUS_LABEL } = require('../lib/labels');
const { authenticate, authorize, STAFF, EDITORS } = require('../middlewares/auth');
const { resolveStored } = require('../middlewares/upload');

const router = express.Router();
router.use(authenticate, authorize(...STAFF));
const canEdit = authorize(...EDITORS);
const superOnly = authorize('SUPER_ADMIN');

// Public aggregates (trends) are cached for minutes; drop them after any successful admin write.
router.use((req, res, next) => {
  if (req.method !== 'GET') res.on('finish', () => res.statusCode < 400 && clearInsightsCache());
  next();
});

/* ---------- shared schemas ---------- */

const blankToUndef = (v) => (v === '' || v === null ? undefined : v);
const optionalDate = z.preprocess(blankToUndef, z.coerce.date().optional());
const nullableDate = z.preprocess((v) => (v === '' ? null : v), z.coerce.date().nullable().optional());
const optionalText = (max) => z.preprocess(blankToUndef, z.string().trim().max(max).optional());
const statusEnum = z.enum(STATUS_ORDER);
const stageStatusEnum = z.enum(['PENDING', 'AKTIF', 'SELESAI']);
const sourceTypeEnum = z.enum(['OFFICIAL', 'COURT', 'MEDIA', 'OTHER']);

const defendantSchema = z.object({
  name: z.string().trim().min(2, 'Nama pihak minimal 2 karakter.').max(120),
  role: z.string().trim().min(2, 'Peran pihak wajib diisi.').max(160),
  description: optionalText(1000),
});

const sippUrlSchema = z.preprocess(
  (v) => (v === '' ? null : v),
  z
    .string()
    .trim()
    .max(500)
    .url('Tautan SIPP tidak valid.')
    .refine((u) => /^https?:\/\//i.test(u), 'Tautan SIPP harus http(s).')
    .nullable()
    .optional(),
);

/** Defendants are stored with a slug (same person may appear in several cases). */
const withSlugs = (defendants) => defendants.map((d) => ({ ...d, slug: slugify(d.name) || 'pihak' }));

const caseSchema = z.object({
  caseNumber: z.string().trim().min(1, 'Nomor perkara wajib diisi.').max(120),
  title: z.string().trim().min(5, 'Judul minimal 5 karakter.').max(200),
  summary: optionalText(280),
  description: z.string().trim().min(20, 'Deskripsi minimal 20 karakter.').max(20000),
  categoryId: z.string().uuid('Pilih kategori.'),
  currentStatus: statusEnum.default('PELAPORAN'),
  institution: optionalText(120),
  court: optionalText(160),
  region: optionalText(120),
  sippUrl: sippUrlSchema,
  filedAt: optionalDate,
  defendants: z.array(defendantSchema).max(50).default([]),
  reason: optionalText(1000),
});

const stageSchema = z.object({
  stageType: statusEnum,
  status: stageStatusEnum.default('AKTIF'),
  title: optionalText(200),
  summary: optionalText(5000),
  startedAt: optionalDate,
  endedAt: nullableDate,
  dueAt: nullableDate,
  reason: optionalText(1000),
});

const sourceSchema = z.object({
  title: z.string().trim().min(3, 'Judul sumber minimal 3 karakter.').max(300),
  url: z
    .string()
    .trim()
    .url('URL sumber tidak valid.')
    .refine((u) => /^https?:\/\//i.test(u), 'URL harus http(s).'),
  publisher: optionalText(160),
  type: sourceTypeEnum.default('MEDIA'),
  publishedAt: optionalDate,
  stageId: z.preprocess(blankToUndef, z.string().uuid().optional()),
  isVerified: z.boolean().default(false),
});

const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

/* ---------- overview ---------- */

router.get('/overview', async (req, res) => {
  const [pendingContributions, oldestPending, openCorrections, oldestCorrection, cases, inactive, users, overdue] =
    await Promise.all([
      prisma.caseContribution.count({ where: { status: 'PENDING' } }),
      prisma.caseContribution.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      prisma.correctionRequest.count({ where: { status: 'OPEN' } }),
      prisma.correctionRequest.findFirst({ where: { status: 'OPEN' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      prisma.case.count({ where: { isActive: true } }),
      prisma.case.count({ where: { isActive: false } }),
      prisma.user.count(),
      prisma.caseStage.findMany({
        where: { status: 'AKTIF', dueAt: { lt: new Date() }, case: { isActive: true } },
        orderBy: { dueAt: 'asc' },
        take: 10,
        select: { id: true, stageType: true, dueAt: true, case: { select: { id: true, title: true, slug: true } } },
      }),
    ]);
  const ageHours = (d) => (d ? Math.floor((Date.now() - d.createdAt.getTime()) / 3600000) : null);
  return ok(res, {
    pendingContributions,
    oldestPendingHours: ageHours(oldestPending),
    openCorrections,
    oldestCorrectionHours: ageHours(oldestCorrection),
    cases,
    inactiveCases: inactive,
    users,
    overdueStages: overdue,
  });
});

/* ---------- editorial attention ---------- */

router.get('/attention', async (req, res) => ok(res, await loadAttention(prisma)));

/* ---------- cases ---------- */

const adminListSchema = pagination.extend({
  q: z.string().trim().max(120).optional(),
  status: z.preprocess(blankToUndef, statusEnum.optional()),
  state: z.enum(['active', 'inactive', 'all']).default('active'),
  // `check` = only cases that need an editor's attention (stage past its due date, or no update for STALE_DAYS).
  attention: z.preprocess(blankToUndef, z.enum(['check']).optional()),
});

/** caseId -> { reason: 'OVERDUE' | 'STALE' | 'DUE_SOON', days } (most urgent reason wins). */
const attentionIndex = async () => {
  const a = await loadAttention(prisma);
  const index = new Map();
  [['DUE_SOON', a.dueSoon], ['STALE', a.stale], ['OVERDUE', a.overdue]].forEach(([reason, list]) =>
    list.forEach((i) => index.set(i.case.id, { reason, days: i.days })),
  );
  return index;
};

router.get('/cases', async (req, res) => {
  const query = parse(adminListSchema, req.query);
  const attention = await attentionIndex();
  const where = {};
  if (query.attention === 'check') {
    where.id = { in: [...attention].filter(([, v]) => v.reason !== 'DUE_SOON').map(([id]) => id) };
  }
  if (query.state !== 'all') where.isActive = query.state === 'active';
  if (query.status) where.currentStatus = query.status;
  if (query.q) {
    where.OR = [
      { title: { contains: query.q, mode: 'insensitive' } },
      { caseNumber: { contains: query.q, mode: 'insensitive' } },
    ];
  }
  const [total, items] = await Promise.all([
    prisma.case.count({ where }),
    prisma.case.findMany({
      where,
      orderBy: { lastActivityAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: {
        category: { select: { name: true, color: true } },
        _count: { select: { stages: true, sources: true, follows: true } },
        contributions: { where: { status: 'PENDING' }, select: { id: true } },
        corrections: { where: { status: 'OPEN' }, select: { id: true } },
      },
    }),
  ]);
  return ok(
    res,
    items.map(({ contributions, corrections, ...c }) => ({
      ...c,
      pendingContributions: contributions.length,
      openCorrections: corrections.length,
      attention: attention.get(c.id)?.reason ?? null,
      attentionDays: attention.get(c.id)?.days ?? null,
    })),
    { meta: pageMeta(total, query.page, query.limit) },
  );
});

router.get('/cases/:id', async (req, res) => {
  const found = await prisma.case.findUnique({
    where: { id: req.params.id },
    include: {
      category: true,
      defendants: { orderBy: { createdAt: 'asc' } },
      stages: {
        orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }],
        include: { article: true, sources: { orderBy: { createdAt: 'asc' } } },
      },
      sources: { orderBy: { createdAt: 'asc' }, include: { verifiedBy: { select: { name: true } } } },
      revisions: { orderBy: { createdAt: 'desc' }, take: 50, include: { user: { select: { name: true } } } },
      _count: { select: { follows: true } },
    },
  });
  if (!found) throw notFound('Kasus tidak ditemukan.');
  return ok(res, found);
});

router.post('/cases', canEdit, async (req, res) => {
  const { defendants, reason, ...data } = parse(caseSchema, req.body);
  const slug = await uniqueSlug(prisma.case, data.title);
  const result = await prisma.$transaction(async (tx) => {
    const caseRow = await tx.case.create({ data: { ...data, slug, defendants: { create: withSlugs(defendants) } } });
    await tx.caseStage.create({
      data: {
        caseId: caseRow.id,
        stageType: data.currentStatus,
        status: 'AKTIF',
        startedAt: data.filedAt ?? new Date(),
        createdById: req.user.id,
      },
    });
    await recordRevision(tx, {
      caseId: caseRow.id,
      userId: req.user.id,
      action: 'CASE_CREATED',
      summary: `Kasus mulai dipantau pada tahap ${STATUS_LABEL[data.currentStatus]}`,
      reason,
    });
    return caseRow;
  });
  audit(req, 'CREATE_CASE', 'Case', result.id, { title: result.title });
  return created(res, result, 'Kasus dibuat.');
});

const TRACKED_FIELDS = ['caseNumber', 'title', 'summary', 'description', 'categoryId', 'currentStatus', 'institution', 'court', 'region', 'sippUrl', 'filedAt'];
const FIELD_LABEL = {
  caseNumber: 'nomor perkara',
  title: 'judul',
  summary: 'ringkasan',
  description: 'deskripsi',
  categoryId: 'kategori',
  currentStatus: 'status',
  institution: 'lembaga',
  court: 'pengadilan',
  region: 'wilayah',
  sippUrl: 'tautan SIPP',
  filedAt: 'tanggal mulai',
  defendants: 'pihak terkait',
};

router.put('/cases/:id', canEdit, async (req, res) => {
  const existing = await prisma.case.findUnique({ where: { id: req.params.id }, include: { defendants: true } });
  if (!existing) throw notFound('Kasus tidak ditemukan.');
  const { defendants, reason, ...data } = parse(caseSchema, req.body);

  const statusChanged = data.currentStatus !== existing.currentStatus;
  if (statusChanged && !reason) {
    throw badRequest('Perubahan status wajib disertai alasan (akan tampil di riwayat publik).');
  }

  const norm = (v) => (v instanceof Date ? v.toISOString() : (v ?? null));
  // sippUrl left out of the payload means "keep"; an explicit null/'' clears it.
  const changed = TRACKED_FIELDS.filter((f) => !(f === 'sippUrl' && data.sippUrl === undefined) && norm(data[f]) !== norm(existing[f]));
  const defendantKey = (list) => JSON.stringify(list.map((d) => [d.name, d.role, d.description ?? null]));
  const defendantsChanged = defendantKey(defendants) !== defendantKey(existing.defendants);
  if (defendantsChanged) changed.push('defendants');

  const slug = data.title !== existing.title ? await uniqueSlug(prisma.case, data.title, existing.id) : existing.slug;

  const updated = await prisma.$transaction(async (tx) => {
    if (defendantsChanged) await tx.defendant.deleteMany({ where: { caseId: existing.id } });
    const row = await tx.case.update({
      where: { id: existing.id },
      data: {
        ...data,
        slug,
        filedAt: data.filedAt ?? null,
        lastActivityAt: changed.length ? new Date() : existing.lastActivityAt,
        ...(defendantsChanged ? { defendants: { create: withSlugs(defendants) } } : {}),
      },
      include: { defendants: true, category: true },
    });
    if (statusChanged) {
      await recordRevision(tx, {
        caseId: existing.id,
        userId: req.user.id,
        action: 'STATUS_CHANGED',
        summary: `Status berubah dari ${STATUS_LABEL[existing.currentStatus]} ke ${STATUS_LABEL[data.currentStatus]}`,
        reason,
        changes: { currentStatus: { from: existing.currentStatus, to: data.currentStatus } },
      });
    }
    const otherChanges = changed.filter((f) => f !== 'currentStatus');
    if (otherChanges.length) {
      await recordRevision(tx, {
        caseId: existing.id,
        userId: req.user.id,
        action: 'CASE_UPDATED',
        summary: `Memperbarui ${otherChanges.map((f) => FIELD_LABEL[f]).join(', ')}`,
        reason,
        changes: Object.fromEntries(
          otherChanges
            .filter((f) => !['description', 'defendants'].includes(f))
            .map((f) => [f, { from: norm(existing[f]), to: norm(data[f]) }]),
        ),
      });
    }
    return row;
  });

  if (statusChanged) {
    notifyFollowers(updated, {
      type: 'STATUS_CHANGE',
      title: `${updated.title} kini memasuki tahap ${STATUS_LABEL[updated.currentStatus]}`,
      body: `Status berubah dari ${STATUS_LABEL[existing.currentStatus]} ke ${STATUS_LABEL[updated.currentStatus]}. Alasan: ${reason}`,
      excludeUserId: req.user.id,
    });
  }
  audit(req, 'UPDATE_CASE', 'Case', existing.id, { changed });
  return ok(res, updated, { message: changed.length ? 'Kasus diperbarui.' : 'Tidak ada perubahan.' });
});

router.delete('/cases/:id', canEdit, async (req, res) => {
  const { reason } = parse(z.object({ reason: optionalText(1000) }), req.body);
  await getCase(req.params.id);
  await prisma.case.update({ where: { id: req.params.id }, data: { isActive: false } });
  audit(req, 'ARCHIVE_CASE', 'Case', req.params.id, { reason });
  return ok(res, null, { message: 'Kasus diarsipkan dan tidak lagi tampil publik.' });
});

router.post('/cases/:id/restore', canEdit, async (req, res) => {
  await getCase(req.params.id);
  await prisma.case.update({ where: { id: req.params.id }, data: { isActive: true } });
  audit(req, 'RESTORE_CASE', 'Case', req.params.id);
  return ok(res, null, { message: 'Kasus dipulihkan.' });
});

/* ---------- SIPP import (editors only) ---------- */

router.use(require('./sipp'));

/* ---------- stages ---------- */

router.post('/cases/:id/stages', canEdit, async (req, res) => {
  const data = parse(stageSchema, req.body);
  const caseRow = await getCase(req.params.id);
  const { stage, previousStatus } = await prisma.$transaction((tx) => createStageTx(tx, caseRow, data, req.user.id));
  announceStage(caseRow, stage, previousStatus, req.user.id);
  audit(req, 'CREATE_STAGE', 'CaseStage', stage.id, { caseId: caseRow.id, stageType: stage.stageType });
  return created(res, stage, 'Tahapan ditambahkan.');
});

router.put('/stages/:id', canEdit, async (req, res) => {
  const data = parse(stageSchema, req.body);
  const existing = await prisma.caseStage.findUnique({ where: { id: req.params.id }, include: { case: true } });
  if (!existing) throw notFound('Tahapan tidak ditemukan.');

  const { stage, previousStatus } = await prisma.$transaction(async (tx) => {
    const row = await tx.caseStage.update({
      where: { id: existing.id },
      data: {
        stageType: data.stageType,
        status: data.status,
        title: data.title ?? null,
        summary: data.summary ?? null,
        startedAt: data.startedAt ?? existing.startedAt,
        endedAt: data.endedAt === undefined ? existing.endedAt : data.endedAt,
        dueAt: data.dueAt === undefined ? existing.dueAt : data.dueAt,
      },
    });
    const diffs = [];
    if (existing.status !== row.status) diffs.push(`status ${STAGE_STATUS_LABEL[existing.status]} → ${STAGE_STATUS_LABEL[row.status]}`);
    if (existing.stageType !== row.stageType) diffs.push(`jenis ${STATUS_LABEL[existing.stageType]} → ${STATUS_LABEL[row.stageType]}`);
    if (fmtDate(existing.startedAt) !== fmtDate(row.startedAt)) diffs.push(`mulai ${fmtDate(existing.startedAt)} → ${fmtDate(row.startedAt)}`);
    if (fmtDate(existing.endedAt) !== fmtDate(row.endedAt)) diffs.push(`selesai ${fmtDate(existing.endedAt)} → ${fmtDate(row.endedAt)}`);
    if (fmtDate(existing.dueAt) !== fmtDate(row.dueAt)) diffs.push(`tenggat ${fmtDate(existing.dueAt)} → ${fmtDate(row.dueAt)}`);
    if ((existing.title ?? '') !== (row.title ?? '') || (existing.summary ?? '') !== (row.summary ?? '')) diffs.push('keterangan');
    if (diffs.length) {
      await recordRevision(tx, {
        caseId: existing.caseId,
        userId: req.user.id,
        action: 'STAGE_UPDATED',
        summary: `Tahapan ${STATUS_LABEL[row.stageType]} diperbarui: ${diffs.join('; ')}`,
        reason: data.reason,
      });
    }
    const prev = existing.status === 'AKTIF' && row.status === 'AKTIF' && existing.stageType === row.stageType
      ? null
      : await syncActiveStage(tx, existing.case, row, req.user.id, data.reason);
    if (diffs.length) await touch(tx, existing.caseId);
    return { stage: row, previousStatus: prev };
  });

  if (previousStatus) announceStage(existing.case, stage, previousStatus, req.user.id);
  audit(req, 'UPDATE_STAGE', 'CaseStage', stage.id, { caseId: existing.caseId });
  return ok(res, stage, { message: 'Tahapan diperbarui.' });
});

router.delete('/stages/:id', canEdit, async (req, res) => {
  const { reason } = parse(z.object({ reason: optionalText(1000) }), req.body);
  const existing = await prisma.caseStage.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound('Tahapan tidak ditemukan.');
  const count = await prisma.caseStage.count({ where: { caseId: existing.caseId } });
  if (count <= 1) throw badRequest('Kasus harus memiliki minimal satu tahapan.');
  await prisma.$transaction(async (tx) => {
    await tx.caseStage.delete({ where: { id: existing.id } });
    await recordRevision(tx, {
      caseId: existing.caseId,
      userId: req.user.id,
      action: 'STAGE_REMOVED',
      summary: `Tahapan ${STATUS_LABEL[existing.stageType]} (${fmtDate(existing.startedAt)}) dihapus`,
      reason,
    });
  });
  audit(req, 'DELETE_STAGE', 'CaseStage', existing.id, { caseId: existing.caseId, reason });
  return ok(res, null, { message: 'Tahapan dihapus.' });
});

/* ---------- articles (one per stage) ---------- */

const articleSchema = z.object({
  title: z.string().trim().min(5, 'Judul minimal 5 karakter.').max(200),
  content: z.string().trim().min(50, 'Isi penjelasan minimal 50 karakter.').max(50000),
});

router.put('/stages/:id/article', canEdit, async (req, res) => {
  const data = parse(articleSchema, req.body);
  const stage = await prisma.caseStage.findUnique({ where: { id: req.params.id }, include: { article: true, case: true } });
  if (!stage) throw notFound('Tahapan tidak ditemukan.');
  const isNew = !stage.article;

  const article = await prisma.$transaction(async (tx) => {
    const row = isNew
      ? await tx.article.create({ data: { ...data, stageId: stage.id, authorId: req.user.id } })
      : await tx.article.update({ where: { id: stage.article.id }, data });
    await recordRevision(tx, {
      caseId: stage.caseId,
      userId: req.user.id,
      action: isNew ? 'ARTICLE_PUBLISHED' : 'ARTICLE_UPDATED',
      summary: `${isNew ? 'Penjelasan diterbitkan' : 'Penjelasan diperbarui'} untuk tahap ${STATUS_LABEL[stage.stageType]}: ${data.title}`,
    });
    await touch(tx, stage.caseId);
    return row;
  });

  if (isNew) {
    notifyFollowers(stage.case, {
      type: 'ARTICLE_PUBLISHED',
      title: `Penjelasan baru: ${data.title}`,
      body: `Redaksi menerbitkan penjelasan tahap ${STATUS_LABEL[stage.stageType]} untuk kasus ${stage.case.title}.`,
      excludeUserId: req.user.id,
    });
  }
  audit(req, isNew ? 'CREATE_ARTICLE' : 'UPDATE_ARTICLE', 'Article', article.id, { stageId: stage.id });
  return ok(res, article, { message: isNew ? 'Penjelasan diterbitkan.' : 'Penjelasan diperbarui.' });
});

router.delete('/stages/:id/article', canEdit, async (req, res) => {
  const stage = await prisma.caseStage.findUnique({ where: { id: req.params.id }, include: { article: true } });
  if (!stage?.article) throw notFound('Penjelasan tidak ditemukan.');
  await prisma.$transaction(async (tx) => {
    await tx.article.delete({ where: { id: stage.article.id } });
    await recordRevision(tx, {
      caseId: stage.caseId,
      userId: req.user.id,
      action: 'ARTICLE_REMOVED',
      summary: `Penjelasan tahap ${STATUS_LABEL[stage.stageType]} ditarik`,
    });
  });
  audit(req, 'DELETE_ARTICLE', 'Article', stage.article.id);
  return ok(res, null, { message: 'Penjelasan dihapus.' });
});

/* ---------- sources ---------- */

const assertStageInCase = async (stageId, caseId) => {
  if (!stageId) return;
  const stage = await prisma.caseStage.findFirst({ where: { id: stageId, caseId }, select: { id: true } });
  if (!stage) throw badRequest('Tahapan tidak ada pada kasus ini.');
};

router.post('/cases/:id/sources', canEdit, async (req, res) => {
  const data = parse(sourceSchema, req.body);
  const caseRow = await getCase(req.params.id);
  await assertStageInCase(data.stageId, caseRow.id);
  const source = await prisma.$transaction(async (tx) => {
    const row = await tx.source.create({
      data: {
        ...data,
        caseId: caseRow.id,
        ...(data.isVerified ? { verifiedById: req.user.id, verifiedAt: new Date() } : {}),
      },
    });
    await recordRevision(tx, {
      caseId: caseRow.id,
      userId: req.user.id,
      action: 'SOURCE_ADDED',
      summary: `Sumber ditambahkan: ${row.title}${row.publisher ? ` (${row.publisher})` : ''}`,
    });
    return row;
  });
  audit(req, 'CREATE_SOURCE', 'Source', source.id, { caseId: caseRow.id });
  return created(res, source, 'Sumber ditambahkan.');
});

router.patch('/sources/:id', canEdit, async (req, res) => {
  const data = parse(sourceSchema.partial(), req.body);
  const existing = await prisma.source.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound('Sumber tidak ditemukan.');
  if (data.stageId) await assertStageInCase(data.stageId, existing.caseId);
  const verifyChange =
    data.isVerified === undefined || data.isVerified === existing.isVerified
      ? {}
      : data.isVerified
        ? { verifiedById: req.user.id, verifiedAt: new Date() }
        : { verifiedById: null, verifiedAt: null };
  const source = await prisma.source.update({ where: { id: existing.id }, data: { ...data, ...verifyChange } });
  if (data.isVerified === true && !existing.isVerified) {
    await recordRevision(prisma, {
      caseId: existing.caseId,
      userId: req.user.id,
      action: 'SOURCE_VERIFIED',
      summary: `Sumber diverifikasi: ${source.title}`,
    });
  }
  audit(req, 'UPDATE_SOURCE', 'Source', source.id);
  return ok(res, source, { message: 'Sumber diperbarui.' });
});

router.delete('/sources/:id', canEdit, async (req, res) => {
  const existing = await prisma.source.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound('Sumber tidak ditemukan.');
  await prisma.$transaction(async (tx) => {
    await tx.source.delete({ where: { id: existing.id } });
    await recordRevision(tx, {
      caseId: existing.caseId,
      userId: req.user.id,
      action: 'SOURCE_REMOVED',
      summary: `Sumber dihapus: ${existing.title}`,
    });
  });
  audit(req, 'DELETE_SOURCE', 'Source', existing.id);
  return ok(res, null, { message: 'Sumber dihapus.' });
});

/* ---------- contributions moderation ---------- */

const reviewListSchema = pagination.extend({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING'),
});

router.get('/contributions', async (req, res) => {
  const { status, page, limit } = parse(reviewListSchema, req.query);
  const where = { status };
  const [total, items] = await Promise.all([
    prisma.caseContribution.count({ where }),
    prisma.caseContribution.findMany({
      where,
      orderBy: { createdAt: status === 'PENDING' ? 'asc' : 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        case: { select: { id: true, title: true, slug: true, caseNumber: true, currentStatus: true } },
        user: { select: { id: true, name: true, email: true, createdAt: true } },
        reviewedBy: { select: { name: true } },
      },
    }),
  ]);

  // Contributor track record helps moderators weigh a submission.
  const userIds = [...new Set(items.map((i) => i.userId))];
  const history = userIds.length
    ? await prisma.caseContribution.groupBy({
        by: ['userId', 'status'],
        where: { userId: { in: userIds } },
        _count: { _all: true },
      })
    : [];
  const reputation = (userId) => {
    const rows = history.filter((h) => h.userId === userId);
    const get = (s) => rows.find((r) => r.status === s)?._count._all ?? 0;
    const approved = get('APPROVED');
    const rejected = get('REJECTED');
    return { approved, rejected, pending: get('PENDING'), acceptanceRate: approved + rejected ? Math.round((approved / (approved + rejected)) * 100) : null };
  };

  return ok(
    res,
    items.map(({ proofFiles, ...c }) => ({
      ...c,
      proofFiles: (proofFiles || []).map(({ fileName, mimeType, size }, index) => ({ index, fileName, mimeType, size })),
      user: { ...c.user, reputation: reputation(c.userId) },
      waitingHours: Math.floor((Date.now() - c.createdAt.getTime()) / 3600000),
    })),
    { meta: pageMeta(total, page, limit) },
  );
});

router.get('/contributions/:id/files/:index', async (req, res) => {
  const contribution = await prisma.caseContribution.findUnique({ where: { id: req.params.id }, select: { proofFiles: true } });
  const file = contribution?.proofFiles?.[Number(req.params.index)];
  if (!file) throw notFound('File tidak ditemukan.');
  const full = resolveStored(file.key);
  if (!fs.existsSync(full)) throw notFound('File tidak lagi tersedia di penyimpanan.');
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.fileName)}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Length', fs.statSync(full).size);
  // Path is already confined to the upload root by resolveStored.
  return fs.createReadStream(full).pipe(res);
});

const reviewSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    rejectionReason: optionalText(2000),
    // Optional: turn the contribution into a timeline stage.
    apply: z
      .object({
        stageType: statusEnum,
        status: stageStatusEnum.default('AKTIF'),
        title: optionalText(200),
        summary: optionalText(5000),
        startedAt: optionalDate,
      })
      .optional(),
    // Copy the contributor's links into the case's source list.
    importLinks: z.boolean().default(false),
    verifyLinks: z.boolean().default(false),
  })
  .refine((v) => v.decision !== 'REJECTED' || v.rejectionReason, {
    message: 'Alasan penolakan wajib diisi agar kontributor bisa memperbaiki.',
    path: ['rejectionReason'],
  });

router.post('/contributions/:id/review', canEdit, async (req, res) => {
  const data = parse(reviewSchema, req.body);
  const contribution = await prisma.caseContribution.findUnique({ where: { id: req.params.id }, include: { case: true } });
  if (!contribution) throw notFound('Kontribusi tidak ditemukan.');

  const result = await prisma.$transaction(async (tx) => {
    // Claim atomically so two moderators cannot review the same item.
    const claim = await tx.caseContribution.updateMany({
      where: { id: contribution.id, status: 'PENDING' },
      data: {
        status: data.decision,
        reviewedById: req.user.id,
        reviewedAt: new Date(),
        rejectionReason: data.decision === 'REJECTED' ? data.rejectionReason : null,
      },
    });
    if (claim.count === 0) throw conflict('Kontribusi ini sudah dimoderasi.');
    if (data.decision === 'REJECTED') return { stage: null, previousStatus: null };

    let stage = null;
    let previousStatus = null;
    if (data.apply) {
      ({ stage, previousStatus } = await createStageTx(
        tx,
        contribution.case,
        { ...data.apply, reason: 'Berdasarkan kontribusi publik yang telah diverifikasi redaksi.' },
        req.user.id,
      ));
      await tx.caseContribution.update({ where: { id: contribution.id }, data: { appliedStageId: stage.id } });
    }
    const links = Array.isArray(contribution.proofLinks) ? contribution.proofLinks : [];
    if (data.importLinks && links.length) {
      await tx.source.createMany({
        data: links.map((url) => ({
          caseId: contribution.caseId,
          stageId: stage?.id ?? null,
          title: (() => {
            try {
              return new URL(url).hostname.replace(/^www\./, '');
            } catch {
              return url.slice(0, 120);
            }
          })(),
          url,
          type: 'MEDIA',
          isVerified: data.verifyLinks,
          ...(data.verifyLinks ? { verifiedById: req.user.id, verifiedAt: new Date() } : {}),
        })),
      });
    }
    await recordRevision(tx, {
      caseId: contribution.caseId,
      userId: req.user.id,
      action: 'CONTRIBUTION_APPLIED',
      summary: `Kontribusi publik diterima${stage ? ` dan ditambahkan sebagai tahap ${STATUS_LABEL[stage.stageType]}` : ''}`,
    });
    await touch(tx, contribution.caseId);
    return { stage, previousStatus };
  });

  if (result.stage) announceStage(contribution.case, result.stage, result.previousStatus, req.user.id);
  notifyUser(contribution.userId, {
    type: 'CONTRIBUTION_REVIEWED',
    caseId: contribution.caseId,
    link: data.decision === 'APPROVED' ? `/kasus/${contribution.case.slug}` : '/akun/kontribusi',
    title: data.decision === 'APPROVED' ? 'Kontribusi Anda diterima' : 'Kontribusi Anda belum dapat diterima',
    body:
      data.decision === 'APPROVED'
        ? `Terima kasih. Kontribusi untuk "${contribution.case.title}" telah diverifikasi redaksi.`
        : `Kontribusi untuk "${contribution.case.title}" ditolak: ${data.rejectionReason}`,
  });
  audit(req, `REVIEW_CONTRIBUTION_${data.decision}`, 'CaseContribution', contribution.id, {
    caseId: contribution.caseId,
    applied: Boolean(result.stage),
  });
  return ok(res, { id: contribution.id, status: data.decision, appliedStageId: result.stage?.id ?? null }, {
    message: data.decision === 'APPROVED' ? 'Kontribusi diterima.' : 'Kontribusi ditolak.',
  });
});

/* ---------- corrections (hak jawab) ---------- */

router.get('/corrections', async (req, res) => {
  const { status, page, limit } = parse(
    pagination.extend({ status: z.enum(['OPEN', 'RESOLVED', 'REJECTED']).default('OPEN') }),
    req.query,
  );
  const where = { status };
  const [total, items] = await Promise.all([
    prisma.correctionRequest.count({ where }),
    prisma.correctionRequest.findMany({
      where,
      orderBy: { createdAt: status === 'OPEN' ? 'asc' : 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { case: { select: { id: true, title: true, slug: true } }, handledBy: { select: { name: true } } },
    }),
  ]);
  return ok(res, items, { meta: pageMeta(total, page, limit) });
});

const resolveSchema = z.object({
  status: z.enum(['RESOLVED', 'REJECTED']),
  response: z.string().trim().min(5, 'Tulis tanggapan untuk catatan internal.').max(5000),
  publicNote: optionalText(2000),
});

router.post('/corrections/:id/resolve', canEdit, async (req, res) => {
  const data = parse(resolveSchema, req.body);
  const existing = await prisma.correctionRequest.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound('Permintaan koreksi tidak ditemukan.');
  if (existing.status !== 'OPEN') throw conflict('Permintaan ini sudah ditangani.');
  await prisma.$transaction(async (tx) => {
    await tx.correctionRequest.update({
      where: { id: existing.id },
      data: { status: data.status, response: data.response, handledById: req.user.id, handledAt: new Date() },
    });
    if (data.publicNote) {
      await recordRevision(tx, {
        caseId: existing.caseId,
        userId: req.user.id,
        action: 'CORRECTION',
        summary: 'Catatan koreksi / hak jawab',
        reason: data.publicNote,
      });
      await touch(tx, existing.caseId);
    }
  });
  audit(req, `CORRECTION_${data.status}`, 'CorrectionRequest', existing.id, { caseId: existing.caseId });
  return ok(res, null, { message: 'Permintaan koreksi ditangani.' });
});

/* ---------- categories ---------- */

const categorySchema = z.object({
  name: z.string().trim().min(3).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Warna harus format hex, mis. #b45309.').default('#57534e'),
  icon: z.string().trim().max(40).default('scale'),
});

router.post('/categories', canEdit, async (req, res) => {
  const data = parse(categorySchema, req.body);
  const slug = await uniqueSlug(prisma.category, data.name);
  const category = await prisma.category.create({ data: { ...data, slug } });
  audit(req, 'CREATE_CATEGORY', 'Category', category.id);
  return created(res, category, 'Kategori dibuat.');
});

router.patch('/categories/:id', canEdit, async (req, res) => {
  const data = parse(categorySchema.partial(), req.body);
  const category = await prisma.category.update({ where: { id: req.params.id }, data });
  audit(req, 'UPDATE_CATEGORY', 'Category', category.id);
  return ok(res, category, { message: 'Kategori diperbarui.' });
});

router.delete('/categories/:id', canEdit, async (req, res) => {
  const used = await prisma.case.count({ where: { categoryId: req.params.id } });
  if (used) throw conflict(`Kategori masih dipakai ${used} kasus.`);
  await prisma.category.delete({ where: { id: req.params.id } });
  audit(req, 'DELETE_CATEGORY', 'Category', req.params.id);
  return ok(res, null, { message: 'Kategori dihapus.' });
});

/* ---------- users (super admin) ---------- */

router.get('/users', superOnly, async (req, res) => {
  const { q, page, limit } = parse(pagination.extend({ q: z.string().trim().max(120).optional() }), req.query);
  const where = q
    ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] }
    : {};
  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: { id: true, name: true, email: true, role: true, bannedAt: true, createdAt: true, totpEnabledAt: true, lockedUntil: true },
    }),
  ]);
  const stats = users.length
    ? await prisma.caseContribution.groupBy({
        by: ['userId', 'status'],
        where: { userId: { in: users.map((u) => u.id) } },
        _count: { _all: true },
      })
    : [];
  return ok(
    res,
    users.map((u) => {
      const get = (s) => stats.find((r) => r.userId === u.id && r.status === s)?._count._all ?? 0;
      return { ...u, contributions: { approved: get('APPROVED'), rejected: get('REJECTED'), pending: get('PENDING') } };
    }),
    { meta: pageMeta(total, page, limit) },
  );
});

router.patch('/users/:id', superOnly, async (req, res) => {
  const data = parse(
    z.object({
      role: z.enum(['SUPER_ADMIN', 'EDITOR', 'VIEWER', 'CONTRIBUTOR']).optional(),
      banned: z.boolean().optional(),
      // For a user who lost their authenticator and recovery codes.
      reset2fa: z.literal(true).optional(),
      // Lifts a lock from repeated failed sign-ins.
      unlock: z.literal(true).optional(),
    }),
    req.body,
  );
  if (req.params.id === req.user.id) throw forbidden('Anda tidak dapat mengubah peran atau status akun sendiri.');
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) throw notFound('Pengguna tidak ditemukan.');
  const user = await prisma.user.update({
    where: { id: target.id },
    data: {
      ...(data.role ? { role: data.role } : {}),
      ...(data.banned === undefined ? {} : { bannedAt: data.banned ? new Date() : null }),
      ...(data.reset2fa ? { totpSecret: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: [] } : {}),
      ...(data.unlock ? { failedLogins: 0, lockedUntil: null } : {}),
    },
    select: { id: true, name: true, email: true, role: true, bannedAt: true, totpEnabledAt: true, lockedUntil: true },
  });
  if (data.banned || data.reset2fa || (data.role && data.role !== target.role)) await revokeAllForUser(target.id);
  audit(req, 'UPDATE_USER', 'User', target.id, data);
  return ok(res, user, { message: 'Pengguna diperbarui.' });
});

/* ---------- audit log ---------- */

router.get('/activity-logs', async (req, res) => {
  const { page, limit } = parse(pagination, req.query);
  const [total, logs] = await Promise.all([
    prisma.activityLog.count(),
    prisma.activityLog.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { user: { select: { name: true, role: true } } },
    }),
  ]);
  return ok(res, logs, { meta: pageMeta(total, page, limit) });
});

module.exports = router;
