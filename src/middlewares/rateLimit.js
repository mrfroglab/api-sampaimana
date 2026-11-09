const net = require('net');
const { rateLimit } = require('express-rate-limit');
const env = require('../config/env');

const PRIVATE_V4 = [/^10\./, /^127\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

const isPrivate = (addr = '') => {
  const ip = addr.replace(/^::ffff:/, '');
  if (net.isIPv4(ip)) return PRIVATE_V4.some((re) => re.test(ip));
  return ip === '::1' || /^f[cd]/i.test(ip);
};

/**
 * Server-side rendering calls the API directly over the private docker network,
 * without going through the reverse proxy. Those requests carry no
 * X-Forwarded-For header and must not share one rate-limit bucket.
 */
const isInternal = (req) => req.headers['x-forwarded-for'] === undefined && isPrivate(req.socket?.remoteAddress);

const make = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => env.RATE_LIMIT_DISABLED || isInternal(req),
    message: { success: false, message },
  });

module.exports = {
  // Whole API: generous, stops scrapers hammering the DB.
  apiLimiter: make(60 * 1000, 300, 'Terlalu banyak permintaan. Coba lagi sebentar lagi.'),
  // Login/register: brute-force protection.
  authLimiter: make(15 * 60 * 1000, 20, 'Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit.'),
  // Public write endpoints (corrections, contributions).
  writeLimiter: make(60 * 60 * 1000, 10, 'Batas pengiriman tercapai. Coba lagi dalam satu jam.'),
  isInternal,
};
