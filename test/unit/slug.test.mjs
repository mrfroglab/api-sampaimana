import { describe, it, expect } from 'vitest';
import { slugify, uniqueSlug, isUuid } from '../../src/lib/slug.js';

describe('slugify', () => {
  it('lowercases, strips accents and punctuation', () => {
    expect(slugify('Korupsi Bansos: Kemensos (2020)!')).toBe('korupsi-bansos-kemensos-2020');
    expect(slugify('Pérez & Müller')).toBe('perez-muller');
  });
  it('trims leading/trailing separators and collapses repeats', () => {
    expect(slugify('  --[Contoh]--  kasus  ')).toBe('contoh-kasus');
  });
  it('caps length at 80 without a trailing dash', () => {
    const s = slugify(`${'a'.repeat(79)} bcd`);
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.endsWith('-')).toBe(false);
  });
  it('returns an empty string for text without letters or digits', () => {
    expect(slugify('—?!')).toBe('');
  });
});

describe('uniqueSlug', () => {
  const delegate = (taken) => ({
    findUnique: async ({ where }) => (taken[where.slug] ? { id: taken[where.slug] } : null),
  });

  it('returns the base slug when free', async () => {
    expect(await uniqueSlug(delegate({}), 'Kasus Baru')).toBe('kasus-baru');
  });
  it('appends a counter when taken', async () => {
    expect(await uniqueSlug(delegate({ 'kasus-baru': '1', 'kasus-baru-2': '2' }), 'Kasus Baru')).toBe('kasus-baru-3');
  });
  it('keeps the current slug for the record being edited', async () => {
    expect(await uniqueSlug(delegate({ 'kasus-baru': 'self' }), 'Kasus Baru', 'self')).toBe('kasus-baru');
  });
  it('falls back to "kasus" for empty titles', async () => {
    expect(await uniqueSlug(delegate({}), '???')).toBe('kasus');
  });
});

describe('isUuid', () => {
  it('recognises UUIDs only', () => {
    expect(isUuid('0b9c3f0e-8a5d-4c1f-9d2e-7a6b5c4d3e2f')).toBe(true);
    expect(isUuid('korupsi-bansos')).toBe(false);
    expect(isUuid("1' OR 1=1")).toBe(false);
  });
});
