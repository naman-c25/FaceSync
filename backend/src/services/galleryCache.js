import { config } from '../config/index.js';

/**
 * The enrolled face signatures, held in memory instead of re-read every scan.
 *
 * Measured before building this: assembling the gallery for one verification
 * took 961ms, and 934ms of that was Atlas shipping 5.6MB of encrypted
 * embeddings across the network. Decryption was 21ms and serialising the
 * payload 6ms. The database round trip *was* the cost.
 *
 * What this deliberately does **not** do is cache the query. Narrowing reads
 * `lastSeenAt`, `knownMerchants` and `homeRegion`, and all three change as
 * people use the system — caching the result would mean serving a pool that
 * no longer reflects who is active. So the query still runs on every scan and
 * still decides membership; it just asks for ids rather than for six megabytes
 * of ciphertext. Only the embeddings, which do not change unless somebody
 * enrols or deletes, live here.
 *
 * That distinction is the whole safety argument. The gallery that comes out
 * holds the same users, in the same order, carrying the same 512 numbers as
 * before. Identification cannot tell the difference, which is the point:
 * accuracy and the anti-spoofing that runs before it are untouched.
 *
 * The stored value is base64 rather than raw bytes because that is the form
 * the ML service is sent, so a cache hit skips the encode too. Roughly 2.7KB
 * per user — about 11MB at two thousand users, and it scales linearly.
 *
 * A decrypted biometric template sitting in memory is a real cost and worth
 * naming: it was already decrypted on every request, so the exposure moves
 * from "for the length of a request" to "for the life of the process". That is
 * a deliberate trade, not an oversight.
 */
const embeddings = new Map();

// Records that could not be decrypted. Remembered so a broken row is not
// re-fetched and re-attempted on every scan, and so the reason survives to be
// reported the same way it was before.
const broken = new Map();

// Anything that edits users from outside this process -- the dedupe and
// benchmark-loading scripts -- cannot call `evict`. A ceiling on staleness
// covers them without needing a restart. Everything the API itself does
// invalidates precisely and does not wait for this.
let filledAt = 0;

function expired() {
  return Date.now() - filledAt > config.GALLERY_CACHE_TTL_MS;
}

/** Drop everything. Cheap: the next scan refills from one query. */
export function clear() {
  embeddings.clear();
  broken.clear();
  filledAt = 0;
}

/**
 * Forget one user, because their signature changed or they deleted it.
 *
 * Called on every path that writes an embedding. A deleted face that stayed
 * cached would remain matchable, which would make the deletion a lie.
 */
export function evict(userId) {
  const key = String(userId);
  embeddings.delete(key);
  broken.delete(key);
}

/** Which of these ids are not held yet, and so must be read from the database. */
export function missing(ids) {
  if (expired()) clear();
  return ids.filter((id) => !embeddings.has(id) && !broken.has(id));
}

/** Store a freshly decrypted signature. */
export function put(userId, embeddingB64) {
  embeddings.set(String(userId), embeddingB64);
  if (filledAt === 0) filledAt = Date.now();
}

/** Remember that this record cannot be read, and why. */
export function putBroken(userId, reason) {
  broken.set(String(userId), reason);
  if (filledAt === 0) filledAt = Date.now();
}

export function get(userId) {
  return embeddings.get(String(userId));
}

export function reasonBroken(userId) {
  return broken.get(String(userId));
}

/** For /health and tests. */
export function stats() {
  return {
    held: embeddings.size,
    unreadable: broken.size,
    ageMs: filledAt === 0 ? null : Date.now() - filledAt,
  };
}
