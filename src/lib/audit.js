const prisma = require('./prisma');

const SENSITIVE = /pass|token|secret/i;

const scrub = (value, depth = 0) => {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? '[disembunyikan]' : scrub(v, depth + 1)]),
    );
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
};

/** Internal admin audit trail (not public). Best effort. */
const audit = (req, action, entity, entityId, metadata) =>
  prisma.activityLog
    .create({
      data: {
        userId: req.user?.id ?? null,
        action,
        entity,
        entityId: entityId ?? null,
        metadata: scrub({ ...metadata, ip: req.ip }),
      },
    })
    .catch((err) => console.error('Gagal menulis log aktivitas:', err.message));

/** Public revision history entry for a case. Pass a transaction client when inside one. */
const recordRevision = (db, { caseId, userId, action, summary, reason, changes }) =>
  db.caseRevision.create({
    data: { caseId, userId: userId ?? null, action, summary, reason: reason || null, changes: changes ?? undefined },
  });

module.exports = { audit, recordRevision, scrub };
