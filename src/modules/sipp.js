/**
 * Semi-automatic SIPP import. Mounted inside the admin router (so STAFF auth already
 * ran); everything here needs an editor. Nothing is fetched from SIPP: the editor
 * pastes the page and we parse it.
 */
const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { ok, parse, notFound, badRequest } = require('../lib/http');
const { audit, recordRevision } = require('../lib/audit');
const { createStageTx, announceStage, getCase } = require('../lib/stages');
const { parseSipp, proposeStages } = require('../lib/sipp');
const { authorize, EDITORS } = require('../middlewares/auth');
const { writeLimiter } = require('../middlewares/rateLimit');

const router = express.Router();
const guard = [authorize(...EDITORS), writeLimiter];

const MAX_INPUT = 2 * 1024 * 1024;
const input = z.string({ error: 'Tempel isi halaman SIPP.' }).min(1, 'Tempel isi halaman SIPP.').max(MAX_INPUT, 'Teks maksimal 2 MB.');

const previewSchema = z.object({ input });
const applySchema = z.object({
  input,
  keys: z.array(z.string().trim().min(1).max(64)).max(50),
  sippUrl: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .trim()
      .max(500)
      .url('Tautan SIPP tidak valid.')
      .refine((u) => /^https?:\/\//i.test(u), 'Tautan SIPP harus http(s).')
      .optional(),
  ),
});

const loadExisting = (caseId, db = prisma) =>
  db.caseStage.findMany({ where: { caseId }, select: { stageType: true, status: true, startedAt: true, dueAt: true } });

router.post('/cases/:id/sipp/preview', ...guard, async (req, res) => {
  const { input: text } = parse(previewSchema, req.body);
  const caseRow = await getCase(req.params.id);
  const parsed = parseSipp(text);
  const proposals = proposeStages(parsed, await loadExisting(caseRow.id));
  return ok(res, { parsed, proposals, warnings: parsed.warnings });
});

router.post('/cases/:id/sipp/apply', ...guard, async (req, res) => {
  const { input: text, keys, sippUrl } = parse(applySchema, req.body);
  const initial = await getCase(req.params.id);

  const result = await prisma.$transaction(async (tx) => {
    // Re-parse on the server and compare against what is stored *now*, so stale
    // previews cannot create duplicates.
    const parsed = parseSipp(text);
    const proposals = proposeStages(parsed, await loadExisting(initial.id, tx));
    const wanted = [...new Set(keys)];
    const unknown = wanted.filter((k) => !proposals.some((p) => p.key === k));
    if (unknown.length) {
      throw badRequest('Sebagian usulan sudah tidak berlaku (mungkin sudah diimpor). Muat ulang pratinjau.', { keys: unknown });
    }
    const selected = proposals.filter((p) => wanted.includes(p.key));

    const created = [];
    let firstStatus = null;
    for (const p of selected) {
      const caseRow = await tx.case.findUnique({ where: { id: initial.id } });
      if (firstStatus === null) firstStatus = caseRow.currentStatus;
      const { stage } = await createStageTx(
        tx,
        caseRow,
        {
          stageType: p.stageType,
          status: p.status,
          title: p.title,
          summary: p.summary,
          startedAt: new Date(p.startedAt),
          dueAt: p.dueAt ? new Date(p.dueAt) : null,
          reason: 'Diimpor dari SIPP',
        },
        req.user.id,
      );
      created.push(stage);
    }

    const urlChanged = sippUrl !== undefined && sippUrl !== initial.sippUrl;
    if (urlChanged) await tx.case.update({ where: { id: initial.id }, data: { sippUrl } });
    if (created.length || urlChanged) {
      await recordRevision(tx, {
        caseId: initial.id,
        userId: req.user.id,
        action: 'SIPP_IMPORT',
        summary: created.length
          ? `Impor dari SIPP: ${created.length} tahapan ditambahkan${urlChanged ? ', tautan SIPP disimpan' : ''}`
          : 'Tautan SIPP disimpan',
        changes: { stages: created.map((s) => ({ id: s.id, stageType: s.stageType })), ...(urlChanged ? { sippUrl: { from: initial.sippUrl, to: sippUrl } } : {}) },
      });
    }
    const finalCase = await tx.case.findUnique({ where: { id: initial.id }, select: { id: true, slug: true, title: true, currentStatus: true } });
    return { created, finalCase, firstStatus };
  });

  const { created, finalCase, firstStatus } = result;
  if (created.length) {
    const last = created[created.length - 1];
    const changed = firstStatus && firstStatus !== finalCase.currentStatus ? firstStatus : null;
    announceStage({ id: finalCase.id, slug: finalCase.slug, title: finalCase.title }, last, changed, req.user.id);
  }
  audit(req, 'SIPP_IMPORT', 'Case', initial.id, { created: created.length, keys });
  const { title, ...caseOut } = finalCase;
  return ok(res, { created, case: caseOut }, { message: created.length ? `${created.length} tahapan diimpor dari SIPP.` : 'Tidak ada tahapan yang diimpor.' });
});

module.exports = router;
