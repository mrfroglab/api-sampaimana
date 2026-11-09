import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import http from '../../src/lib/http.js';

const { errorHandler, notFoundHandler, HttpError, badRequest, notFound, forbidden, unauthorized, conflict, pagination, pageMeta, ok, created } = http;

const mockRes = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = vi.fn((c) => {
    res.statusCode = c;
    return res;
  });
  res.json = vi.fn((b) => {
    res.body = b;
    return res;
  });
  return res;
};

const handle = (err) => {
  const res = mockRes();
  errorHandler(err, {}, res, () => {});
  return res;
};

describe('errorHandler', () => {
  it('maps zod errors to 400 with field paths and the first message', () => {
    let err;
    try {
      z.object({ email: z.string().email('Email salah'), name: z.string().min(2, 'Nama pendek') }).parse({ email: 'x', name: 'a' });
    } catch (e) {
      err = e;
    }
    const res = handle(err);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe('Email salah');
    expect(res.body.errors).toEqual([
      { path: 'email', message: 'Email salah' },
      { path: 'name', message: 'Nama pendek' },
    ]);
  });

  it.each([
    [badRequest('a'), 400],
    [unauthorized(), 401],
    [forbidden(), 403],
    [notFound(), 404],
    [conflict('x'), 409],
    [new HttpError(429, 'pelan')],
  ])('passes HttpError status through', (err, status = 429) => {
    const res = handle(err);
    expect(res.statusCode).toBe(status);
    expect(res.body.success).toBe(false);
  });

  it('maps prisma unique / not-found / relation errors', () => {
    const known = (code, meta) => new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: '6', meta });
    expect(handle(known('P2002', { target: ['caseNumber'] })).statusCode).toBe(409);
    expect(handle(known('P2002', { target: ['caseNumber'] })).body.message).toMatch(/caseNumber/);
    expect(handle(known('P2025')).statusCode).toBe(404);
    expect(handle(known('P2003')).statusCode).toBe(400);
  });

  it('maps multer limits to friendly 400s', () => {
    expect(handle(new multer.MulterError('LIMIT_FILE_SIZE')).body.message).toMatch(/10 MB/);
    expect(handle(new multer.MulterError('LIMIT_FILE_COUNT')).body.message).toMatch(/5 file/);
  });

  it('maps body parser failures', () => {
    expect(handle(Object.assign(new Error(), { type: 'entity.parse.failed' })).statusCode).toBe(400);
    expect(handle(Object.assign(new Error(), { type: 'entity.too.large' })).statusCode).toBe(413);
  });

  it('hides unknown errors behind a generic 500', () => {
    const res = handle(new Error('db password is hunter2'));
    expect(res.statusCode).toBe(500);
    expect(res.body.message).toBe('Terjadi kesalahan pada server.');
  });
});

describe('response helpers', () => {
  it('ok and created wrap data in the envelope', () => {
    const r1 = mockRes();
    ok(r1, { a: 1 }, { meta: { total: 1 } });
    expect(r1.body).toEqual({ success: true, data: { a: 1 }, meta: { total: 1 } });
    const r2 = mockRes();
    created(r2, { id: 'x' }, 'Dibuat');
    expect(r2.statusCode).toBe(201);
    expect(r2.body).toEqual({ success: true, message: 'Dibuat', data: { id: 'x' } });
  });

  it('notFoundHandler names the endpoint', () => {
    const res = mockRes();
    notFoundHandler({ method: 'GET', originalUrl: '/api/x' }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.message).toContain('GET /api/x');
  });
});

describe('pagination', () => {
  it('defaults and coerces', () => {
    expect(pagination.parse({})).toEqual({ page: 1, limit: 12 });
    expect(pagination.parse({ page: '3', limit: '50' })).toEqual({ page: 3, limit: 50 });
  });
  it('rejects oversized or invalid pages', () => {
    expect(() => pagination.parse({ limit: '51' })).toThrow();
    expect(() => pagination.parse({ page: '0' })).toThrow();
    expect(() => pagination.parse({ page: '1.5' })).toThrow();
  });
  it('pageMeta never reports zero pages', () => {
    expect(pageMeta(0, 1, 12)).toEqual({ total: 0, page: 1, limit: 12, totalPages: 1 });
    expect(pageMeta(25, 2, 12).totalPages).toBe(3);
  });
});
