import { describe, it, expect } from 'vitest';
import audit from '../../src/lib/audit.js';
import cases from '../../src/modules/cases.js';
import labels from '../../src/lib/labels.js';
import openapi from '../../src/docs/openapi.js';

const { scrub } = audit;
const { csvCell, buildWhere } = cases;

describe('scrub (audit log)', () => {
  it('hides secrets at any depth', () => {
    const out = scrub({ email: 'a@b.c', password: 'x', nested: { refreshToken: 'y', list: [{ secret: 'z', ok: 1 }] } });
    expect(out).toEqual({
      email: 'a@b.c',
      password: '[disembunyikan]',
      nested: { refreshToken: '[disembunyikan]', list: [{ secret: '[disembunyikan]', ok: 1 }] },
    });
  });
  it('truncates long strings and long arrays', () => {
    expect(scrub({ s: 'a'.repeat(600) }).s).toHaveLength(501);
    expect(scrub({ a: Array.from({ length: 50 }, (_, i) => i) }).a).toHaveLength(20);
  });
  it('stops at a maximum depth', () => {
    const deep = { a: { b: { c: { d: { e: { f: { password: 'x' } } } } } } };
    expect(() => scrub(deep)).not.toThrow();
  });
});

describe('csvCell', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });
  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+62 812')).toBe("'+62 812");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@cmd')).toBe("'@cmd");
  });
  it('formats dates and empties', () => {
    expect(csvCell(new Date('2024-01-02T03:04:05Z'))).toBe('2024-01-02T03:04:05.000Z');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(0)).toBe('0');
  });
});

describe('buildWhere (public case search)', () => {
  it('always limits to active cases', () => {
    expect(buildWhere({})).toEqual({ isActive: true });
  });
  it('searches title, number, summary, description, institution and parties', () => {
    const w = buildWhere({ q: 'timah' });
    expect(w.OR).toHaveLength(6);
    expect(w.OR.at(-1)).toEqual({ defendants: { some: { name: { contains: 'timah', mode: 'insensitive' } } } });
  });
  it('filters by statuses and category slug', () => {
    expect(buildWhere({ status: ['PUTUSAN', 'PENYIDIKAN'], category: 'korupsi' })).toEqual({
      isActive: true,
      currentStatus: { in: ['PUTUSAN', 'PENYIDIKAN'] },
      category: { slug: 'korupsi' },
    });
  });
});

describe('labels', () => {
  it('orders the five stages and labels each one', () => {
    expect(labels.STATUS_ORDER).toEqual(['PELAPORAN', 'PENYIDIKAN', 'PENUNTUTAN', 'PERSIDANGAN', 'PUTUSAN']);
    labels.STATUS_ORDER.forEach((s) => expect(labels.STATUS_LABEL[s]).toBeTruthy());
  });
});

describe('openapi document', () => {
  it('is OpenAPI 3.1 and documents every public route', () => {
    expect(openapi.openapi).toBe('3.1.0');
    for (const p of ['/api/cases', '/api/cases/{key}', '/api/stats', '/api/auth/login', '/api/admin/contributions/{id}/review']) {
      expect(openapi.paths[p]).toBeDefined();
    }
  });
});
