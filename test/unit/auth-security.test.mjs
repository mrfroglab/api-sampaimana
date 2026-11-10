import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import totp from '../../src/lib/totp.js';
import guards from '../../src/lib/authGuards.js';
import env from '../../src/config/env.js';

describe('totp', () => {
  // RFC 6238 appendix B test vector (SHA-1, secret "12345678901234567890").
  const rfcSecret = totp.base32Encode(Buffer.from('12345678901234567890'));

  it('matches the RFC 6238 test vectors', () => {
    expect(totp.hotp(rfcSecret, Math.floor(59 / 30))).toBe('287082');
    expect(totp.hotp(rfcSecret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totp.hotp(rfcSecret, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('round-trips base32', () => {
    const buf = crypto.randomBytes(20);
    expect(totp.base32Decode(totp.base32Encode(buf)).equals(buf)).toBe(true);
  });

  it('accepts the current and adjacent steps, rejects others and replays', () => {
    const secret = totp.generateSecret();
    const now = Date.now();
    const step = totp.currentStep(now);
    expect(totp.verify(secret, totp.hotp(secret, step), { now })).toBe(step);
    expect(totp.verify(secret, totp.hotp(secret, step - 1), { now })).toBe(step - 1);
    expect(totp.verify(secret, totp.hotp(secret, step + 1), { now })).toBe(step + 1);
    expect(totp.verify(secret, totp.hotp(secret, step - 3), { now })).toBeNull();
    // Already used step
    expect(totp.verify(secret, totp.hotp(secret, step), { now, lastStep: step })).toBeNull();
    expect(totp.verify(secret, 'abcdef', { now })).toBeNull();
    expect(totp.verify(secret, '', { now })).toBeNull();
  });

  it('encrypts the secret at rest and detects tampering', () => {
    const secret = totp.generateSecret();
    const stored = totp.encrypt(secret);
    expect(stored).not.toContain(secret);
    expect(totp.decrypt(stored)).toBe(secret);
    const parts = stored.split('.');
    parts[3] = Buffer.from('x'.repeat(32)).toString('base64url');
    expect(() => totp.decrypt(parts.join('.'))).toThrow();
  });

  it('makes distinct recovery codes whose hash ignores case and dashes', () => {
    const codes = totp.generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
    expect(totp.hashRecovery(codes[0].toUpperCase().replace('-', ' '))).toBe(totp.hashRecovery(codes[0]));
  });

  it('builds an otpauth URL for authenticator apps', () => {
    const url = totp.otpauthUrl('ABC', 'a@b.c');
    expect(url).toMatch(/^otpauth:\/\/totp\/Sampai%20Mana%3Aa%40b\.c\?secret=ABC&issuer=Sampai%20Mana/);
  });
});

describe('auth guards', () => {

  it('flags disposable email domains and their subdomains only', () => {
    expect(guards.isDisposableEmail('a@mailinator.com')).toBe(true);
    expect(guards.isDisposableEmail('a@x.yopmail.com')).toBe(true);
    expect(guards.isDisposableEmail('a@gmail.com')).toBe(false);
    expect(guards.isDisposableEmail('a@notmailinator.com')).toBe(false);
  });

  it('checks breached passwords by hash prefix only', async () => {
    const hash = crypto.createHash('sha1').update('password').digest('hex').toUpperCase();
    let requested;
    const fetchImpl = async (url) => {
      requested = url;
      return { ok: true, text: async () => `0000000000000000000000000000000000A:1\r\n${hash.slice(5)}:9999\r\n` };
    };
    expect(await guards.pwnedCount('password', { fetchImpl, enabled: true })).toBe(9999);
    expect(requested).toBe(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`);
    expect(requested).not.toContain(hash.slice(5));
    expect(await guards.pwnedCount('something-else-entirely', { fetchImpl, enabled: true })).toBe(0);
  });

  it('fails open when the breach service is down, and is skipped when disabled', async () => {
    expect(await guards.pwnedCount('password', { enabled: true, fetchImpl: async () => { throw new Error('down'); } })).toBe(0);
    let called = false;
    await guards.pwnedCount('password', { enabled: false, fetchImpl: async () => { called = true; } });
    expect(called).toBe(false);
  });

  it('turnstile: passes when off, fails closed when on', async () => {
    const secret = 'secret';
    expect(await guards.verifyTurnstile(undefined, null, { secret: undefined })).toBe(true);
    expect(await guards.verifyTurnstile(undefined, null, { secret })).toBe(false);
    expect(await guards.verifyTurnstile('t', '1.2.3.4', { secret, fetchImpl: async () => ({ json: async () => ({ success: true }) }) })).toBe(true);
    expect(await guards.verifyTurnstile('t', null, { secret, fetchImpl: async () => ({ json: async () => ({ success: false }) }) })).toBe(false);
    expect(await guards.verifyTurnstile('t', null, { secret, fetchImpl: async () => { throw new Error('x'); } })).toBe(false);
  });
});

describe('auth env', () => {
  const base = { DATABASE_URL: 'postgresql://x', JWT_SECRET: 'a'.repeat(32) };

  it('defaults: registration open, turnstile off, breach check on outside tests', () => {
    const { env: e } = env.parseEnv(base);
    expect(e.REGISTRATION_OPEN).toBe(true);
    expect(e.TURNSTILE_SITE_KEY).toBeUndefined();
    expect(e.PWNED_CHECK).toBe(true);
    expect(e.LOGIN_MAX_FAILURES).toBe(10);
    expect(env.parseEnv({ ...base, NODE_ENV: 'test' }).env.PWNED_CHECK).toBe(false);
  });

  it('only enables turnstile when both keys are set', () => {
    expect(env.parseEnv({ ...base, TURNSTILE_SITE_KEY: 'a' }).env.TURNSTILE_SITE_KEY).toBeUndefined();
    const { env: e } = env.parseEnv({ ...base, TURNSTILE_SITE_KEY: 'a', TURNSTILE_SECRET_KEY: 'b' });
    expect(e.TURNSTILE_SITE_KEY).toBe('a');
    expect(env.parseEnv({ ...base, REGISTRATION_OPEN: 'false' }).env.REGISTRATION_OPEN).toBe(false);
  });
});
