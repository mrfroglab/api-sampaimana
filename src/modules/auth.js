const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { z } = require('zod');
const env = require('../config/env');
const prisma = require('../lib/prisma');
const { HttpError, ok, created, parse, badRequest, unauthorized, forbidden, conflict, notFound } = require('../lib/http');
const tokens = require('../lib/tokens');
const totp = require('../lib/totp');
const { isDisposableEmail, pwnedCount, verifyTurnstile } = require('../lib/authGuards');
const { audit } = require('../lib/audit');
const { authenticate, userSelect, STAFF } = require('../middlewares/auth');
const { authLimiter } = require('../middlewares/rateLimit');

const router = express.Router();

const email = z.string().trim().toLowerCase().email('Format email tidak valid.').max(160);
const password = z
  .string()
  .min(8, 'Kata sandi minimal 8 karakter.')
  .max(128, 'Kata sandi maksimal 128 karakter.');

// Staff accounts can change cases, so their passwords must be longer.
const STAFF_MIN_PASSWORD = 12;

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Nama minimal 2 karakter.').max(80),
  email,
  password,
  turnstileToken: z.string().max(4096).optional(),
});
const loginSchema = z.object({ email, password: z.string().min(1, 'Kata sandi wajib diisi.').max(128) });
const codeSchema = z.string().trim().min(6, 'Kode wajib diisi.').max(20);

// Constant-time-ish failure path: compare against a dummy hash when the user does not exist.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

const publicUser = ({ id, email: mail, name, role, emailNotifications, createdAt, totpEnabledAt }) => ({
  id,
  email: mail,
  name,
  role,
  emailNotifications,
  createdAt,
  twoFactorEnabled: Boolean(totpEnabledAt),
});

/** Audit entry about a user's own account (works before req.user exists). */
const logAccount = (req, userId, action, metadata) =>
  audit({ ip: req.ip, user: { id: userId } }, action, 'User', userId, metadata);

const startSession = async (req, res, user) => {
  const refresh = await tokens.issueRefreshToken(user.id, { userAgent: req.get('user-agent') });
  res.cookie(tokens.REFRESH_COOKIE, refresh, tokens.refreshCookieOptions());
  return { user: publicUser(user), accessToken: tokens.signAccessToken(user) };
};

/** Rejects passwords seen in public breaches, and short passwords for staff. */
const checkPasswordStrength = async (value, role, field = 'password') => {
  if (role && STAFF.includes(role) && value.length < STAFF_MIN_PASSWORD) {
    throw badRequest(`Akun redaksi wajib memakai kata sandi minimal ${STAFF_MIN_PASSWORD} karakter.`, [
      { path: field, message: `Minimal ${STAFF_MIN_PASSWORD} karakter untuk akun redaksi.` },
    ]);
  }
  if ((await pwnedCount(value)) > 0) {
    const message = 'Kata sandi ini pernah bocor di kebocoran data publik. Pilih kata sandi lain.';
    throw badRequest(message, [{ path: field, message }]);
  }
};

const lockedError = (until) => {
  const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60000));
  return new HttpError(
    429,
    `Akun ini dikunci sementara karena terlalu banyak percobaan gagal. Coba lagi dalam ${minutes} menit.`,
  );
};

const isLocked = (user) => Boolean(user.lockedUntil && user.lockedUntil > new Date());

/** Counts a failed attempt; locks the account once the limit is reached. */
const recordFailure = async (req, user) => {
  const failures = user.failedLogins + 1;
  const lock = failures >= env.LOGIN_MAX_FAILURES;
  await prisma.user.update({
    where: { id: user.id },
    data: lock
      ? { failedLogins: 0, lockedUntil: new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60000) }
      : { failedLogins: failures },
  });
  if (lock) logAccount(req, user.id, 'LOCK', { reason: 'failed-logins', minutes: env.LOGIN_LOCK_MINUTES });
};

const clearFailures = (user) =>
  user.failedLogins > 0 || user.lockedUntil
    ? prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } })
    : null;

// Short-lived ticket that proves the password step passed, used for the second step.
const MFA_AUDIENCE = 'sampaimana-mfa';
const signMfaTicket = (user) =>
  jwt.sign({ sub: user.id, typ: 'mfa' }, env.JWT_SECRET, { expiresIn: '5m', issuer: 'sampaimana', audience: MFA_AUDIENCE });
const readMfaTicket = (ticket) => {
  try {
    const payload = jwt.verify(ticket, env.JWT_SECRET, { issuer: 'sampaimana', audience: MFA_AUDIENCE });
    return payload.typ === 'mfa' ? payload.sub : null;
  } catch {
    return null;
  }
};

/**
 * Checks a TOTP code or a recovery code for a user with 2FA on. Records the TOTP step or
 * consumes the recovery code so neither can be reused. Returns true when it matched.
 */
const checkSecondFactor = async (req, user, code) => {
  const step = totp.verify(totp.decrypt(user.totpSecret), code, { lastStep: user.totpLastStep });
  if (step !== null) {
    // Conditional update: a concurrent request with the same code cannot also pass.
    const claimed = await prisma.user.updateMany({
      where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    });
    return claimed.count === 1;
  }
  if (totp.normalizeRecovery(code).length !== 8) return false;
  const hash = totp.hashRecovery(code);
  if (!user.recoveryCodes.includes(hash)) return false;
  await prisma.user.update({
    where: { id: user.id },
    data: { recoveryCodes: user.recoveryCodes.filter((h) => h !== hash) },
  });
  logAccount(req, user.id, 'RECOVERY_CODE_USED', { remaining: user.recoveryCodes.length - 1 });
  return true;
};

/** Public settings the sign-in and sign-up pages need. */
router.get('/config', (req, res) =>
  ok(res, { registrationOpen: env.REGISTRATION_OPEN, turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null }),
);

router.post('/register', authLimiter, async (req, res) => {
  if (!env.REGISTRATION_OPEN) throw forbidden('Pendaftaran akun baru sedang ditutup.');
  const data = parse(registerSchema, req.body);
  if (!(await verifyTurnstile(data.turnstileToken, req.ip))) {
    throw badRequest('Verifikasi anti-bot gagal. Muat ulang halaman lalu coba lagi.');
  }
  if (isDisposableEmail(data.email)) {
    const message = 'Gunakan alamat email tetap, bukan email sekali pakai.';
    throw badRequest(message, [{ path: 'email', message }]);
  }
  await checkPasswordStrength(data.password);
  const exists = await prisma.user.findUnique({ where: { email: data.email }, select: { id: true } });
  if (exists) throw conflict('Email sudah terdaftar. Silakan masuk.');
  const user = await prisma.user.create({
    data: { name: data.name, email: data.email, passwordHash: await bcrypt.hash(data.password, 12), role: 'CONTRIBUTOR' },
  });
  return created(res, await startSession(req, res, user), 'Akun berhasil dibuat.');
});

router.post('/login', authLimiter, async (req, res) => {
  const data = parse(loginSchema, req.body);
  const user = await prisma.user.findUnique({ where: { email: data.email } });
  const valid = await bcrypt.compare(data.password, user?.passwordHash ?? DUMMY_HASH);
  if (user && isLocked(user)) throw lockedError(user.lockedUntil);
  if (!user || !valid) {
    if (user) await recordFailure(req, user);
    throw unauthorized('Email atau kata sandi salah.');
  }
  if (user.bannedAt) throw forbidden('Akun Anda dinonaktifkan oleh moderator.');
  if (user.totpEnabledAt) {
    // Password is right; the session only starts after the second factor.
    return ok(res, { mfaRequired: true, mfaTicket: signMfaTicket(user) });
  }
  await clearFailures(user);
  return ok(res, await startSession(req, res, user));
});

const mfaLoginSchema = z.object({ mfaTicket: z.string().min(1).max(2048), code: codeSchema });

router.post('/login/2fa', authLimiter, async (req, res) => {
  const data = parse(mfaLoginSchema, req.body);
  const userId = readMfaTicket(data.mfaTicket);
  const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
  if (!user?.totpEnabledAt) throw unauthorized('Sesi verifikasi berakhir. Masuk ulang dari awal.');
  if (isLocked(user)) throw lockedError(user.lockedUntil);
  if (user.bannedAt) throw forbidden('Akun Anda dinonaktifkan oleh moderator.');
  if (!(await checkSecondFactor(req, user, data.code))) {
    await recordFailure(req, user);
    throw unauthorized('Kode verifikasi salah atau sudah dipakai.');
  }
  await clearFailures(user);
  return ok(res, await startSession(req, res, user));
});

router.post('/refresh', async (req, res) => {
  const raw = req.cookies?.[tokens.REFRESH_COOKIE];
  // Anonymous visitors have no session cookie: answer "no session" without an error status.
  if (!raw) return ok(res, null);
  const result = await tokens.rotateRefreshToken(raw, req.get('user-agent'));
  if (!result) {
    res.clearCookie(tokens.REFRESH_COOKIE, { ...tokens.refreshCookieOptions(), maxAge: undefined });
    throw unauthorized('Sesi berakhir. Silakan masuk kembali.');
  }
  res.cookie(tokens.REFRESH_COOKIE, result.token, tokens.refreshCookieOptions());
  return ok(res, { user: publicUser(result.user), accessToken: tokens.signAccessToken(result.user) });
});

router.post('/logout', async (req, res) => {
  await tokens.revokeRefreshToken(req.cookies?.[tokens.REFRESH_COOKIE]);
  res.clearCookie(tokens.REFRESH_COOKIE, { ...tokens.refreshCookieOptions(), maxAge: undefined });
  return ok(res, null, { message: 'Anda telah keluar.' });
});

router.get('/me', authenticate, (req, res) => ok(res, publicUser(req.user)));

const profileSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  emailNotifications: z.boolean().optional(),
});

router.patch('/me', authenticate, async (req, res) => {
  const data = parse(profileSchema, req.body);
  const user = await prisma.user.update({ where: { id: req.user.id }, data, select: userSelect });
  return ok(res, publicUser(user));
});

const passwordSchema = z.object({ currentPassword: z.string().min(1), newPassword: password });

router.post('/password', authenticate, authLimiter, async (req, res) => {
  const data = parse(passwordSchema, req.body);
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!(await bcrypt.compare(data.currentPassword, user.passwordHash))) {
    throw badRequest('Kata sandi saat ini salah.');
  }
  await checkPasswordStrength(data.newPassword, user.role, 'newPassword');
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(data.newPassword, 12) },
  });
  // Sign out every other device.
  await tokens.revokeAllForUser(user.id);
  logAccount(req, user.id, 'PASSWORD_CHANGE');
  return ok(res, await startSession(req, res, user), { message: 'Kata sandi diperbarui.' });
});

/* ---------------------------------------------------------------- sessions */

// The refresh cookie is scoped to /api/auth, so these routes can tell which session is "this one".
const currentFamily = async (req) => {
  const raw = req.cookies?.[tokens.REFRESH_COOKIE];
  if (!raw) return null;
  const token = await prisma.refreshToken.findUnique({
    where: { tokenHash: tokens.hashToken(raw) },
    select: { family: true, userId: true },
  });
  return token?.userId === req.user.id ? token.family : null;
};

/** Revokes every live session of the user except the one making the request. */
const revokeOtherSessions = async (req) => {
  const keep = await currentFamily(req);
  const result = await prisma.refreshToken.updateMany({
    where: { userId: req.user.id, revokedAt: null, ...(keep ? { family: { not: keep } } : {}) },
    data: { revokedAt: new Date() },
  });
  return result.count;
};

router.get('/sessions', authenticate, async (req, res) => {
  const live = await prisma.refreshToken.findMany({
    where: { userId: req.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, family: true, userAgent: true, createdAt: true },
  });
  const families = live.length
    ? await prisma.refreshToken.groupBy({
        by: ['family'],
        where: { family: { in: live.map((t) => t.family) } },
        _min: { createdAt: true },
      })
    : [];
  const startedAt = Object.fromEntries(families.map((f) => [f.family, f._min.createdAt]));
  const current = await currentFamily(req);
  return ok(
    res,
    live.map((t) => ({
      id: t.id,
      userAgent: t.userAgent,
      lastActiveAt: t.createdAt,
      signedInAt: startedAt[t.family] ?? t.createdAt,
      current: t.family === current,
    })),
  );
});

router.delete('/sessions/:id', authenticate, async (req, res) => {
  const token = await prisma.refreshToken.findFirst({
    where: { id: String(req.params.id), userId: req.user.id },
    select: { family: true },
  });
  if (!token) throw notFound('Sesi tidak ditemukan.');
  await prisma.refreshToken.updateMany({
    where: { family: token.family, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return ok(res, null, { message: 'Perangkat dikeluarkan.' });
});

router.post('/sessions/revoke-others', authenticate, async (req, res) => {
  const revoked = await revokeOtherSessions(req);
  return ok(res, { revoked }, { message: 'Semua perangkat lain dikeluarkan.' });
});

/* ------------------------------------------------------- two-factor (TOTP) */

const passwordConfirm = z.object({ password: z.string().min(1, 'Kata sandi wajib diisi.').max(128) });
const secondFactorConfirm = z.object({ password: z.string().min(1, 'Kata sandi wajib diisi.').max(128), code: codeSchema });

const requirePassword = async (userId, value) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!(await bcrypt.compare(value, user.passwordHash))) throw badRequest('Kata sandi salah.');
  return user;
};

/** Step 1: create a pending secret and return it with a QR code. Nothing is enforced yet. */
router.post('/2fa/setup', authenticate, authLimiter, async (req, res) => {
  const { password: pw } = parse(passwordConfirm, req.body);
  const user = await requirePassword(req.user.id, pw);
  if (user.totpEnabledAt) throw conflict('Verifikasi dua langkah sudah aktif.');
  const secret = totp.generateSecret();
  await prisma.user.update({ where: { id: user.id }, data: { totpSecret: totp.encrypt(secret), totpLastStep: null } });
  const url = totp.otpauthUrl(secret, user.email);
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return ok(res, { secret, otpauthUrl: url, qrSvg });
});

/** Step 2: confirm with a code from the app. Turns 2FA on and returns recovery codes once. */
router.post('/2fa/enable', authenticate, authLimiter, async (req, res) => {
  const { code } = parse(z.object({ code: codeSchema }), req.body);
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (user.totpEnabledAt) throw conflict('Verifikasi dua langkah sudah aktif.');
  if (!user.totpSecret) throw badRequest('Mulai pengaturan verifikasi dua langkah terlebih dahulu.');
  const step = totp.verify(totp.decrypt(user.totpSecret), code);
  if (step === null) throw badRequest('Kode salah. Pastikan jam di ponsel Anda tepat lalu coba lagi.');
  const recoveryCodes = totp.generateRecoveryCodes();
  await prisma.user.update({
    where: { id: user.id },
    data: { totpEnabledAt: new Date(), totpLastStep: step, recoveryCodes: recoveryCodes.map(totp.hashRecovery) },
  });
  // Devices signed in with only a password are signed out.
  await revokeOtherSessions(req);
  logAccount(req, user.id, '2FA_ENABLE');
  return ok(res, { recoveryCodes }, { message: 'Verifikasi dua langkah aktif.' });
});

router.post('/2fa/disable', authenticate, authLimiter, async (req, res) => {
  const data = parse(secondFactorConfirm, req.body);
  const user = await requirePassword(req.user.id, data.password);
  if (!user.totpEnabledAt) throw badRequest('Verifikasi dua langkah belum aktif.');
  if (!(await checkSecondFactor(req, user, data.code))) throw badRequest('Kode verifikasi salah atau sudah dipakai.');
  await prisma.user.update({
    where: { id: user.id },
    data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: [] },
  });
  logAccount(req, user.id, '2FA_DISABLE');
  return ok(res, null, { message: 'Verifikasi dua langkah dimatikan.' });
});

router.post('/2fa/recovery-codes', authenticate, authLimiter, async (req, res) => {
  const data = parse(secondFactorConfirm, req.body);
  const user = await requirePassword(req.user.id, data.password);
  if (!user.totpEnabledAt) throw badRequest('Verifikasi dua langkah belum aktif.');
  if (!(await checkSecondFactor(req, user, data.code))) throw badRequest('Kode verifikasi salah atau sudah dipakai.');
  const recoveryCodes = totp.generateRecoveryCodes();
  await prisma.user.update({ where: { id: user.id }, data: { recoveryCodes: recoveryCodes.map(totp.hashRecovery) } });
  logAccount(req, user.id, 'RECOVERY_CODES_RESET');
  return ok(res, { recoveryCodes }, { message: 'Kode pemulihan baru dibuat. Kode lama tidak berlaku.' });
});

module.exports = router;
