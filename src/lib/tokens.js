const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const prisma = require('./prisma');

const REFRESH_COOKIE = 'sm_rt';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const signAccessToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
    issuer: 'sampaimana',
    audience: 'sampaimana-web',
  });

const verifyAccessToken = (token) =>
  jwt.verify(token, env.JWT_SECRET, { issuer: 'sampaimana', audience: 'sampaimana-web' });

/** Creates a new opaque refresh token. Returns the raw token (only ever sent in a cookie). */
const issueRefreshToken = async (userId, { family, userAgent } = {}) => {
  const raw = crypto.randomBytes(48).toString('base64url');
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: sha256(raw),
      family: family || crypto.randomUUID(),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
      userAgent: userAgent?.slice(0, 255),
    },
  });
  return raw;
};

/**
 * Rotates a refresh token. If a token that was already rotated is presented again
 * (likely stolen), the whole family is revoked.
 * Returns { user, token } or null.
 */
const rotateRefreshToken = async (raw, userAgent) => {
  if (!raw) return null;
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(raw) },
    include: { user: true },
  });
  if (!record) return null;

  if (record.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { family: record.family, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return null;
  }
  if (record.expiresAt < new Date() || record.user.bannedAt) return null;

  // Atomically claim the token so two concurrent refreshes cannot both succeed.
  const claimed = await prisma.refreshToken.updateMany({
    where: { id: record.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (claimed.count === 0) return null;

  const token = await issueRefreshToken(record.userId, { family: record.family, userAgent });
  return { user: record.user, token };
};

const revokeRefreshToken = async (raw) => {
  if (!raw) return;
  await prisma.refreshToken.updateMany({
    where: { tokenHash: sha256(raw), revokedAt: null },
    data: { revokedAt: new Date() },
  });
};

const revokeAllForUser = (userId) =>
  prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });

const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: env.isProd,
  sameSite: 'strict',
  path: '/api/auth',
  maxAge: env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
});

module.exports = {
  REFRESH_COOKIE,
  hashToken: sha256,
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
  refreshCookieOptions,
};
