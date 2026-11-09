const express = require('express');
const fs = require('fs/promises');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { ok, created, parse, badRequest, HttpError, pagination, pageMeta } = require('../lib/http');
const { STATUS_ORDER } = require('../lib/labels');
const { authenticate } = require('../middlewares/auth');
const { writeLimiter } = require('../middlewares/rateLimit');
const { proofUpload, resolveStored } = require('../middlewares/upload');
const { findCaseKey } = require('./cases');

const router = express.Router();
router.use(authenticate);

/* ---------- Follows & notifications ---------- */

router.get('/follows', async (req, res) => {
  const follows = await prisma.follow.findMany({
    where: { userId: req.user.id, case: { isActive: true } },
    orderBy: { case: { lastActivityAt: 'desc' } },
    select: {
      createdAt: true,
      case: {
        select: {
          id: true,
          slug: true,
          title: true,
          caseNumber: true,
          currentStatus: true,
          lastActivityAt: true,
          category: { select: { name: true, color: true, slug: true } },
        },
      },
    },
  });
  return ok(res, follows.map((f) => ({ ...f.case, followedAt: f.createdAt })));
});

router.get('/notifications', async (req, res) => {
  const { page, limit } = parse(pagination, req.query);
  const where = { userId: req.user.id };
  const [total, unread, items] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { ...where, readAt: null } }),
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
  ]);
  return ok(res, items, { meta: { ...pageMeta(total, page, limit), unread } });
});

router.post('/notifications/read', async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).max(100).optional() }), req.body);
  const result = await prisma.notification.updateMany({
    where: { userId: req.user.id, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
    data: { readAt: new Date() },
  });
  return ok(res, { updated: result.count });
});

/* ---------- Contributions ---------- */

const MAX_PENDING = 5;
const MAX_PENDING_NEW_ACCOUNT = 1;
const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;

const linksField = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v == null || v === '') return [];
    if (Array.isArray(v)) return v;
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [v];
    } catch {
      return [v];
    }
  })
  .pipe(
    z
      .array(
        z
          .string()
          .trim()
          .url('Tautan bukti harus berupa URL lengkap.')
          .refine((u) => /^https?:\/\//i.test(u), 'Tautan harus http(s).'),
      )
      .max(10, 'Maksimal 10 tautan.'),
  );

const contributionSchema = z.object({
  caseId: z.string().min(1, 'Pilih kasus.'),
  description: z.string().trim().min(30, 'Uraikan perkembangan minimal 30 karakter.').max(5000),
  proposedStage: z.preprocess((v) => (v === '' ? undefined : v), z.enum(STATUS_ORDER).optional()),
  proofLinks: linksField,
});

const removeStored = (files) =>
  Promise.all((files || []).map((f) => fs.rm(resolveStored(f.key), { force: true }).catch(() => {})));

router.post('/contributions', writeLimiter, proofUpload, async (req, res) => {
  try {
    const data = parse(contributionSchema, req.body);
    const target = await findCaseKey(data.caseId);
    const files = req.storedFiles || [];

    if (data.proofLinks.length === 0 && files.length === 0) {
      throw badRequest('Sertakan minimal satu bukti: tautan sumber atau file.');
    }

    const pending = await prisma.caseContribution.count({ where: { userId: req.user.id, status: 'PENDING' } });
    const isNew = Date.now() - new Date(req.user.createdAt).getTime() < NEW_ACCOUNT_MS;
    const cap = isNew ? MAX_PENDING_NEW_ACCOUNT : MAX_PENDING;
    if (pending >= cap) {
      throw new HttpError(
        429,
        isNew
          ? 'Akun baru dapat memiliki 1 kontribusi menunggu moderasi. Tunggu hingga ditinjau.'
          : `Anda sudah memiliki ${MAX_PENDING} kontribusi yang menunggu moderasi.`,
      );
    }

    const contribution = await prisma.caseContribution.create({
      data: {
        caseId: target.id,
        userId: req.user.id,
        description: data.description,
        proposedStage: data.proposedStage ?? null,
        proofLinks: data.proofLinks,
        proofFiles: files,
      },
    });
    return created(res, contribution, 'Kontribusi terkirim dan menunggu moderasi.');
  } catch (err) {
    await removeStored(req.storedFiles);
    throw err;
  }
});

router.get('/contributions', async (req, res) => {
  const [items, grouped] = await Promise.all([
    prisma.caseContribution.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { case: { select: { title: true, slug: true, caseNumber: true } } },
    }),
    prisma.caseContribution.groupBy({ by: ['status'], where: { userId: req.user.id }, _count: { _all: true } }),
  ]);
  const counts = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
  grouped.forEach((g) => {
    counts[g.status] = g._count._all;
  });
  const reviewed = counts.APPROVED + counts.REJECTED;
  return ok(
    res,
    items.map(({ proofFiles, ...c }) => ({
      ...c,
      proofFiles: (proofFiles || []).map(({ fileName, mimeType, size }) => ({ fileName, mimeType, size })),
    })),
    { stats: { ...counts, acceptanceRate: reviewed ? Math.round((counts.APPROVED / reviewed) * 100) : null } },
  );
});

module.exports = router;
