const prisma = require('../lib/prisma');
const env = require('../config/env');
const { jakartaDay, jakartaHour } = require('../lib/dates');
const { runEditorialDigest } = require('./digest');

const SEND_AFTER_HOUR = 7; // Asia/Jakarta
const TICK_MS = 10 * 60 * 1000;
const LOCK_KEYS = { 'editorial-digest': 7_301_001 };

/**
 * Runs `fn` at most once per (name, runDate) across all API instances:
 *  1. pg_try_advisory_lock so two instances never run the same job at the same moment
 *     (held on one pooled connection for the whole run, released in `finally`);
 *  2. a row in job_runs claims the day. If `fn` fails the claim is removed so the
 *     next tick retries.
 * Returns 'ran' | 'already-ran' | 'locked'.
 */
const runOncePerDay = async (name, runDate, fn, db = prisma) => {
  const lockKey = LOCK_KEYS[name] ?? 7_301_999;
  return db.$transaction(
    async (tx) => {
      const [{ locked }] = await tx.$queryRaw`SELECT pg_try_advisory_lock(${lockKey}::bigint) AS locked`;
      if (!locked) return 'locked';
      try {
        const claim = await tx.jobRun.createMany({ data: [{ name, runDate }], skipDuplicates: true });
        if (claim.count === 0) return 'already-ran';
        try {
          await fn();
        } catch (err) {
          await tx.jobRun.deleteMany({ where: { name, runDate } });
          throw err;
        }
        return 'ran';
      } finally {
        await tx.$queryRaw`SELECT pg_advisory_unlock(${lockKey}::bigint)`;
      }
    },
    { timeout: 5 * 60 * 1000, maxWait: 10_000 },
  );
};

/** One scheduler tick: sends the digest once per Jakarta day, after 07:00. */
const tick = async (now = new Date(), { db = prisma, digest = runEditorialDigest } = {}) => {
  if (jakartaHour(now) < SEND_AFTER_HOUR) return 'too-early';
  return runOncePerDay('editorial-digest', jakartaDay(now), () => digest(now), db);
};

let timer = null;

const startScheduler = () => {
  if (!env.REMINDERS_ENABLED || timer) return false;
  const safeTick = () =>
    tick().catch((err) => console.error('Pengingat redaksi gagal:', err.message));
  timer = setInterval(safeTick, TICK_MS);
  timer.unref();
  setTimeout(safeTick, 30_000).unref();
  console.log('Pengingat redaksi harian aktif (setelah 07:00 WIB).');
  return true;
};

const stopScheduler = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

module.exports = { startScheduler, stopScheduler, tick, runOncePerDay, SEND_AFTER_HOUR };
