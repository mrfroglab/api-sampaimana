const prisma = require('../lib/prisma');
const { verifyAccessToken } = require('../lib/tokens');
const { unauthorized, forbidden } = require('../lib/http');

const userSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  bannedAt: true,
  emailNotifications: true,
  createdAt: true,
  totpEnabledAt: true,
};

const readBearer = (req) => {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
};

const loadUser = async (token) => {
  const payload = verifyAccessToken(token);
  return prisma.user.findUnique({ where: { id: payload.sub }, select: userSelect });
};

const authenticate = async (req, res, next) => {
  const token = readBearer(req);
  if (!token) throw unauthorized();
  let user;
  try {
    user = await loadUser(token);
  } catch (err) {
    throw unauthorized(err.name === 'TokenExpiredError' ? 'Sesi telah kedaluwarsa.' : 'Token tidak valid.');
  }
  if (!user) throw unauthorized('Akun tidak ditemukan.');
  if (user.bannedAt) throw forbidden('Akun Anda dinonaktifkan oleh moderator.');
  req.user = user;
  next();
};

/** Attaches req.user when a valid token is present; never rejects. */
const optionalAuth = async (req, res, next) => {
  const token = readBearer(req);
  if (token) {
    try {
      const user = await loadUser(token);
      if (user && !user.bannedAt) req.user = user;
    } catch {
      /* anonymous */
    }
  }
  next();
};

const authorize =
  (...roles) =>
  (req, res, next) => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) throw forbidden();
    next();
  };

const STAFF = ['SUPER_ADMIN', 'EDITOR', 'VIEWER'];
const EDITORS = ['SUPER_ADMIN', 'EDITOR'];

module.exports = { authenticate, optionalAuth, authorize, userSelect, STAFF, EDITORS };
