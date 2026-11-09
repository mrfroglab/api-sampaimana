import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import helpers from './helpers.js';

const { api, prisma, resetDb, makeUser } = helpers;

const cookieValue = (setCookie) => setCookie?.find((c) => c.startsWith('sm_rt='))?.split(';')[0];

describe('auth', () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  it('registers a contributor, sets an httpOnly refresh cookie and never returns the hash', async () => {
    const res = await api().post('/api/auth/register').send({ name: 'Rina', email: 'RINA@test.local', password: 'rahasia-panjang' });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ email: 'rina@test.local', role: 'CONTRIBUTOR' });
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.accessToken).toBeTypeOf('string');
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('sm_rt='));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/auth/);
  });

  it('rejects short passwords and duplicate emails', async () => {
    const short = await api().post('/api/auth/register').send({ name: 'A b', email: 'a@test.local', password: '123' });
    expect(short.status).toBe(400);
    await api().post('/api/auth/register').send({ name: 'A b', email: 'a@test.local', password: 'password-123' });
    const dup = await api().post('/api/auth/register').send({ name: 'A b', email: 'a@test.local', password: 'password-123' });
    expect(dup.status).toBe(409);
  });

  it('returns the same error for unknown email and wrong password', async () => {
    const { user } = await makeUser();
    const wrong = await api().post('/api/auth/login').send({ email: user.email, password: 'nope-nope' });
    const unknown = await api().post('/api/auth/login').send({ email: 'ghost@test.local', password: 'nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('rotates refresh tokens and revokes the family when an old token is replayed', async () => {
    const { cookie } = await makeUser();
    const first = cookieValue(cookie);

    const r1 = await api().post('/api/auth/refresh').set('Cookie', first);
    expect(r1.status).toBe(200);
    const second = cookieValue(r1.headers['set-cookie']);
    expect(second).not.toBe(first);

    // Replay of the already-used token: rejected, and the fresh token dies with it.
    const replay = await api().post('/api/auth/refresh').set('Cookie', first);
    expect(replay.status).toBe(401);
    const afterReplay = await api().post('/api/auth/refresh').set('Cookie', second);
    expect(afterReplay.status).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const { cookie } = await makeUser();
    const rt = cookieValue(cookie);
    await api().post('/api/auth/logout').set('Cookie', rt).expect(200);
    await api().post('/api/auth/refresh').set('Cookie', rt).expect(401);
  });

  it('blocks banned users even with a valid access token', async () => {
    const { user, token } = await makeUser();
    await prisma.user.update({ where: { id: user.id }, data: { bannedAt: new Date() } });
    const res = await api().get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('rejects tokens signed with another secret', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const forged = jwt.sign({ sub: 'x', role: 'SUPER_ADMIN' }, 'super-secret-key-change-in-production-12345!');
    const res = await api().get('/api/admin/overview').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });
});
