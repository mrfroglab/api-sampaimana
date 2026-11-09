const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { ok, created, parse, badRequest, unauthorized, forbidden, conflict } = require('../lib/http');
const tokens = require('../lib/tokens');
const { authenticate, userSelect } = require('../middlewares/auth');
const { authLimiter } = require('../middlewares/rateLimit');

const router = express.Router();

const email = z.string().trim().toLowerCase().email('Format email tidak valid.').max(160);
const password = z
  .string()
  .min(8, 'Kata sandi minimal 8 karakter.')
  .max(128, 'Kata sandi maksimal 128 karakter.');

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Nama minimal 2 karakter.').max(80),
  email,
  password,
});
const loginSchema = z.object({ email, password: z.string().min(1, 'Kata sandi wajib diisi.').max(128) });

// Constant-time-ish failure path: compare against a dummy hash when the user does not exist.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

const publicUser = ({ id, email: mail, name, role, emailNotifications, createdAt }) => ({
  id,
  email: mail,
  name,
  role,
  emailNotifications,
  createdAt,
});

const startSession = async (req, res, user) => {
  const refresh = await tokens.issueRefreshToken(user.id, { userAgent: req.get('user-agent') });
  res.cookie(tokens.REFRESH_COOKIE, refresh, tokens.refreshCookieOptions());
  return { user: publicUser(user), accessToken: tokens.signAccessToken(user) };
};

router.post('/register', authLimiter, async (req, res) => {
  const data = parse(registerSchema, req.body);
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
  if (!user || !valid) throw unauthorized('Email atau kata sandi salah.');
  if (user.bannedAt) throw forbidden('Akun Anda dinonaktifkan oleh moderator.');
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
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(data.newPassword, 12) },
  });
  // Sign out every other device.
  await tokens.revokeAllForUser(user.id);
  return ok(res, await startSession(req, res, user), { message: 'Kata sandi diperbarui.' });
});

module.exports = router;
