require('dotenv').config({ quiet: true });
const { z } = require('zod');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(5000),
    DATABASE_URL: z.string({ error: 'DATABASE_URL wajib diisi' }).min(1, 'DATABASE_URL wajib diisi'),
    JWT_SECRET: z.string({ error: 'JWT_SECRET wajib diisi (openssl rand -hex 32)' }).min(32, 'JWT_SECRET wajib diisi, minimal 32 karakter acak'),
    ACCESS_TOKEN_TTL: z.string().default('15m'),
    REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(30),
    // Comma separated. Required in production; same-origin deployments set it to PUBLIC_URL.
    CORS_ORIGIN: z.string().optional(),
    PUBLIC_URL: z.string().url().default('http://localhost:5173'),
    UPLOAD_DIR: z.string().default('./uploads'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(1),
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().default('Sampai Mana <no-reply@sampaimana.local>'),
    // Cases with no activity for this many days show up as "stale" in the editorial attention list.
    STALE_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
    // Daily editorial digest. Defaults to on in production only.
    REMINDERS_ENABLED: z.enum(['true', 'false']).optional(),
    // Public sign-up. "false" = only existing accounts can sign in (accounts are made by an admin).
    REGISTRATION_OPEN: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    // Cloudflare Turnstile on sign-up. Both keys set = on; empty = off.
    TURNSTILE_SITE_KEY: z.string().optional(),
    TURNSTILE_SECRET_KEY: z.string().optional(),
    // Reject passwords found in public breaches (Have I Been Pwned, k-anonymity). Off in tests.
    PWNED_CHECK: z.enum(['true', 'false']).optional(),
    // Failed sign-ins per account before it is locked, and for how long.
    LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(100).default(10),
    LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    RATE_LIMIT_DISABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.CORS_ORIGIN) {
      ctx.addIssue({ code: 'custom', path: ['CORS_ORIGIN'], message: 'CORS_ORIGIN wajib diisi di production' });
    }
    if (env.CORS_ORIGIN?.split(',').some((o) => o.trim() === '*')) {
      ctx.addIssue({ code: 'custom', path: ['CORS_ORIGIN'], message: 'CORS_ORIGIN tidak boleh "*" karena kredensial dipakai' });
    }
  });

/**
 * Validates a raw environment object. Pure: returns { env } or { errors } so it can be unit tested.
 */
const parseEnv = (source) => {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    return { errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const env = parsed.data;
  env.corsOrigins = env.CORS_ORIGIN
    ? env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
    : ['http://localhost:5173', 'http://localhost:3000'];
  env.isProd = env.NODE_ENV === 'production';
  env.isTest = env.NODE_ENV === 'test';
  env.REMINDERS_ENABLED = env.REMINDERS_ENABLED === undefined ? env.isProd : env.REMINDERS_ENABLED === 'true';
  env.PWNED_CHECK = env.PWNED_CHECK === undefined ? !env.isTest : env.PWNED_CHECK === 'true';
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) {
    env.TURNSTILE_SITE_KEY = undefined;
    env.TURNSTILE_SECRET_KEY = undefined;
  }
  return { env };
};

const result = parseEnv(process.env);
if (result.errors) {
  // Fail fast: never boot with a weak or missing secret.
  console.error(`Konfigurasi environment tidak valid:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}

module.exports = result.env;
module.exports.parseEnv = parseEnv;
