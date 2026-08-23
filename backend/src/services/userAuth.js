import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { config } from '../config/index.js';

/**
 * Sessions for the customer portal.
 *
 * Deliberately separate from the merchant's, and not because the code would be
 * hard to share. A merchant token authorises charging somebody's face; a
 * customer token authorises reading one person's own history and deleting
 * their own data. One signing key for both would mean a bug that let one be
 * minted as the other, and the two are not close enough in consequence for
 * that risk to be worth a few saved lines.
 *
 * The password hashing itself is shared with `merchantAuth`, since scrypt
 * parameters are a property of the machine rather than of who is logging in,
 * and having two sets to keep in step is how one of them ends up weaker.
 */
export { hashPassword, verifyPassword } from './merchantAuth.js';

// Its own label, so this key is independent of the merchant one even though
// both derive from the same master secret.
const SIGNING_KEY = Buffer.from(
  hkdfSync(
    'sha256',
    Buffer.from(config.ENCRYPTION_KEY, 'hex'),
    Buffer.alloc(0),
    'facepay-user-session-v1',
    32,
  ),
);

const b64 = (buffer) => buffer.toString('base64url');

/**
 * Issue a signed session token for a customer.
 *
 * `role` is stamped in and checked on the way back out. Without it a token is
 * just a signed user id, and the only thing standing between the portal and a
 * terminal would be which route the holder happened to call.
 */
export function issueUserToken(user) {
  const payload = {
    sub: String(user._id),
    role: 'user',
    exp: Date.now() + config.USER_SESSION_HOURS * 3600_000,
  };

  const body = b64(Buffer.from(JSON.stringify(payload)));
  const signature = b64(createHmac('sha256', SIGNING_KEY).update(body).digest());

  return `${body}.${signature}`;
}

/** Verify a customer token and return its payload, or null. */
export function readUserToken(token) {
  if (typeof token !== 'string') return null;

  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  const expected = b64(createHmac('sha256', SIGNING_KEY).update(body).digest());

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }

  // After the signature, never before: an expiry read from an unsigned payload
  // is a number the caller chose.
  if (!payload?.exp || payload.exp < Date.now()) return null;
  if (payload.role !== 'user') return null;

  return payload;
}
