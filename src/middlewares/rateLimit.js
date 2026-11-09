const { rateLimit } = require('express-rate-limit');
const env = require('../config/env');

const make = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => env.RATE_LIMIT_DISABLED,
    message: { success: false, message },
  });

module.exports = {
  // Whole API: generous, stops scrapers hammering the DB.
  apiLimiter: make(60 * 1000, 300, 'Terlalu banyak permintaan. Coba lagi sebentar lagi.'),
  // Login/register: brute-force protection.
  authLimiter: make(15 * 60 * 1000, 20, 'Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit.'),
  // Public write endpoints (corrections, contributions).
  writeLimiter: make(60 * 60 * 1000, 10, 'Batas pengiriman tercapai. Coba lagi dalam satu jam.'),
};
