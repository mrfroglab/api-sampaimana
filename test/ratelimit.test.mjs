import { describe, it, expect } from 'vitest';
import rl from '../src/middlewares/rateLimit.js';

const req = (remoteAddress, xff) => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress } });

describe('rate limit internal bypass', () => {
  it('treats direct calls from the private docker network as internal (SSR)', () => {
    expect(rl.isInternal(req('172.18.0.7'))).toBe(true);
    expect(rl.isInternal(req('::ffff:10.0.0.3'))).toBe(true);
  });
  it('limits anything that came through the proxy or from a public address', () => {
    expect(rl.isInternal(req('172.18.0.4', '203.0.113.9'))).toBe(false);
    expect(rl.isInternal(req('203.0.113.9'))).toBe(false);
    expect(rl.isInternal(req('172.18.0.4', ''))).toBe(false);
  });
});
