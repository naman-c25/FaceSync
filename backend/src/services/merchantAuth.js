import {
  createHmac,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

import { config } from '../config/index.js';

// scrypt parameters. N=2^15 costs roughly 100ms per hash on a laptop — slow
// enough to make guessing expensive, fast enough that a merchant does not
// notice it at the login screen.
//
// `maxmem` has to be raised with it. scrypt needs about 128 * N * r bytes, so
// N=32768 at the default r=8 lands exactly on Node's 32MB ceiling and throws
// "memory limit exceeded" rather than running slowly.
const SCRYPT_N = 32768;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
const SCRYPT_OPTIONS = { N: SCRYPT_N, maxmem: 128 * SCRYPT_N * 8 * 2 };

/**
 * Signing key for session tokens, derived from the master key.
 *
 * Derived rather than reusing ENCRYPTION_KEY directly, and rather than adding a
 * second secret to configure. Using one key for two purposes is how subtle
 * cross-protocol problems start; HKDF with a distinct label gives an
 * independent key from the same material, and there is still only one secret to
 * keep safe.
 */
const SIGNING_KEY = Buffer.from(
  hkdfSync(
    'sha256',
    Buffer.from(config.ENCRYPTION_KEY, 'hex'),
    Buffer.alloc(0),
    'facepay-merchant-session-v1',
    32,
  ),
);

export function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;

  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');

  let actual;
  try {
    actual = scryptSync(
      password,
      Buffer.from(saltHex, 'hex'),
      expected.length,
      SCRYPT_OPTIONS,
    );
  } catch {
    return false;
  }

  // Constant time: a plain comparison leaks how many bytes matched through how
  // long it took to fail.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const b64 = (buffer) => buffer.toString('base64url');

/**
 * Issue a signed session token.
 *
 * Stateless rather than a session row, so a terminal can keep working through
 * a database blip mid-transaction. The tradeoff is that a token cannot be
 * revoked before it expires, which is why the lifetime is hours rather than
 * weeks.
 */
export function issueToken(merchant) {
  const payload = {
    sub: String(merchant._id),
    merchantId: merchant.merchantId,
    role: merchant.role,
    exp: Date.now() + config.MERCHANT_SESSION_HOURS * 3600_000,
  };

  const body = b64(Buffer.from(JSON.stringify(payload)));
  const signature = b64(createHmac('sha256', SIGNING_KEY).update(body).digest());

  return `${body}.${signature}`;
}

/** Verify a token and return its payload, or null if it is not valid. */
export function readToken(token) {
  if (typeof token !== 'string') return null;

  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  const expected = b64(createHmac('sha256', SIGNING_KEY).update(body).digest());

  // Compare as buffers of equal length, and only then look at the contents.
  // Rejecting on a length mismatch first avoids timingSafeEqual throwing.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }

  // Checked after the signature, never before: an expiry read from an unsigned
  // payload is just a number the caller chose.
  if (!payload?.exp || payload.exp < Date.now()) return null;

  return payload;
}
