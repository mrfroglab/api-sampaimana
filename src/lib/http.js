const { z } = require('zod');
const multer = require('multer');
const { Prisma } = require('@prisma/client');
const env = require('../config/env');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = (msg, details) => new HttpError(400, msg, details);
const notFound = (msg = 'Data tidak ditemukan.') => new HttpError(404, msg);
const forbidden = (msg = 'Anda tidak memiliki izin untuk tindakan ini.') => new HttpError(403, msg);
const unauthorized = (msg = 'Silakan masuk terlebih dahulu.') => new HttpError(401, msg);
const conflict = (msg) => new HttpError(409, msg);

const ok = (res, data, extra = {}) => res.json({ success: true, data, ...extra });
const created = (res, data, message) => res.status(201).json({ success: true, message, data });

/** Parse req[part] with a zod schema; throws a ZodError handled by errorHandler. */
const parse = (schema, value) => schema.parse(value ?? {});

const zodMessage = (issues) => {
  const first = issues[0];
  return first ? first.message : 'Validasi gagal.';
};

const notFoundHandler = (req, res) => {
  res.status(404).json({ success: false, message: `Endpoint ${req.method} ${req.originalUrl} tidak ditemukan.` });
};

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({
      success: false,
      message: zodMessage(err.issues),
      errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof HttpError) {
    // An array of { path, message } is a field error list, the same shape as validation errors.
    const fields = Array.isArray(err.details) ? { errors: err.details } : { details: err.details };
    return res.status(err.status).json({ success: false, message: err.message, ...fields });
  }
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Ukuran file maksimal 10 MB.'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Maksimal 5 file bukti.'
          : 'Unggahan file gagal.';
    return res.status(400).json({ success: false, message });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const field = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : 'data';
      return res.status(409).json({ success: false, message: `Nilai ${field} sudah dipakai.` });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Data tidak ditemukan.' });
    }
    if (err.code === 'P2003') {
      return res.status(400).json({ success: false, message: 'Relasi data tidak valid.' });
    }
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Body JSON tidak valid.' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Body permintaan terlalu besar.' });
  }

  if (!env.isTest || process.env.DEBUG_ERRORS) console.error(err);
  return res.status(500).json({
    success: false,
    message: 'Terjadi kesalahan pada server.',
    ...(env.isProd ? {} : { error: err?.message }),
  });
};

/** Pagination helper with a hard cap so clients cannot request unbounded pages. */
const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

const pageMeta = (total, page, limit) => ({
  total,
  page,
  limit,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});

module.exports = {
  HttpError,
  badRequest,
  notFound,
  forbidden,
  unauthorized,
  conflict,
  ok,
  created,
  parse,
  notFoundHandler,
  errorHandler,
  pagination,
  pageMeta,
};
