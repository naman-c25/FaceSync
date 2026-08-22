import { createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import { config } from '../config/index.js';

const SCRYPT_N = 32768;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
const SCRYPT_OPTIONS = { N: SCRYPT_N, maxmem: 128 * SCRYPT_N * 8 * 2 };

/**
 * Server-side pepper, mixed into a PIN before it is hashed.
 *
 * This is the part that matters for a PIN, and the reason a slow hash alone is
 * not enough. Four digits is ten thousand possibilities: an attacker holding
 * the database can simply hash all of them and read every PIN, however slow
 * the hash. The pepper is not stored with the data, so a stolen database is
 * useless without also stealing the key.
 *
 * Derived from the master key by HKDF with its own label, so it is an
 * independent key from the one that encrypts embeddings while there is still
 * only one secret to keep safe.
 */
const PEPPER = Buffer.from(
  hkdfSync(
    'sha256',
    Buffer.from(config.ENCRYPTION_KEY, 'hex'),
    Buffer.alloc(0),
    'facepay-pin-pepper-v1',
    32,
  ),
);

const pepper = (pin) => createHmac('sha256', PEPPER).update(String(pin)).digest();

/**
 * Hash a PIN for storage.
 *
 * Hashed, never encrypted. Encryption is reversible: whoever holds the key
 * holds every customer's PIN in plaintext. Nothing in this system ever needs
 * to read a PIN back — only to check whether the one just typed matches — so
 * storing it in a recoverable form would be taking a risk in exchange for
 * nothing.
 */
export function hashPin(pin) {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(pepper(pin), salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPin(pin, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;

  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');

  let actual;
  try {
    actual = scryptSync(
      pepper(pin),
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

/**
 * PINs an attacker would try first, and that offer almost no protection.
 *
 * Roughly a quarter of real four-digit PINs are one of a handful of patterns,
 * and "1234" alone accounts for about one in ten. Rejecting the obvious ones
 * at the point of choosing costs the customer one retry and removes the
 * cheapest attack outright.
 */
const WEAK_PINS = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '0123', '3210', '1212', '2121', '1122', '2211',
  '1004', '2000', '2001', '1010', '0101', '6969', '4444', '1313',
]);

/** Why a PIN cannot be used, or null if it is fine. */
export function rejectWeakPin(pin) {
  if (!/^\d{4}$/.test(pin)) return 'A PIN must be exactly four digits';
  if (WEAK_PINS.has(pin)) return 'That PIN is too common — pick a less obvious one';

  // 1234, 2345, 9876 and so on. Runs are what people reach for first.
  const digits = [...pin].map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const descending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  if (ascending || descending) return 'Sequential digits are too easy to guess';

  return null;
}
