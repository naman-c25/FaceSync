import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { config } from '../config/index.js';

const ALGORITHM = 'aes-256-gcm';

// 12 bytes is the nonce size GCM is specified around. Longer nonces get hashed
// down internally, which buys nothing and costs interoperability.
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// version(1) || iv(12) || authTag(16) || ciphertext
const VERSION_LENGTH = 1;
const HEADER_LENGTH = VERSION_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;

const key = Buffer.from(config.ENCRYPTION_KEY, 'hex');

/**
 * Encrypt a face embedding for storage.
 *
 * GCM rather than CBC because it authenticates as well as encrypts. An
 * embedding is the thing identity decisions are made from, so silent
 * corruption — or a tampered record swapped in by someone with database
 * access — has to be detectable rather than merely unlikely. Decryption of a
 * modified ciphertext throws instead of returning plausible-looking garbage
 * that would then be matched against.
 *
 * The key version is stored in the payload so a rotation can re-encrypt
 * gradually rather than needing every record rewritten at once.
 */
export function encryptEmbedding(plaintext) {
  if (!Buffer.isBuffer(plaintext) || plaintext.length === 0) {
    throw new TypeError('encryptEmbedding expects a non-empty Buffer');
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([
    Buffer.from([config.ENCRYPTION_KEY_VERSION]),
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]);
}

/**
 * Coerce whatever the storage layer hands back into a Buffer.
 *
 * A `.lean()` query returns BSON `Binary` rather than a Node Buffer, and a
 * hydrated document returns a Buffer subclass — so the same stored field
 * arrives in different shapes depending on how it was read. Normalising here,
 * at the single point that reads stored bytes, keeps every caller from having
 * to know that.
 */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  // BSON Binary keeps the bytes on `.buffer`.
  if (value?.buffer instanceof Uint8Array) return Buffer.from(value.buffer);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value?.value === 'function') return Buffer.from(value.value(true));
  return null;
}

/** Reverse of {@link encryptEmbedding}. Throws if the record was altered. */
export function decryptEmbedding(input) {
  const payload = toBuffer(input);

  if (payload === null || payload.length <= HEADER_LENGTH) {
    throw new TypeError('decryptEmbedding expects a Buffer holding a full record');
  }

  const version = payload[0];
  if (version !== config.ENCRYPTION_KEY_VERSION) {
    throw new Error(
      `Embedding was encrypted with key version ${version}, but version ` +
        `${config.ENCRYPTION_KEY_VERSION} is loaded. Keep the previous key ` +
        'available to read older records.',
    );
  }

  const iv = payload.subarray(VERSION_LENGTH, VERSION_LENGTH + IV_LENGTH);
  const authTag = payload.subarray(VERSION_LENGTH + IV_LENGTH, HEADER_LENGTH);
  const ciphertext = payload.subarray(HEADER_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Constant-time comparison, for anywhere a secret is checked against input.
 *
 * A plain `===` on strings leaks how many leading characters matched through
 * how long it took to fail, which is enough to recover a secret one character
 * at a time given enough attempts.
 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Comparing each against itself keeps the work constant.
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
