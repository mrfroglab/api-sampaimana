const prisma = require('./prisma');
const { notFound } = require('./http');
const { recordRevision } = require('./audit');
const { notifyFollowers } = require('./notify');
const { STATUS_LABEL } = require('./labels');

const getCase = async (id, db = prisma) => {
  const found = await db.case.findUnique({ where: { id } });
  if (!found) throw notFound('Kasus tidak ditemukan.');
  return found;
};

/**
 * Keeps the case status consistent with its timeline: when a stage becomes
 * AKTIF, earlier active stages are closed and the case status follows it.
 * Returns the previous status if it changed.
 */
const syncActiveStage = async (tx, caseRow, stage, userId, reason) => {
  if (stage.status !== 'AKTIF') return null;
  await tx.caseStage.updateMany({
    where: { caseId: caseRow.id, status: 'AKTIF', id: { not: stage.id } },
    data: { status: 'SELESAI' },
  });
  await tx.caseStage.updateMany({
    where: { caseId: caseRow.id, status: 'SELESAI', endedAt: null, id: { not: stage.id }, startedAt: { lte: stage.startedAt } },
    data: { endedAt: stage.startedAt },
  });
  if (caseRow.currentStatus === stage.stageType) return null;
  await tx.case.update({ where: { id: caseRow.id }, data: { currentStatus: stage.stageType } });
  await recordRevision(tx, {
    caseId: caseRow.id,
    userId,
    action: 'STATUS_CHANGED',
    summary: `Status berubah dari ${STATUS_LABEL[caseRow.currentStatus]} ke ${STATUS_LABEL[stage.stageType]}`,
    reason,
    changes: { currentStatus: { from: caseRow.currentStatus, to: stage.stageType } },
  });
  return caseRow.currentStatus;
};

const touch = (tx, caseId) => tx.case.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } });

const createStageTx = async (tx, caseRow, data, userId) => {
  const stage = await tx.caseStage.create({
    data: {
      caseId: caseRow.id,
      stageType: data.stageType,
      status: data.status,
      title: data.title,
      summary: data.summary,
      startedAt: data.startedAt ?? new Date(),
      endedAt: data.endedAt ?? null,
      dueAt: data.dueAt ?? null,
      createdById: userId,
    },
  });
  await recordRevision(tx, {
    caseId: caseRow.id,
    userId,
    action: 'STAGE_ADDED',
    summary: `Tahapan ${STATUS_LABEL[stage.stageType]} ditambahkan${stage.title ? `: ${stage.title}` : ''}`,
    reason: data.reason,
  });
  const previousStatus = await syncActiveStage(tx, caseRow, stage, userId, data.reason);
  await touch(tx, caseRow.id);
  return { stage, previousStatus };
};

const announceStage = (caseRow, stage, previousStatus, userId) => {
  if (previousStatus) {
    notifyFollowers(caseRow, {
      type: 'STATUS_CHANGE',
      title: `${caseRow.title} kini memasuki tahap ${STATUS_LABEL[stage.stageType]}`,
      body: `Status kasus berubah dari ${STATUS_LABEL[previousStatus]} ke ${STATUS_LABEL[stage.stageType]}${stage.title ? `: ${stage.title}` : ''}.`,
      excludeUserId: userId,
    });
  } else {
    notifyFollowers(caseRow, {
      type: 'STAGE_UPDATE',
      title: `Pembaruan: ${caseRow.title}`,
      body: `Tahapan ${STATUS_LABEL[stage.stageType]} diperbarui${stage.title ? `: ${stage.title}` : ''}.`,
      excludeUserId: userId,
    });
  }
};

module.exports = { getCase, syncActiveStage, touch, createStageTx, announceStage };
