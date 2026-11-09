import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import auth from '../../src/middlewares/auth.js';
import tokens from '../../src/lib/tokens.js';

const { authorize, STAFF, EDITORS } = auth;
const run = (mw, user) => {
  let passed = false;
  try {
    mw({ user }, {}, () => {
      passed = true;
    });
  } catch (err) {
    return err.status;
  }
  return passed ? 'next' : 'none';
};

describe('authorize', () => {
  it('requires a signed-in user', () => {
    expect(run(authorize('EDITOR'), undefined)).toBe(401);
  });
  it('allows listed roles and forbids others', () => {
    expect(run(authorize(...EDITORS), { role: 'EDITOR' })).toBe('next');
    expect(run(authorize(...EDITORS), { role: 'VIEWER' })).toBe(403);
    expect(run(authorize(...STAFF), { role: 'VIEWER' })).toBe('next');
    expect(run(authorize(...STAFF), { role: 'CONTRIBUTOR' })).toBe(403);
    expect(run(authorize('SUPER_ADMIN'), { role: 'EDITOR' })).toBe(403);
  });
});

describe('access tokens', () => {
  const user = { id: 'u1', role: 'EDITOR' };

  it('round-trips subject and role', () => {
    const payload = tokens.verifyAccessToken(tokens.signAccessToken(user));
    expect(payload).toMatchObject({ sub: 'u1', role: 'EDITOR', iss: 'sampaimana', aud: 'sampaimana-web' });
    expect(payload.exp - payload.iat).toBe(15 * 60);
  });

  it('rejects tokens with another secret, issuer or audience', () => {
    const secret = process.env.JWT_SECRET;
    expect(() => tokens.verifyAccessToken(jwt.sign({ sub: 'u1' }, 'x'.repeat(40), { issuer: 'sampaimana', audience: 'sampaimana-web' }))).toThrow();
    expect(() => tokens.verifyAccessToken(jwt.sign({ sub: 'u1' }, secret, { issuer: 'other', audience: 'sampaimana-web' }))).toThrow();
    expect(() => tokens.verifyAccessToken(jwt.sign({ sub: 'u1' }, secret, { issuer: 'sampaimana', audience: 'other' }))).toThrow();
  });

  it('rejects the "none" algorithm', () => {
    const forged = jwt.sign({ sub: 'u1', role: 'SUPER_ADMIN', iss: 'sampaimana', aud: 'sampaimana-web' }, '', { algorithm: 'none' });
    expect(() => tokens.verifyAccessToken(forged)).toThrow();
  });

  it('refresh cookie is httpOnly, strict and scoped to /api/auth', () => {
    const opts = tokens.refreshCookieOptions();
    expect(opts).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/api/auth' });
    expect(opts.maxAge).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
