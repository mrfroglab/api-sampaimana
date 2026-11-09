const prisma = require('./prisma');
const { sendMail } = require('./mailer');

/**
 * Notifies every follower of a case (in-app + optional email).
 * Runs after the response is sent; failures are logged, never thrown.
 */
const notifyFollowers = (caseRecord, { type, title, body, excludeUserId }) => {
  const link = `/kasus/${caseRecord.slug}`;
  setImmediate(async () => {
    try {
      const follows = await prisma.follow.findMany({
        where: { caseId: caseRecord.id, ...(excludeUserId ? { userId: { not: excludeUserId } } : {}) },
        include: { user: { select: { id: true, email: true, emailNotifications: true, bannedAt: true } } },
      });
      if (follows.length === 0) return;
      await prisma.notification.createMany({
        data: follows.map((f) => ({ userId: f.userId, caseId: caseRecord.id, type, title, body, link })),
      });
      await Promise.all(
        follows
          .filter((f) => f.user.emailNotifications && !f.user.bannedAt)
          .map((f) => sendMail({ to: f.user.email, subject: title, text: body, link })),
      );
    } catch (err) {
      console.error('Gagal mengirim notifikasi pengikut:', err.message);
    }
  });
};

const notifyUser = async (userId, { type, title, body, link, caseId }) => {
  try {
    await prisma.notification.create({ data: { userId, type, title, body, link, caseId } });
  } catch (err) {
    console.error('Gagal membuat notifikasi:', err.message);
  }
};

module.exports = { notifyFollowers, notifyUser };
