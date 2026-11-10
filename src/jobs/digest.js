const prisma = require('../lib/prisma');
const env = require('../config/env');
const { sendMail } = require('../lib/mailer');
const { loadAttention, countsOf, isEmpty, describeDigest } = require('../lib/attention');

/**
 * Sends the editorial digest (overdue / due soon / stale) to every EDITOR and
 * SUPER_ADMIN as an in-app notification, plus an email when SMTP is configured.
 * Does nothing when there is nothing to report. Idempotency per day lives in the
 * scheduler, so this can be called directly (and tested) with any `now`.
 */
const runEditorialDigest = async (now = new Date(), { db = prisma, staleDays = env.STALE_DAYS } = {}) => {
  const attention = await loadAttention(db, now, staleDays);
  const counts = countsOf(attention);
  if (isEmpty(attention)) return { sent: 0, emailed: 0, skipped: true, counts };

  const recipients = await db.user.findMany({
    where: { role: { in: ['EDITOR', 'SUPER_ADMIN'] }, bannedAt: null },
    select: { id: true, email: true, emailNotifications: true },
  });
  if (!recipients.length) return { sent: 0, emailed: 0, skipped: true, counts };

  const { title, body } = describeDigest(attention, staleDays);
  await db.notification.createMany({
    data: recipients.map((u) => ({ userId: u.id, type: 'EDITORIAL_REMINDER', title, body, link: '/redaksi' })),
  });

  const emailRecipients = recipients.filter((u) => u.emailNotifications);
  const mailed = await Promise.all(
    emailRecipients
      .map((u) =>
        sendMail({
          to: u.email,
          subject: title,
          text: body,
          link: '/redaksi',
          linkLabel: 'Buka ruang redaksi',
          footer: 'Anda menerima email ini sebagai redaksi Sampai Mana. Matikan notifikasi email di halaman akun Anda.',
        }),
      ),
  );
  const emailed = mailed.filter(Boolean).length;
  if (!env.isTest) {
    // Always leave a trace; without SMTP this log line is the digest's only email-side output.
    console.log(
      `[pengingat-redaksi] ${title} | notifikasi aplikasi: ${recipients.length}, email: ${emailed}/${emailRecipients.length}` +
        `${emailRecipients.length && !emailed ? ' (SMTP belum diatur atau gagal)' : ''}`,
    );
  }
  return { sent: recipients.length, emailed, skipped: false, counts };
};

module.exports = { runEditorialDigest };
