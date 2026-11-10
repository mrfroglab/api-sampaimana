import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import helpers from './helpers.js';
import totp from '../../src/lib/totp.js';

const { api, prisma, resetDb, makeUser } = helpers;

const cookieValue = (setCookie) => setCookie?.find((c) => c.startsWith('sm_rt='))?.split(';')[0];
const codeFor = (secret, offset = 0) => totp.hotp(secret, totp.currentStep() + offset);

/** Turns 2FA on for a signed-in user. Returns the secret and recovery codes. */
const enable2fa = async ({ token, cookie, password }) => {
  const setup = await api()
    .post('/api/auth/2fa/setup')
    .set('Authorization', `Bearer ${token}`)
    .send({ password });
  expect(setup.status).toBe(200);
  expect(setup.body.data.qrSvg).toContain('<svg');
  const { secret } = setup.body.data;
  const enable = await api()
    .post('/api/auth/2fa/enable')
    .set('Authorization', `Bearer ${token}`)
    .set('Cookie', cookieValue(cookie))
    .send({ code: codeFor(secret) });
  expect(enable.status).toBe(200);
  return { secret, recoveryCodes: enable.body.data.recoveryCodes };
};

describe('auth hardening', () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  it('locks an account after repeated failures, even with the right password', async () => {
    const { user, password } = await makeUser();
    for (let i = 0; i < 10; i += 1) {
      await api().post('/api/auth/login').send({ email: user.email, password: 'wrong-password' }).expect(401);
    }
    const locked = await api().post('/api/auth/login').send({ email: user.email, password });
    expect(locked.status).toBe(429);
    expect(locked.body.message).toMatch(/dikunci/);

    const row = await prisma.user.findUnique({ where: { id: user.id } });
    expect(row.lockedUntil.getTime()).toBeGreaterThan(Date.now());
    const log = await prisma.activityLog.findFirst({ where: { action: 'LOCK', entityId: user.id } });
    expect(log).not.toBeNull();

    // Lock expires on its own
    await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    await api().post('/api/auth/login').send({ email: user.email, password }).expect(200);
  });

  it('a successful login resets the failure counter', async () => {
    const { user, password } = await makeUser();
    for (let i = 0; i < 5; i += 1) {
      await api().post('/api/auth/login').send({ email: user.email, password: 'wrong-password' });
    }
    await api().post('/api/auth/login').send({ email: user.email, password }).expect(200);
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    expect(row.failedLogins).toBe(0);
  });

  it('rejects disposable emails and can close registration', async () => {
    const res = await api().post('/api/auth/register').send({ name: 'Bot', email: 'x@mailinator.com', password: 'password-123' });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].path).toBe('email');

    const config = await api().get('/api/auth/config');
    expect(config.body.data).toEqual({ registrationOpen: true, turnstileSiteKey: null });
  });

  it('two-factor: password alone no longer starts a session', async () => {
    const session = await makeUser('EDITOR');
    const { secret, recoveryCodes } = await enable2fa(session);
    expect(recoveryCodes).toHaveLength(10);

    const me = await api().get('/api/auth/me').set('Authorization', `Bearer ${session.token}`);
    expect(me.body.data.twoFactorEnabled).toBe(true);

    const step1 = await api().post('/api/auth/login').send({ email: session.user.email, password: session.password });
    expect(step1.status).toBe(200);
    expect(step1.body.data.mfaRequired).toBe(true);
    expect(step1.body.data.accessToken).toBeUndefined();
    expect(step1.headers['set-cookie']).toBeUndefined();
    const { mfaTicket } = step1.body.data;

    // The ticket is not an access token
    await api().get('/api/auth/me').set('Authorization', `Bearer ${mfaTicket}`).expect(401);

    await api().post('/api/auth/login/2fa').send({ mfaTicket, code: '000000' }).expect(401);
    // Code from setup/enable was already used; the next step is fresh
    const ok = await api().post('/api/auth/login/2fa').send({ mfaTicket, code: codeFor(secret, 1) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.accessToken).toBeTypeOf('string');
    expect(cookieValue(ok.headers['set-cookie'])).toBeTruthy();

    // Same code cannot be replayed
    await api().post('/api/auth/login/2fa').send({ mfaTicket, code: codeFor(secret, 1) }).expect(401);
  });

  it('two-factor: recovery codes work once', async () => {
    const session = await makeUser('EDITOR');
    const { recoveryCodes } = await enable2fa(session);
    const step1 = await api().post('/api/auth/login').send({ email: session.user.email, password: session.password });
    const { mfaTicket } = step1.body.data;
    await api().post('/api/auth/login/2fa').send({ mfaTicket, code: recoveryCodes[0].toUpperCase() }).expect(200);
    await api().post('/api/auth/login/2fa').send({ mfaTicket, code: recoveryCodes[0] }).expect(401);
    const row = await prisma.user.findUnique({ where: { id: session.user.id } });
    expect(row.recoveryCodes).toHaveLength(9);
    expect(row.totpSecret).not.toContain('=');
  });

  it('two-factor: enabling signs out other devices; disabling needs password and code', async () => {
    const session = await makeUser('EDITOR');
    const other = await api().post('/api/auth/login').send({ email: session.user.email, password: session.password });
    const otherCookie = cookieValue(other.headers['set-cookie']);
    const { secret } = await enable2fa(session);

    await api().post('/api/auth/refresh').set('Cookie', otherCookie).expect(401);
    await api().post('/api/auth/refresh').set('Cookie', cookieValue(session.cookie)).expect(200);

    await api()
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ password: 'wrong', code: codeFor(secret, 1) })
      .expect(400);
    await api()
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ password: session.password, code: codeFor(secret, 1) })
      .expect(200);
    const login = await api().post('/api/auth/login').send({ email: session.user.email, password: session.password });
    expect(login.body.data.accessToken).toBeTypeOf('string');
  });

  it('super admin can reset 2FA and unlock another user', async () => {
    const admin = await makeUser('SUPER_ADMIN');
    const editor = await makeUser('EDITOR');
    await enable2fa(editor);
    await prisma.user.update({ where: { id: editor.user.id }, data: { lockedUntil: new Date(Date.now() + 60000) } });
    const res = await api()
      .patch(`/api/admin/users/${editor.user.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reset2fa: true, unlock: true });
    expect(res.status).toBe(200);
    expect(res.body.data.totpEnabledAt).toBeNull();
    expect(res.body.data.lockedUntil).toBeNull();
    const login = await api().post('/api/auth/login').send({ email: editor.user.email, password: editor.password });
    expect(login.body.data.accessToken).toBeTypeOf('string');
  });

  it('lists sessions, marks the current one, and signs out others', async () => {
    const session = await makeUser();
    const other = await api().post('/api/auth/login').send({ email: session.user.email, password: session.password });
    const current = cookieValue(session.cookie);

    const list = await api().get('/api/auth/sessions').set('Authorization', `Bearer ${session.token}`).set('Cookie', current);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((s) => s.current)).toHaveLength(1);

    const otherId = list.body.data.find((s) => !s.current).id;
    await api().delete(`/api/auth/sessions/${otherId}`).set('Authorization', `Bearer ${session.token}`).expect(200);
    await api().post('/api/auth/refresh').set('Cookie', cookieValue(other.headers['set-cookie'])).expect(401);

    // Another user's session id is not found
    const stranger = await makeUser();
    const strangerList = await api().get('/api/auth/sessions').set('Authorization', `Bearer ${stranger.token}`);
    await api().delete(`/api/auth/sessions/${strangerList.body.data[0].id}`).set('Authorization', `Bearer ${session.token}`).expect(404);

    const third = await api().post('/api/auth/login').send({ email: session.user.email, password: session.password });
    const revoke = await api()
      .post('/api/auth/sessions/revoke-others')
      .set('Authorization', `Bearer ${session.token}`)
      .set('Cookie', current);
    expect(revoke.body.data.revoked).toBe(1);
    await api().post('/api/auth/refresh').set('Cookie', cookieValue(third.headers['set-cookie'])).expect(401);
    await api().post('/api/auth/refresh').set('Cookie', current).expect(200);
  });

  it('staff password changes need at least 12 characters', async () => {
    const editor = await makeUser('EDITOR');
    const short = await api()
      .post('/api/auth/password')
      .set('Authorization', `Bearer ${editor.token}`)
      .send({ currentPassword: editor.password, newPassword: 'short-pw-1' });
    expect(short.status).toBe(400);
    expect(short.body.errors[0].path).toBe('newPassword');
    const contributor = await makeUser();
    await api()
      .post('/api/auth/password')
      .set('Authorization', `Bearer ${contributor.token}`)
      .send({ currentPassword: contributor.password, newPassword: 'short-pw-1' })
      .expect(200);
  });
});
