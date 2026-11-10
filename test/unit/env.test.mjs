import { describe, it, expect } from 'vitest';
import env from '../../src/config/env.js';

const { parseEnv } = env;
const base = { DATABASE_URL: 'postgresql://x', JWT_SECRET: 'a'.repeat(32) };

describe('parseEnv', () => {
  it('applies safe defaults in development', () => {
    const { env: e } = parseEnv(base);
    expect(e.NODE_ENV).toBe('development');
    expect(e.PORT).toBe(5000);
    expect(e.ACCESS_TOKEN_TTL).toBe('15m');
    expect(e.RATE_LIMIT_DISABLED).toBe(false);
    expect(e.corsOrigins).toEqual(['http://localhost:5173', 'http://localhost:3000']);
    expect(e.isProd).toBe(false);
  });

  it('refuses a missing or short JWT secret', () => {
    expect(parseEnv({ DATABASE_URL: 'x' }).errors?.join()).toMatch(/JWT_SECRET/);
    expect(parseEnv({ ...base, JWT_SECRET: 'short' }).errors?.join()).toMatch(/minimal 32/);
  });

  it('requires DATABASE_URL', () => {
    expect(parseEnv({ JWT_SECRET: 'a'.repeat(32) }).errors?.join()).toMatch(/DATABASE_URL/);
  });

  it('requires CORS_ORIGIN in production and rejects the wildcard', () => {
    expect(parseEnv({ ...base, NODE_ENV: 'production' }).errors?.join()).toMatch(/CORS_ORIGIN wajib/);
    expect(parseEnv({ ...base, CORS_ORIGIN: 'https://a.id,*' }).errors?.join()).toMatch(/tidak boleh "\*"/);
  });

  it('splits and trims CORS origins', () => {
    const { env: e } = parseEnv({ ...base, NODE_ENV: 'production', CORS_ORIGIN: ' https://a.id , https://b.id ,' });
    expect(e.corsOrigins).toEqual(['https://a.id', 'https://b.id']);
    expect(e.isProd).toBe(true);
  });

  it('coerces numbers and booleans from strings', () => {
    const { env: e } = parseEnv({ ...base, PORT: '8080', REFRESH_TOKEN_DAYS: '7', RATE_LIMIT_DISABLED: 'true' });
    expect(e.PORT).toBe(8080);
    expect(e.REFRESH_TOKEN_DAYS).toBe(7);
    expect(e.RATE_LIMIT_DISABLED).toBe(true);
    expect(parseEnv({ ...base, PORT: 'abc' }).errors?.join()).toMatch(/PORT/);
  });

  it('turns reminders on by default only in production, and reads STALE_DAYS', () => {
    expect(parseEnv(base).env.REMINDERS_ENABLED).toBe(false);
    expect(parseEnv({ ...base, NODE_ENV: 'production', CORS_ORIGIN: 'https://a.id' }).env.REMINDERS_ENABLED).toBe(true);
    expect(parseEnv({ ...base, NODE_ENV: 'production', CORS_ORIGIN: 'https://a.id', REMINDERS_ENABLED: 'false' }).env.REMINDERS_ENABLED).toBe(false);
    expect(parseEnv({ ...base, REMINDERS_ENABLED: 'true' }).env.REMINDERS_ENABLED).toBe(true);
    expect(parseEnv(base).env.STALE_DAYS).toBe(30);
    expect(parseEnv({ ...base, STALE_DAYS: '14' }).env.STALE_DAYS).toBe(14);
    expect(parseEnv({ ...base, STALE_DAYS: '0' }).errors?.join()).toMatch(/STALE_DAYS/);
  });
});
