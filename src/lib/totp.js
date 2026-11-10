/**
 * Time-based one-time passwords (RFC 6238, SHA-1, 6 digits, 30 s) for two-factor login,
 * plus at-rest encryption of the shared secret and one-time recovery codes.
 * No dependency: it is a few lines on top of node:crypto.
 */
const crypto = require('crypto');
const env = require('../config/env');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;
const DIGITS = 6;

const base32Encode = (buf) => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

const base32Decode = (str) => {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

const generateSecret = () => base32Encode(crypto.randomBytes(20));

/** HOTP value for a counter (RFC 4226). */
const hotp = (secret, counter) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = mac[mac.length - 1] & 15;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
};

const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP);

/**
 * Checks a code against the previous, current and next step (clock drift).
 * Returns the matched step, or null. Steps at or before `lastStep` are rejected so a code
 * cannot be replayed.
 */
const verify = (secret, code, { lastStep = null, now = Date.now() } = {}) => {
  const clean = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) {
    if (lastStep !== null && s <= lastStep) continue;
    const expected = hotp(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return s;
  }
  return null;
};

const otpauthUrl = (secret, account, issuer = 'Sampai Mana') =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;

// The secret is stored encrypted (AES-256-GCM) with a key derived from JWT_SECRET, so a
// database dump alone is not enough to generate codes.
const key = () => crypto.hkdfSync('sha256', env.JWT_SECRET, 'sampaimana', 'totp-secret-v1', 32);

const encrypt = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key()), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
};

const decrypt = (stored) => {
  const [version, iv, tag, data] = String(stored).split('.');
  if (version !== 'v1') throw new Error('Unknown secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key()), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
};

// Recovery codes: 10 codes like "k7f2-9xqm", stored as SHA-256 hashes, each usable once.
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const normalizeRecovery = (code) => String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hashRecovery = (code) => crypto.createHash('sha256').update(normalizeRecovery(code)).digest('hex');
const generateRecoveryCodes = (count = 10) =>
  Array.from({ length: count }, () => {
    const chars = Array.from(crypto.randomBytes(8), (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });

module.exports = {
  base32Encode,
  base32Decode,
  generateSecret,
  hotp,
  currentStep,
  verify,
  otpauthUrl,
  encrypt,
  decrypt,
  hashRecovery,
  normalizeRecovery,
  generateRecoveryCodes,
};
