/**
 * Sign-up and password guards: disposable email domains, leaked passwords
 * (Have I Been Pwned, k-anonymity) and the optional Cloudflare Turnstile bot check.
 */
const crypto = require('crypto');
const env = require('../config/env');

// Common throwaway-inbox providers. Not exhaustive: it stops the lazy cases.
const DISPOSABLE = new Set([
  '10minutemail.com', '10minutemail.net', '20minutemail.com', 'anonaddy.me', 'burnermail.io', 'byom.de',
  'dispostable.com', 'dropmail.me', 'emailondeck.com', 'fakeinbox.com', 'fakemail.net', 'getairmail.com',
  'getnada.com', 'guerrillamail.biz', 'guerrillamail.com', 'guerrillamail.de', 'guerrillamail.info',
  'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com', 'harakirimail.com', 'inboxbear.com',
  'incognitomail.org', 'mail.tm', 'mailcatch.com', 'maildrop.cc', 'mailinator.com', 'mailinator.net',
  'mailnesia.com', 'mailpoof.com', 'mailsac.com', 'mintemail.com', 'moakt.com', 'mohmal.com', 'mytemp.email',
  'nada.email', 'sharklasers.com', 'spam4.me', 'spamgourmet.com', 'temp-mail.io', 'temp-mail.org',
  'tempail.com', 'tempinbox.com', 'tempmail.com', 'tempmail.dev', 'tempmail.net', 'tempmailo.com',
  'tempr.email', 'throwawaymail.com', 'tmail.ws', 'tmpmail.net', 'tmpmail.org', 'trashmail.com',
  'trashmail.de', 'trashmail.net', 'yopmail.com', 'yopmail.fr', 'yopmail.net', 'zetmail.com',
]);

const isDisposableEmail = (email) => {
  const domain = String(email).split('@')[1]?.toLowerCase();
  if (!domain) return false;
  // Also match subdomains (foo.mailinator.com).
  const parts = domain.split('.');
  return parts.some((_, i) => DISPOSABLE.has(parts.slice(i).join('.')));
};

/**
 * Number of times a password appears in known breaches, or 0. Only the first five hex
 * characters of its SHA-1 leave the server. Fails open (returns 0) when the service is
 * unreachable, so an outage never blocks sign-ups.
 */
const pwnedCount = async (password, { fetchImpl = globalThis.fetch, timeoutMs = 2500, enabled = env.PWNED_CHECK } = {}) => {
  if (!enabled) return 0;
  const hash = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    const res = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'sampaimana-api' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return 0;
    const text = await res.text();
    for (const line of text.split('\n')) {
      const [rest, count] = line.trim().split(':');
      if (rest === suffix) return Number(count) || 0;
    }
    return 0;
  } catch {
    return 0;
  }
};

/** True when Turnstile is off, or the token checks out with Cloudflare. */
const verifyTurnstile = async (token, ip, { fetchImpl = globalThis.fetch, secret = env.TURNSTILE_SECRET_KEY } = {}) => {
  if (!secret) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: String(token) });
    if (ip) body.set('remoteip', ip);
    const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    // Unlike the breach check this fails closed: the whole point is to stop bots.
    return false;
  }
};

module.exports = { isDisposableEmail, pwnedCount, verifyTurnstile, DISPOSABLE };
